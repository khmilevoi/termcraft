import type { Sha256Hex } from "core/protocol"
import type { PageSlug, Size } from "entities/page"

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
  readonly pageSlug: PageSlug
  readonly sourcePath: string
  /** Project page order (manifest order) — the primary publish-order key (§11.4/§12.5). */
  readonly manifestIndex: number
  readonly minSize: Size
  readonly theme: string
  readonly kitApiVersion: number
}

/** One page's captured snapshot: caller-resolved identity/settings plus a source read taken live, under the permit. */
export interface ExportPageSnapshotV1 extends ExportPageInputV1 {
  readonly sourceHash: Sha256Hex
  readonly bytes: Uint8Array
}

/**
 * The ONE immutable value §12.5 requires: "the exact ordered page list, source
 * bytes/hashes, and resolved settings" captured together while one short `ProjectWritePermit`
 * is held, released immediately after (`model/snapshot.ts`).
 */
export interface ExportSnapshotV1 {
  readonly pages: readonly ExportPageSnapshotV1[]
  /** RFC 3339 UTC — when this snapshot was captured (injected clock, never `Date.now()`). */
  readonly capturedAt: string
}
