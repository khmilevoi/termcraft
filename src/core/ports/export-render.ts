import type { FailureDtoV1, Sha256Hex } from "core/protocol";
import type { PageSlug, Size } from "entities/page";

/**
 * `ExportRenderPort`: one bounded render task plus the pool-shape facts Export's
 * orchestration needs to size its own scheduling (projections-observability §10.1, §11.4),
 * narrowed from `host/supervisor/types.ts`'s real `ExportPool`/`OneShotResult`/
 * `RuntimeDeclarationBundleV1` per decision C1. Only rendering is in scope here — package
 * assembly and the publish transaction are a later slice's (6G) job, per this file's task
 * brief ("renderOne(task), pool bounds, runtime declaration bundle" only).
 *
 * `RuntimeDeclarationBundleV1` is redrawn locally rather than imported from
 * `host/protocol/types.ts` (which `core` may not import, even type-only, per this slice's
 * structural rule) — it is the same public runtime-declaration shape host-supervision §5.1
 * fixes, restated here as a core-owned DTO.
 */

export interface RuntimeDeclarationBundleV1 {
  readonly module: "@termcraft/runtime";
  readonly currentKitApiVersion: number;
  readonly supportedKitApiVersions: readonly number[];
  readonly publicCapabilityIds: readonly string[];
}

/** One export task: a captured source at one requested size, ordered by manifest then (w,h) (§11.4). */
export interface ExportRenderTaskV1 {
  readonly pageSlug: PageSlug;
  readonly sourcePath: string;
  readonly sourceHash: Sha256Hex;
  readonly kitApiVersion: number;
  readonly size: Size;
  readonly theme: string;
  /** Project page order (manifest order) — the primary publish-order key (§11.4). */
  readonly manifestIndex: number;
}

/** One task's rendered payloads — opaque bytes, mirroring `projections.ts`'s `RenderEntryV1`. */
export interface ExportRenderResultV1 {
  readonly manifestIndex: number;
  readonly styledFrame: Uint8Array;
  readonly textFrame: Uint8Array;
  readonly layout: Uint8Array;
}

/** The bounded worker-pool shape (§11.4): `min(4, max(1, floor(cpu/2)))` by default, 1-8 machine-local override, ready queue at most twice the worker count. */
export interface ExportRenderPoolBoundsV1 {
  readonly minWorkers: number;
  readonly maxWorkers: number;
  readonly readyQueueMultiplier: number;
}

export interface ExportRenderPort {
  readonly poolBounds: ExportRenderPoolBoundsV1;
  readonly runtimeDeclaration: RuntimeDeclarationBundleV1;
  /** One bounded render, pool-scheduled by the adapter; results still assemble in manifest/(w,h) order at the caller, never completion order (§11.4). */
  renderOne(task: ExportRenderTaskV1): Promise<FailureDtoV1 | ExportRenderResultV1>;
}
