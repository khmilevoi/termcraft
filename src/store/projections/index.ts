// The rebuildable local projections (storage-identity §7; projections-observability §4,
// §6, §10.2): the page-metadata cache, the current-diagnostics store, and the
// content-addressed export render cache. Every entry is written atomically
// (temp-write -> verify -> rename -> flush-dir, via `infrastructure/durability`), a
// missing/malformed/generation-stale entry is a MISS rather than an error, and none of
// these stores ever mutates portable project state. All three are classified local and
// excluded from Git elsewhere (`store/toml`'s generated `.gitignore`, the Git scope
// planner) — this module only guarantees it never writes a portable path itself.
export type {
  AbsPath,
  DiagnosticItem,
  DiagnosticRange,
  DiagnosticsEntry,
  DiagnosticsKey,
  DiagnosticsPinPredicate,
  ExportRenderKey,
  PageMetaEntry,
  PageMetaKey,
  ProjectionFsDeps,
  ProjectionsError,
  RenderEntry,
  RenderPinPredicate,
  Sha256Hex,
} from "./types";

export type { PageMetaCache, PageMetaCacheDeps } from "./model/page-meta-cache";
export {
  PAGE_META_CACHE_GENERATION,
  PageMetaCacheIoError,
  createPageMetaCache,
  nodePageMetaCacheFsDeps,
} from "./model/page-meta-cache";

export type { DiagnosticsStore, DiagnosticsStoreDeps } from "./model/diagnostics-store";
export {
  DIAGNOSTICS_DEFAULT_QUOTA_BYTES,
  DIAGNOSTICS_MAX_QUOTA_BYTES,
  DIAGNOSTICS_MIN_QUOTA_BYTES,
  DIAGNOSTICS_STORE_GENERATION,
  DiagnosticsStoreIoError,
  createDiagnosticsStore,
  nodeDiagnosticsStoreFsDeps,
} from "./model/diagnostics-store";

export type { RenderCache, RenderCacheDeps } from "./model/render-cache";
export {
  RENDER_CACHE_DEFAULT_QUOTA_BYTES,
  RENDER_CACHE_GENERATION,
  RENDER_CACHE_MAX_QUOTA_BYTES,
  RENDER_CACHE_MIN_QUOTA_BYTES,
  RenderCacheIoError,
  canonicalizeExportRenderKey,
  createRenderCache,
  nodeRenderCacheFsDeps,
} from "./model/render-cache";
