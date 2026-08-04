import type { DiagnosticDtoV1, FailureDtoV1, Sha256Hex } from "core/protocol";
import type { PageMeta } from "entities/page";

/**
 * Three narrow rebuildable-projection caches (projections-observability §4, §6, §10.2),
 * split exactly as `store/projections` already splits them internally
 * (`PageMetaCache`/`DiagnosticsStore`/`RenderCache`, each independently quota-managed) —
 * `store/index.ts`'s own `ProjectionStore` divergence note explains why: each store owns
 * its own quota/generation/eviction policy, so one flat interface would blur three
 * independent capabilities into one. A missing/malformed/generation-stale entry is a MISS
 * (`null`), never an error — only a real I/O fault surfaces as `FailureDtoV1`.
 *
 * `DiagnosticsCache` stores `DiagnosticDtoV1` (`core/protocol`'s OWN wire DTO) rather than
 * a separate store-shaped `DiagnosticItem` — the cache holds exactly what the Kernel already
 * emits on `diagnostics.changed`, so no translation layer sits between this port and that
 * event. `RenderCache` has no DTO equivalent (frames are a host-owned wire format `store`
 * may not import, code-structure §6) — its three payloads stay opaque bytes, exactly as
 * `store/projections`'s real `RenderEntry` already declares them.
 */

// ---- page-meta cache (storage-identity §7) ---------------------------------------

/**
 * RE-KEYED FROM `sourceHash` TO `closureHash` (design-tree phase 2 Task 6): mirrors
 * `store/projections/model/page-meta-cache.ts`'s own `PageMetaKey` field-for-field — see that
 * file's header for the honest accounting of what the re-key buys (vocabulary consistency
 * across design §7's whole consumer table) and does not buy (no correctness fix for `meta`
 * extraction itself, which stays strictly literal). `closureHash` is always a real, non-null
 * `Sha256Hex`: `core/kernel/handlers/preview-export.ts`'s `resolvePageMeta` skips this cache
 * entirely — no `get`, no `put` — when the tree index's `closureHashOf` returns `null`, so no
 * caller may construct a `PageMetaKeyV1` from an unprovable closure.
 */
export interface PageMetaKeyV1 {
  readonly pageSlug: string;
  readonly closureHash: Sha256Hex;
  readonly extractorVersion: number;
}

export interface PageMetaEntryV1 {
  readonly key: PageMetaKeyV1;
  readonly meta: PageMeta;
}

export interface PageMetaCache {
  get(key: PageMetaKeyV1): Promise<FailureDtoV1 | PageMetaEntryV1 | null>;
  put(entry: PageMetaEntryV1): Promise<FailureDtoV1 | undefined>;
}

// ---- diagnostics cache (projections §6) -------------------------------------------

/**
 * RE-KEYED FROM `sourceHash` TO `closureHash` (design-tree phase 2 Task 7): mirrors
 * `store/projections/model/diagnostics-store.ts`'s own `DiagnosticsKey` field-for-field —
 * see that file's header for the honest accounting. UNLIKE {@link PageMetaKeyV1}'s Task 6
 * re-key, this cache has NO PRODUCTION CALLER TODAY (wired at the composition root, never
 * read or written outside its own tests) — this re-key buys correctness ahead of a future
 * caller, not a fix for a live invalidation defect.
 */
export interface DiagnosticsKeyV1 {
  readonly pageSlug: string;
  readonly closureHash: Sha256Hex;
  readonly kitApiVersion: number;
}

export interface DiagnosticsEntryV1 {
  readonly key: DiagnosticsKeyV1;
  readonly schemaVersion: number;
  readonly provenance: "gate" | "host";
  readonly observedAt: string; // RFC 3339
  readonly diagnostics: readonly DiagnosticDtoV1[];
}

export interface DiagnosticsCache {
  get(key: DiagnosticsKeyV1): Promise<FailureDtoV1 | DiagnosticsEntryV1 | null>;
  put(entry: DiagnosticsEntryV1): Promise<FailureDtoV1 | undefined>;
}

// ---- render cache (projections §10.2) ----------------------------------------------

/**
 * The exact §10.2 logical key. `rendererVersion` is the known divergence this phase must
 * introduce (plan §5: "defined nowhere and must be introduced by this phase") — a render
 * cache key component with no prior owner until now.
 */
export interface ExportRenderKeyV1 {
  readonly sourceHash: Sha256Hex;
  readonly kitApiVersion: number;
  readonly rendererVersion: string;
  readonly size: Readonly<{ width: number; height: number }>;
  readonly theme: string;
  readonly flags: Readonly<Record<string, boolean | number | string>>;
}

/** One immutable render: styled/text frame, resolved layout tree, opaque bytes (§10.2). */
export interface RenderEntryV1 {
  readonly key: ExportRenderKeyV1;
  readonly styledFrame: Uint8Array;
  readonly textFrame: Uint8Array;
  readonly layout: Uint8Array;
}

export interface RenderCache {
  get(key: ExportRenderKeyV1): Promise<FailureDtoV1 | RenderEntryV1 | null>;
  put(entry: RenderEntryV1): Promise<FailureDtoV1 | undefined>;
}
