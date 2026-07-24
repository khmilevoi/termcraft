export type {
  HostMode,
  HostSessionIdentity,
  HostSessionSpec,
  InteractionMode,
  PreviewFrame,
  PreviewIdentity,
  Size,
  TerminalCapabilities,
} from "./types";

// ---- adapters (adapter-ring plan, Tasks 5-6): the production `core/ports` implementations
// this module owns, plus (M4) `host`'s implementation of gate's own `SmokeRenderer` port.
// See `docs/architecture/code-structure.md` §7/§11 for the module DAG these wrap into —
// `core/ports/*` is imported type-only, never the reverse.
export { createHostSupervisorAdapter } from "./adapters/host-supervisor";
export { createExportRenderAdapter } from "./adapters/export-render";
export type { ExportRenderAdapterDeps } from "./adapters/export-render";
export { createSmokeRendererAdapter } from "./adapters/smoke-renderer";
export type { SmokeRendererAdapterDeps } from "./adapters/smoke-renderer";
