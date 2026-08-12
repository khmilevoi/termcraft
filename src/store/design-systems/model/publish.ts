import path from "node:path";

import type { DesignSystemRef } from "entities/design-system-ref";
import { log } from "infrastructure/debug-log";

import type { LocalDesignSystemSourceDeps, LocalPackage, PublishReceipt } from "../types";
import { designSystemContentHash, normalizePackageRelPath } from "./content-hash";
import type { SourceError } from "./errors";
import {
  DesignSystemPackageInvalidError,
  DesignSystemPackageTooLargeError,
  DesignSystemSourceIoError,
} from "./errors";
import { LOCAL_SOURCE_ID, MANIFEST_FILENAME, localLibraryDir, localSystemDir } from "./layout";
import { readDesignSystemSummary } from "./summary";

/**
 * Where a system being REPLACED is parked while the replacement moves in (P3 minor M11). A
 * `.`-prefixed name can never be mistaken for a system — `parseDesignSystemId` refuses a leading
 * `.`, so `list` skips it — which is the same property `.publishing-` already relies on.
 */
function retiringDir(userStateRoot: string, systemId: string): string {
  return path.join(localLibraryDir(userStateRoot), `.retiring-${systemId}`);
}

/**
 * `DesignSystemSource.publish(pkg)` for the local library (design §8.1: "a local directory
 * publishes by copying").
 *
 * STAGE, SWAP, THEN DISCARD. Files land in `local/.publishing-<systemId>/`; the existing system is
 * renamed aside to `local/.retiring-<systemId>/`; the staging directory is renamed into place; the
 * retired copy is removed. A crash at any point leaves either the old system or the new one whole,
 * and a crash between the two renames is repaired by the next publish's pre-flight sweep. This is
 * NOT a transaction — the user's own library is deliberately outside the store's transaction
 * engine, and the transactional path is P10's INSTALL (§8.3), which is the one that touches a
 * design tree — but it never destroys data it cannot recover.
 *
 * A `.`-prefixed staging or retiring directory can never be mistaken for a system:
 * `parseDesignSystemId` refuses a leading `.`, so `list` skips it and a crashed publish leaves
 * litter, not a phantom.
 */
