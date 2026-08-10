/**
 * Everything that reads or writes `design/pages.json` — the manifest read, the transaction
 * operation that rewrites it, and the `DesignTreeStore` those two compose into.
 *
 * Split out of `factory.ts` (design-tree phase-1 closeout, Task 9): that file had reached ~1900
 * lines. `factory.ts` still calls back into this file in five places — the composition site
 * plus `readManifestFromDisk` (from `assertManifestNotDrifted`, `assertEntrySourceNotDrifted`)
 * and `buildPagesManifestOperation` (from `reorderPages`, `removePage`) — so the two files stay
 * genuinely coupled; this was never an extraction of something uncoupled. It moved because the
 * three functions are one unit — the manifest's whole on-disk lifecycle — and holding them
 * together in their own file is what keeps the CAS in `buildPagesManifestOperation` and the
 * read in `readManifestFromDisk` agreeing about what a manifest image is, independent of how
 * many call sites in `factory.ts` reach back in.
 */

import * as errore from "errore";

import {
  DESIGN_DIRNAME,
  PAGES_MANIFEST_RELPATH,
  decodePagesManifest,
  encodePagesManifest,
} from "entities/design-tree";
import type { PagesManifestInvalidError, PagesManifestV1 } from "entities/design-tree";
import { log } from "infrastructure/debug-log";
import { sha256Hex } from "store/jsonl";
import { FsAccessError, MAX_PATH_COMPONENTS, NAMESPACE_LIMITS, isNotFound } from "store/safe-fs";
import type { SafeFsError, SafeProjectFs } from "store/safe-fs";
import { designFilePath, observeFileImage } from "store/transaction";
import type { TransactionWrapperDeps } from "store/transaction";

import type { BuiltPageOperation, DesignTreeStore, Sha256Hex } from "../types";

/** `design/` nests deeper than its namespace's own ceiling — refused rather than walked forever (design §3.1's depth-8 budget, `store/safe-fs`'s `NAMESPACE_LIMITS["design-source"]`). */
export class DesignTreeTooDeepError extends errore.createTaggedError({
  name: "DesignTreeTooDeepError",
  message: "design/$relPath exceeds the design-source depth ceiling of $maxDepth",
}) {}

/** `design/pages.json` currently lists no entry for `pageSlug` — `DesignTreeStore.readSource`'s manifest lookup found nothing to resolve (never a slug-computed path guess, design §3, §7). */
export class PageEntryNotFoundError extends errore.createTaggedError({
  name: "PageEntryNotFoundError",
  message: "design/pages.json has no entry for page slug $pageSlug",
}) {}

/** The `design/pages.json` replace operation for a new manifest — the single writer of page order (`reorderPages`/`removePage`). */
function buildPagesManifestOperation(
  deps: TransactionWrapperDeps,
  next: PagesManifestV1,
): SafeFsError | BuiltPageOperation {
  const target = designFilePath(PAGES_MANIFEST_RELPATH);
  const oldImage = observeFileImage(deps.fs, target);
  if (oldImage instanceof Error) return oldImage;
  const bytes = new TextEncoder().encode(encodePagesManifest(next));
  const payloadId = deps.append.newPayloadId();
  return {
    operation: {
      index: 0,
      target,
      mode: "replace",
      oldImage,
      newImage: { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength },
      payloadId,
    },
    payload: [payloadId, bytes],
  };
}

/** Read `design/pages.json` straight off `safeFs`, decoded and validated (design §4). Shared by `readManifest`, `readSource`, and `listSlugs` — they are plain object-literal methods, not class methods, so calling one from another through `this` is not available. */
function readManifestFromDisk(
  safeFs: SafeProjectFs,
): SafeFsError | PagesManifestInvalidError | PagesManifestV1 {
  const file = safeFs.readFile(designFilePath(PAGES_MANIFEST_RELPATH));
  if (file instanceof Error) return file;
  return decodePagesManifest(new TextDecoder().decode(file));
}

