import type { Sha256Hex } from "core/protocol";
import type { DesignFileEntryV1 } from "entities/design-tree";
import type { PageSlug, Size } from "entities/page";

/**
 * `core/export`'s shared vocabulary (kernel-command-contract §7.5, §12.5, §13.4).
 *
 * `ExportPageInputV1` mirrors `core/ports/staging.ts`'s `StagingPageSourceV1` doc exactly:
 * "already resolved to a readable source path by the caller." Export never derives
 * `sourcePath`, `theme`, `minSize`, or `kitApiVersion` itself — those are the page's own
 * static `meta` facts, already Gate-resolved once by the last successful turn; this module
 * only re-reads bytes/hash LIVE, under the short permit, to prove nothing drifted since.
 */
export interface ExportPageInputV1 {
  readonly pageSlug: PageSlug;
  /** The ABSOLUTE `…/design` directory this page renders from (task 15, design §9.2). */
  readonly treeRoot: string;
  /** TREE-relative — the `entry` `design/pages.json` bound to `pageSlug`. */
  readonly entryRelPath: string;
  /** The tree revision's `(relPath, sha256)` inventory the render's mount verifies against. */
  readonly expectedFiles: readonly DesignFileEntryV1[];
  /** Project page order (manifest order) — the primary publish-order key (§11.4/§12.5). */
  readonly manifestIndex: number;
  readonly minSize: Size;
  readonly theme: string;
  readonly kitApiVersion: number;
  /**
   * THE RENDER-CACHE KEY COMPONENT (design-tree phase 2 Task 8; design §7's consumer table) —
   * `CanonicalTreeIndexV1.closureHashOf(pageSlug)` over the SAME tree read that resolved
   * `expectedFiles` above, and that pairing is the point: a render's cache identity and the
   * inventory its mount verifies against then describe one revision, never two. `null` is a
   * FORCED MISS, honestly propagated — "the pass could not prove this page's closure", never
   * "unchanged" — and `render-jobs.ts` renders fresh without touching the cache at all.
   *
   * DELIBERATELY ON THE *INPUT*, NOT COMPUTED INSIDE `model/snapshot.ts`. `snapshot.ts` holds
   * one short `ProjectWritePermit` and has no `GateRunner`, so computing a closure there would
   * mean a THIRD whole-tree `tsc` pass on the export path, run under the write lock, against a
   * tree read a second time — and a closure hash folded from that second read could disagree
   * with the `expectedFiles` inventory taken from the first, which is exactly the stale-key
   * class of bug this task exists to close. Same rule as every other field here: caller-
   * resolved once, then `snapshot.ts` re-reads only the entry's bytes/hash live to prove
   * nothing drifted.
   */
  readonly closureHash: Sha256Hex | null;
}

/**
 * One page's captured snapshot: caller-resolved identity/settings (including
 * {@link ExportPageInputV1.closureHash}, carried through unchanged) plus a source read taken
 * live, under the permit.
 *
 * `sourceHash` is the ENTRY FILE'S OWN hash and stays that: it is what `publish.ts` compares to
 * detect that the entry's bytes drifted since capture, and what `ExportRenderTaskV1.sourceHash`
 * carries as the mounted incarnation's identity. It is NOT the render cache's key — see
 * `closureHash` above.
 */
export interface ExportPageSnapshotV1 extends ExportPageInputV1 {
  readonly sourceHash: Sha256Hex;
  readonly bytes: Uint8Array;
}

/** One canonical design-tree file captured verbatim: its TREE-relative path and its exact bytes. */
export interface ExportTreeFileV1 {
  readonly relPath: string;
  readonly bytes: Uint8Array;
}

/**
 * One page's transitive file set as the export package records it (design §7, §11) — the
 * closure `GateRunner.runTree` resolved over the very bytes this snapshot captured.
 * Paths are TREE-relative here; `package.ts` is what prefixes them with `design/` on the way
 * into the package, so a reader of the package never has to know this convention exists.
 */
export interface ExportClosureV1 {
  readonly pageSlug: PageSlug;
  readonly entry: string;
  readonly files: readonly string[];
}

/**
 * The ONE immutable value §12.5 requires: "the exact ordered page list, source
 * bytes/hashes, and resolved settings" captured together while one short `ProjectWritePermit`
 * is held, released immediately after (`model/snapshot.ts`).
 *
 * `tree` is the WHOLE canonical `design/` tree, captured in the same window (design §11: an
 * export ships `design/**`). It is not derivable from `pages` — a shared module no page's
 * entry names is still part of what the design is, and it is exactly what the entries import.
 */
export interface ExportSnapshotV1 {
  readonly pages: readonly ExportPageSnapshotV1[];
  readonly tree: readonly ExportTreeFileV1[];
  /** RFC 3339 UTC — when this snapshot was captured (injected clock, never `Date.now()`). */
  readonly capturedAt: string;
}