export async function publishLocalPackage(
  deps: LocalDesignSystemSourceDeps,
  pkg: LocalPackage,
): Promise<SourceError | PublishReceipt> {
  const manifest = pkg.files.find(
    (file) => normalizePackageRelPath(file.relPath) === MANIFEST_FILENAME,
  );
  if (manifest === undefined) {
    return new DesignSystemPackageInvalidError({
      path: `${pkg.systemId}@${pkg.version}`,
      reason: `package has no ${MANIFEST_FILENAME}`,
    });
  }

  const summary = readDesignSystemSummary(
    manifest.bytes,
    `${pkg.systemId}@${pkg.version}/${MANIFEST_FILENAME}`,
  );
  if (summary instanceof Error) return summary;

  if (summary.id !== pkg.systemId || summary.version !== pkg.version) {
    return new DesignSystemPackageInvalidError({
      path: `${pkg.systemId}@${pkg.version}`,
      reason: `manifest declares ${summary.id}@${summary.version}`,
    });
  }

  // Normalized once here so the escape check, the admission call, and the write all agree.
  const normalized = pkg.files.map((file) => ({
    relPath: normalizePackageRelPath(file.relPath),
    bytes: file.bytes,
  }));

  // Fresh budget for THIS publish (I1 fix) — one instance for the whole file loop below, so its
  // aggregate counters track only this package, but never carried into a LATER publish/fetch:
  // `deps.admission` is a factory precisely so a second call in the same session never inherits
  // this one's counters.
  const admission = deps.admission();
  for (const file of normalized) {
    const segments = file.relPath.split("/");
    if (
      file.relPath === "" ||
      segments.includes("..") ||
      segments.includes(".") ||
      segments.includes("")
    ) {
      return new DesignSystemPackageInvalidError({
        path: file.relPath,
        reason: "package paths must stay inside the package root",
      });
    }
    const admitted = admission.admitFile({
      relPath: file.relPath,
      declaredSize: file.bytes.byteLength,
      depth: segments.length,
    });
    if (admitted instanceof Error) {
      return new DesignSystemPackageTooLargeError({
        path: file.relPath,
        detail: admitted.message,
        cause: admitted,
      });
    }
    const observed = admission.observeBytes({
      relPath: file.relPath,
      bytesRead: file.bytes.byteLength,
    });
    if (observed instanceof Error) {
      return new DesignSystemPackageTooLargeError({
        path: file.relPath,
        detail: observed.message,
        cause: observed,
      });
    }
  }

  const contentHash = designSystemContentHash(normalized);
  if (contentHash instanceof Error) return contentHash;

  const target = localSystemDir(deps.userStateRoot, pkg.systemId);
  const staging = path.join(localLibraryDir(deps.userStateRoot), `.publishing-${pkg.systemId}`);
  const retiring = retiringDir(deps.userStateRoot, pkg.systemId);

  // PRE-FLIGHT SWEEP (M11). A crash between the two renames leaves the target gone and the old
  // system parked at `.retiring-<id>`. Restoring it here makes that state transient rather than
  // permanent — and restoring BEFORE anything is written means a publish that then fails leaves
  // the library exactly as it found it. If the target is already present, the parked directory is
  // stray litter from an earlier publish whose final discard (step 3) failed; clearing it now
  // keeps it from colliding with THIS publish's own step (1) below.
  const stranded = deps.fs.listDir(retiring);
  if (stranded instanceof Error) return stranded;
  if (stranded !== null) {
    const targetBefore = deps.fs.listDir(target);
    if (targetBefore instanceof Error) return targetBefore;
    if (targetBefore === null) {
      const restored = deps.fs.renameDir(retiring, target);
      if (restored instanceof Error) return restored;
    } else {
      const clearedStray = deps.fs.removeDir(retiring);
      if (clearedStray instanceof Error) return clearedStray;
    }
  }

  const cleared = deps.fs.removeDir(staging);
  if (cleared instanceof Error) return cleared;

  for (const file of normalized) {
    const absPath = path.join(staging, ...file.relPath.split("/"));
    const created = deps.fs.mkdirAll(path.dirname(absPath));
    if (created instanceof Error) return created;
    const wrote = deps.fs.durableWrite(absPath, file.bytes);
    if (wrote instanceof Error) {
      return new DesignSystemSourceIoError({
        operation: "write",
        path: absPath,
        detail: wrote.message,
        cause: wrote,
      });
    }
  }

  // THREE-STEP SWAP (P3 minor M11). The old system is renamed ASIDE and only removed once the
  // replacement is in place, so no crash point deletes live data with nothing left to recover:
  //   crash after (1) -> `.retiring-<id>` holds the old bytes and the sweep above restores them;
  //   crash after (2) -> the new system is already installed and `.retiring-<id>` is litter.
  // The window is not zero — no filesystem primitive available here makes it zero, which is why
  // the local library is deliberately outside the transaction engine, and P10's INSTALL (§8.3) is
  // the transactional path that touches a design tree instead. What changed is that DATA IS NEVER
  // DESTROYED.
  const targetPresent = deps.fs.listDir(target);
  if (targetPresent instanceof Error) return targetPresent;
  if (targetPresent !== null) {
    const parked = deps.fs.renameDir(target, retiring); // (1)
    if (parked instanceof Error) return parked;
  }

  const renamed = deps.fs.renameDir(staging, target); // (2)
  if (renamed instanceof Error) return renamed;

  const discarded = deps.fs.removeDir(retiring); // (3)
  if (discarded instanceof Error) {
    // Litter, not a fault: the publish succeeded and the next one clears it. Logged, never
    // swallowed (errore rule 21).
    log.warn("design-systems: could not remove the retired system directory:", discarded.message);
  }

  const ref: DesignSystemRef = {
    sourceId: LOCAL_SOURCE_ID,
    systemId: pkg.systemId,
    version: pkg.version,
  };
  return { ref, contentHash, publishedAt: deps.clock.now().toISOString() };
}