function createDesignTreeStore(safeFs: SafeProjectFs): DesignTreeStore {
  return {
    /**
     * Resolves `pageSlug` through `design/pages.json`'s `entry` map — never a slug-computed
     * path (design §3, §7). `PageEntryNotFoundError` when the manifest lists no entry for
     * `pageSlug`; every other manifest/file read failure propagates as-is.
     */
    async readSource(pageSlug) {
      const manifest = readManifestFromDisk(safeFs);
      if (manifest instanceof Error) return manifest;
      const entry = manifest.pages.find((page) => page.slug === pageSlug);
      if (entry === undefined) return new PageEntryNotFoundError({ pageSlug });
      const bytes = safeFs.readFile(designFilePath(entry.entry));
      if (bytes instanceof Error) return bytes;
      return { bytes, sourceHash: sha256Hex(bytes) };
    },

    /**
     * Pre-plan contract kept verbatim: `[]` for a project with no `design/pages.json` yet
     * (created before its first turn — Task 16's own "tree-less project" territory,
     * red-debt.md), never an error — this method predates the design-tree plan and its own
     * "[] for none" contract must keep holding. `readManifest` below makes no such
     * allowance for that same missing-file case (deliberately, see its own comment): this is
     * a narrow, test-driven exception scoped to this one pre-existing convenience method,
     * not a general policy this task is deciding on Task 16's behalf.
     */
    async listSlugs() {
      const manifest = readManifestFromDisk(safeFs);
      if (manifest instanceof Error) {
        if (manifest instanceof FsAccessError && isNotFound(manifest)) return [];
        return manifest;
      }
      return manifest.pages.map((page) => page.slug);
    },

    async readTreeFile(relPath) {
      const bytes = safeFs.readFile(designFilePath(relPath));
      if (bytes instanceof Error) return bytes;
      return { bytes, sha256: sha256Hex(bytes) };
    },

    /**
     * Walk `design/` and return every file with its hash. The walk goes through `safeFs`, so
     * a symlink/junction/reparse point anywhere in the tree is rejected rather than followed
     * (design §6's "a specifier whose resolution passes through a symlink … is fatal" —
     * enforced here, at the one place tree-relative paths become real ones). Iterative with
     * an explicit depth guard rather than recursive, so a pathological tree cannot spin or
     * blow the stack; the guard is the namespace's own ceiling, not a second invented number.
     *
     * DIVERGENCE from the brief's own pseudocode (CLAUDE.md "edit the file that actually
     * declares it"): `SafeProjectFs` has no `readDir` method — `list(relDir)` is the real
     * name — and its `stat()` returns only `{size}`, never `isDirectory` (`checkManagedLeaf`
     * REJECTS a directory target outright, so `stat()` on one already fails). This walk
     * tells a file from a directory by trying `readFile` first — the common case, and a
     * success also hands back the bytes this method needs to hash anyway — and falling back
     * to `list` only when that fails; whichever call succeeds decides what the entry is, so
     * nothing here string-matches an error's free-text `reason`.
     */
    async listTree() {
      const maxDepth = NAMESPACE_LIMITS["design-source"].maxDepth ?? MAX_PATH_COMPONENTS;
      const files: { relPath: string; sha256: Sha256Hex; size: number }[] = [];
      const queue: { relPath: string; depth: number }[] = [{ relPath: "", depth: 1 }];

      while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined) break;
        if (current.depth > maxDepth)
          return new DesignTreeTooDeepError({ relPath: current.relPath, maxDepth });

        const dirRelPath =
          current.relPath === "" ? DESIGN_DIRNAME : `${DESIGN_DIRNAME}/${current.relPath}`;
        const names = safeFs.list(dirRelPath);
        if (names instanceof Error) {
          // An absent `design/` is an honest empty tree, not a failure: a project created
          // before its first turn may have no other file yet.
          if (names instanceof FsAccessError && isNotFound(names) && current.relPath === "")
            return [];
          return names;
        }

        for (const name of names) {
          const childRel = current.relPath === "" ? name : `${current.relPath}/${name}`;
          const childProjectRel = `${DESIGN_DIRNAME}/${childRel}`;

          const bytes = safeFs.readFile(childProjectRel);
          if (!(bytes instanceof Error)) {
            files.push({ relPath: childRel, sha256: sha256Hex(bytes), size: bytes.byteLength });
            continue;
          }

          const subNames = safeFs.list(childProjectRel);
          if (!(subNames instanceof Error)) {
            queue.push({ relPath: childRel, depth: current.depth + 1 });
            continue;
          }

          // Neither a readable leaf nor a directory — surface the leaf read's own rejection
          // (e.g. a reparse point, an oversized file): more specific than the directory
          // listing's own generic failure for the same path, which is LOGGED here rather
          // than silently discarded (errore rule 21: an error that is not propagated must
          // still be logged) even though it is not the value this method returns.
          log.warn(
            `store: listTree could not list ${childProjectRel} as a directory either:`,
            subNames.message,
          );
          return bytes;
        }
      }

      return files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    },

    async readManifest() {
      return readManifestFromDisk(safeFs);
    },
  };
}

export { createDesignTreeStore, readManifestFromDisk, buildPagesManifestOperation };
