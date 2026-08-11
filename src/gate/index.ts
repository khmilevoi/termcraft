// The validation gate (master §6.3): decides whether an agent-produced immutable
// candidate page is safe to make canonical — TypeScript validity, the static-import
// allowlist, the page contract, manifest-slice consistency, a smoke render, and the
// non-fatal warning lints. The pipeline stages land task-by-task in phase 3; the
// GateResult contract (consumed by core + agent feedback) is public now.
export type {
  GateError,
  GateErrorKind,
  GateResult,
  GateWarning,
  GateWarningKind,
  ManifestSlice,
  PageDescriptor,
} from "./types";
export { createGateResult, isPassing } from "./model/gate-result";
export { scanImportAllowlist } from "./model/import-scan";
export type { ImportScanError } from "./model/import-scan";
export { scanModuleEdges, scanTreeImports } from "./model/tree-scan";
export { checkPageContract } from "./model/page-contract";
export type { PageContractError, PageContractResult } from "./model/page-contract";
export { resolveCompilerPath, CompilerExtractError } from "./model/tsc-extract";
export {
  TYPE_CHECK_UNAVAILABLE_CODE,
  createTreeTypeChecker,
  TypeCheckUnavailableError,
} from "./model/type-check";
export type { TypeCheckerConfig } from "./model/type-check";
export { checkManifestSlice } from "./model/manifest";
export type { ManifestScanInput, ManifestScanResult } from "./model/manifest";
export {
  checkDesignSystemSlice,
  hasDesignSystem,
  scanSystemContainment,
} from "./model/design-system";
export type { DesignSystemScanInput, DesignSystemScanResultV1 } from "./model/design-system";
export { scanNamedExports } from "./model/exports-scan";
export type { NamedExportScanV1 } from "./model/exports-scan";
export { lintDeterminism, lintSilencingAny } from "./model/lints";
export { createSmokeRender } from "./model/smoke";
export { smokeResultToErrors } from "./ports/smoke-renderer";
export type { SmokeRenderer, SmokeRequest, SmokeResult } from "./ports/smoke-renderer";
export { runGate, runTreeImports } from "./model/gate";
export type { GateInput, GatePorts } from "./model/gate";

// ---- adapters (adapter-ring plan, Task 6): the production `core/ports` `GateRunner`
// this module owns. Imports `core/ports` type-only to prove conformance (decision C2);
// nothing under `core/` imports back.
export { createGateRunnerAdapter } from "./adapters/gate-runner";
export type { GateRunnerAdapterDeps } from "./adapters/gate-runner";
