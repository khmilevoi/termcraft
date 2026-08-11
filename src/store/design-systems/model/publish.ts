import path from "node:path";

import type { DesignSystemRef } from "entities/design-system-ref";

import type { LocalDesignSystemSourceDeps, LocalPackage, PublishReceipt } from "../types";
import { designSystemContentHash, normalizePackageRelPath } from "./content-hash";
import { DesignSystemPackageInvalidError, DesignSystemPackageTooLargeError } from "./errors";
import { LOCAL_SOURCE_ID, MANIFEST_FILENAME, localLibraryDir, localSystemDir } from "./layout";
import { readDesignSystemSummary } from "./summary";

/**
 * `DesignSystemSource.publish(pkg)` for the local library (design §8.1: "a local directory
 * publishes by copying").
 *
 * STAGE, THEN SWAP. Files land in `local/.publishing-<systemId>/`, the existing target is
 * removed, and the staging directory is renamed into place — a same-volume directory rename,
 * the closest thing to atomic available at this layer. THE WINDOW BETWEEN REMOVE AND RENAME IS
 * REAL and is stated rather than hidden: this target is the USER'S OWN LIBRARY, not a project,
 * so it is deliberately outside the store's transaction engine. The transactional path is
 * P10's INSTALL (§8.3), which is the one that touches a design tree.
 *
 * A `.`-prefixed staging directory can never be mistaken for a system: `parseDesignSystemId`
 * refuses a leading `.`, so `list` skips it and a crashed publish leaves litter, not a phantom.
 */
export async function publishLocalPackage(
  deps: LocalDesignSystemSourceDeps,
  pkg: LocalPackage,
): Promise<Error | PublishReceipt> {
  const manifest = pkg.files.find(
    (file) => normalizePackageRelPath(file.relPath) === MANIFEST_FILENAME,
  );
  if (manifest === undefined) {
    return new DesignSystemPackageInvalidError({
      path: `${pkg.systemId}@${pkg.version}`,
      reason: `package has no ${MANIFEST_FILENAME}`,
    });
  }

  const summary = readDesignSystemSummary(manifest.bytes, MANIFEST_FILENAME);
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

  for (const file of normalized) {
    const segments = file.relPath.split("/");
    if (file.relPath === "" || segments.includes("..") || segments.includes(".")) {
      return new DesignSystemPackageInvalidError({
        path: file.relPath,
        reason: "package paths must stay inside the package root",
      });
    }
    const admitted = deps.admission.admitFile({
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
    const observed = deps.admission.observeBytes({
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

  const cleared = deps.fs.removeDir(staging);
  if (cleared instanceof Error) return cleared;

  for (const file of normalized) {
    const absPath = path.join(staging, ...file.relPath.split("/"));
    const created = deps.fs.mkdirAll(path.dirname(absPath));
    if (created instanceof Error) return created;
    const wrote = deps.fs.durableWrite(absPath, file.bytes);
    if (wrote instanceof Error) return wrote;
  }

  const removed = deps.fs.removeDir(target);
  if (removed instanceof Error) return removed;

  const renamed = deps.fs.renameDir(staging, target);
  if (renamed instanceof Error) return renamed;

  const ref: DesignSystemRef = {
    sourceId: LOCAL_SOURCE_ID,
    systemId: pkg.systemId,
    version: pkg.version,
  };
  return { ref, contentHash, publishedAt: deps.clock.now().toISOString() };
}
