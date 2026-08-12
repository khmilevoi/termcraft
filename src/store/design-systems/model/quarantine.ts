import path from "node:path";

import * as errore from "errore";

import { log } from "infrastructure/debug-log";
import type { CandidateSnapshot, ManagedRoot } from "store/safe-fs";
import {
  nodeCandidateDeps,
  nodeSafeFsDeps,
  openManagedRoot,
  snapshotToCandidate,
} from "store/safe-fs";

import type { PackageFile, Sha256Hex } from "../types";
import { designSystemContentHash, normalizePackageRelPath } from "./content-hash";
import { designSystemsRoot } from "./layout";

/**
 * QUARANTINE (design §8.3). `fetch` returns bytes and writes nothing; this is where those bytes
 * are first written down, and it is deliberately NOT inside the project:
 * `{userStateRoot}/design-systems/quarantine/<installId>/`, beside `sandboxes/` and `trust/`. A
 * crash at any point before the install transaction's `intent.json` therefore leaves the project
 * byte-identical, and cleanup is a `removeTree` on a directory nothing else owns.
 *
 * THE `design/` PREFIX IS LOAD-BEARING. Files are staged at
 * `<installId>/staging/design/system/<packageRelPath>` so that
 * `classifyNamespace("workspace", …)` returns `design-source` — which is exactly the row §8.3
 * names (512 files, 64 MiB aggregate, depth 8, 2 MiB per file). No new namespace, no change to
 * `NAMESPACE_LIMITS`, and the limits that apply to an agent's turn workspace apply here verbatim
 * (D4).
 *
 * THE CANDIDATE IS WHERE THE LIMITS ACTUALLY BITE. `snapshotToCandidate` enumerates the whole
 * staging tree against the workspace root's limit budget and against the no-follow walk BEFORE
 * it creates the destination directory at all — so an oversized or over-numerous package is
 * refused with no candidate ever existing, which is §11's "a fetched package exceeding safe-fs
 * limits is rejected before it reaches the candidate", asserted rather than asserted-about.
 *
 * THE BYTES ARE READ BACK EXACTLY ONCE, out of the immutable candidate, and that one read feeds
 * both the Gate and the install transaction (D5). Reading the staging tree for the Gate and the
 * candidate for the commit — or reading the candidate twice — would be a TOCTOU window on
 * foreign input for no benefit.
 */
export const QUARANTINE_DIRNAME = "quarantine";

/** Inside the staging tree, the package sits where it will sit in the project. */
const STAGED_PACKAGE_PREFIX = "design/system";

export class QuarantineFailedError extends errore.createTaggedError({
  name: "QuarantineFailedError",
  message: "quarantine $stage failed for $path: $reason",
}) {}

export interface QuarantineFsDeps {
  readonly mkdirAll: (absDir: string) => Error | undefined;
  readonly mkdirNew: (absDir: string) => Error | undefined;
  readonly durableWrite: (absPath: string, bytes: Uint8Array) => Error | undefined;
  readonly readFile: (absPath: string) => Uint8Array | Error;
  readonly removeTree: (absPath: string) => void;
  readonly openRoot: (absDir: string) => ManagedRoot | Error;
  readonly snapshot: (input: {
    readonly source: ManagedRoot;
    readonly destRoot: string;
  }) => Error | CandidateSnapshot;
}

export interface QuarantineDeps {
  readonly userStateRoot: string;
  readonly fs: QuarantineFsDeps;
}

export interface AdmittedPackage {
  readonly installId: string;
  readonly quarantineRoot: string;
  readonly contentHash: Sha256Hex;
  /** PACKAGE-relative, read once out of the immutable candidate. */
  readonly files: readonly PackageFile[];
  readonly totalBytes: number;
}

export function quarantineRootDir(userStateRoot: string): string {
  return path.join(designSystemsRoot(userStateRoot), QUARANTINE_DIRNAME);
}

export function quarantineInstallDir(userStateRoot: string, installId: string): string {
  return path.join(quarantineRootDir(userStateRoot), installId);
}

/** The real Node wiring, built from `store/safe-fs`'s own primitives so no second fs vocabulary appears. */
export function nodeQuarantineFsDeps(): QuarantineFsDeps {
  const candidateDeps = nodeCandidateDeps();
  const noFollowDeps = nodeSafeFsDeps();
  return {
    mkdirAll: (absDir) => candidateDeps.mkdirAll(absDir),
    mkdirNew: (absDir) => candidateDeps.mkdirNew(absDir),
    durableWrite: (absPath, bytes) => {
      const sink = candidateDeps.createNewSink(absPath);
      if (sink instanceof Error) return sink;
      const wrote = sink.write(bytes);
      if (wrote instanceof Error) {
        const closed = sink.close();
        if (closed instanceof Error)
          log.warn("design-systems: quarantine sink close failed:", closed.message);
        return wrote;
      }
      return sink.close();
    },
    readFile: (absPath) => {
      const handle = candidateDeps.openSource(absPath);
      if (handle instanceof Error) return handle;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const chunk = handle.read();
        if (chunk instanceof Error) {
          handle.close();
          return chunk;
        }
        if (chunk === null) break;
        chunks.push(chunk);
      }
      handle.close();
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    },
    removeTree: (absPath) => candidateDeps.removeTree(absPath),
    openRoot: (absDir) => openManagedRoot({ kind: "workspace", path: absDir, deps: noFollowDeps }),
    snapshot: (input) =>
      snapshotToCandidate({ source: input.source, destRoot: input.destRoot, deps: candidateDeps }),
  };
}

