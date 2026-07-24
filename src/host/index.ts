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

// ---- adapters (adapter-ring plan, Task 5): the production `core/ports` implementations
// this module owns. See `docs/architecture/code-structure.md` §7/§11 for the module DAG
// these wrap into — `core/ports/*` is imported type-only, never the reverse.
export { createHostSupervisorAdapter } from "./adapters/host-supervisor";
export { createExportRenderAdapter } from "./adapters/export-render";
export type { ExportRenderAdapterDeps } from "./adapters/export-render";
