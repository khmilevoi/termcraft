// The validation gate (master §6.3): decides whether an agent-produced immutable
// candidate page is safe to make canonical — TypeScript validity, the static-import
// allowlist, the page contract, manifest-slice consistency, a smoke render, and the
// non-fatal warning lints. The pipeline stages land task-by-task in phase 3; the
// GateResult contract (consumed by core + agent feedback) is public now.
export type { GateError, GateErrorKind, GateResult, GateWarning, GateWarningKind, PageDescriptor } from "./types"
export { makeGateResult, isPassing } from "./model/gate-result"
export { scanImportAllowlist } from "./model/import-scan"
export type { ImportScanError } from "./model/import-scan"
export { checkPageContract } from "./model/page-contract"
export type { PageContractError, PageContractResult } from "./model/page-contract"