/** Reject a package-relative path that would escape the package root once joined. */
function isEscapingPath(relPath: string): boolean {
  const segments = relPath.split("/");
  return (
    relPath === "" || segments.includes("..") || segments.includes(".") || segments.includes("")
  );
}

export function admitPackageThroughQuarantine(
  deps: QuarantineDeps,
  input: { readonly installId: string; readonly files: readonly PackageFile[] },
): QuarantineFailedError | Error | AdmittedPackage {
  const installDir = quarantineInstallDir(deps.userStateRoot, input.installId);
  const stagingDir = path.join(installDir, "staging");
  const candidateDir = path.join(installDir, "candidate");

  const parent = deps.fs.mkdirAll(quarantineRootDir(deps.userStateRoot));
  if (parent instanceof Error)
    return new QuarantineFailedError({
      stage: "mkdir",
      path: installDir,
      reason: parent.message,
      cause: parent,
    });

  // CREATE-NEW, never reuse: a collision is a fault, exactly as it is in `store/sandbox`'s
  // `createTurnWorkspace`. From here on this directory is owned, so every failure discards it.
  const created = deps.fs.mkdirNew(installDir);
  if (created instanceof Error)
    return new QuarantineFailedError({
      stage: "create",
      path: installDir,
      reason: created.message,
      cause: created,
    });

  const discard = () => deps.fs.removeTree(installDir);

  for (const file of input.files) {
    const relPath = normalizePackageRelPath(file.relPath);
    if (isEscapingPath(relPath)) {
      discard();
      return new QuarantineFailedError({
        stage: "stage",
        path: file.relPath,
        reason: "package paths must stay inside the package root",
      });
    }
    const segments = relPath.split("/");
    const absPath = path.join(stagingDir, STAGED_PACKAGE_PREFIX, ...segments);
    const dir = deps.fs.mkdirAll(path.dirname(absPath));
    if (dir instanceof Error) {
      discard();
      return new QuarantineFailedError({
        stage: "stage",
        path: absPath,
        reason: dir.message,
        cause: dir,
      });
    }
    const wrote = deps.fs.durableWrite(absPath, file.bytes);
    if (wrote instanceof Error) {
      discard();
      return new QuarantineFailedError({
        stage: "stage",
        path: absPath,
        reason: wrote.message,
        cause: wrote,
      });
    }
  }

  const root = deps.fs.openRoot(stagingDir);
  if (root instanceof Error) {
    discard();
    return root;
  }

  // THE LIMITS. `snapshotToCandidate` enumerates and admits every entry BEFORE creating
  // `candidateDir`, so a refusal here leaves no candidate at all.
  const snapshot = deps.fs.snapshot({ source: root, destRoot: candidateDir });
  if (snapshot instanceof Error) {
    discard();
    return snapshot;
  }

  const files: PackageFile[] = [];
  for (const entry of snapshot.files) {
    const packageRelPath = entry.relPath.startsWith(`${STAGED_PACKAGE_PREFIX}/`)
      ? entry.relPath.slice(STAGED_PACKAGE_PREFIX.length + 1)
      : null;
    if (packageRelPath === null) {
      discard();
      return new QuarantineFailedError({
        stage: "read-back",
        path: entry.relPath,
        reason: `candidate holds a file outside ${STAGED_PACKAGE_PREFIX}/`,
      });
    }
    const bytes = deps.fs.readFile(path.join(snapshot.root, ...entry.relPath.split("/")));
    if (bytes instanceof Error) {
      discard();
      return new QuarantineFailedError({
        stage: "read-back",
        path: entry.relPath,
        reason: bytes.message,
        cause: bytes,
      });
    }
    files.push({ relPath: packageRelPath, bytes });
  }

  const contentHash = designSystemContentHash(files);
  if (contentHash instanceof Error) {
    discard();
    return contentHash;
  }

  return {
    installId: input.installId,
    quarantineRoot: installDir,
    contentHash,
    files,
    totalBytes: snapshot.totalBytes,
  };
}

/** Best-effort and idempotent: quarantine is disposable by construction, so a failure to clear it is litter, not a fault. */
export function discardQuarantine(deps: QuarantineDeps, installId: string): void {
  deps.fs.removeTree(quarantineInstallDir(deps.userStateRoot, installId));
  log.info("design-systems: discarded quarantine", installId);
}
