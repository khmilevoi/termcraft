// `store/transaction` — the recoverable `ProjectTransaction` engine (turn-durability §3.3,
// §4.3, §4.4, §4.5). Every target mutation goes through this engine: build a canonical
// `plan.json`, install and verify its payloads, re-check domain preconditions, cross the
// point of no rollback at `intent.json`, then roll every operation forward — idempotently,
// so a resumed process reaches the same committed state a fault-free run would have.
export type {
  Sha256Hex,
  AbsPath,
  FileImage,
  TransactionOperationMode,
  TransactionOperation,
  TransactionKind,
  TransactionPlan,
  ProjectWritePermit,
  TransactionIntent,
  OperationRealized,
  AppliedMarker,
  CommittedMarker,
  ConflictMarker,
  TransactionState,
  TransactionBoundary,
} from "./types"

export { TRANSACTION_JOURNAL_FORMAT_VERSION, JournalCorruptError, JournalTooNewError, computePlanHash, decodePlan, encodeCanonicalJson, validatePlanPayloads } from "./model/plan"

// The `transactions.local/format.json` journal-format gate (turn-durability §3.1), separate
// from `plan.ts`'s per-transaction `journalVersion` field: this classifies the whole journal
// namespace before any transaction directory is even listed (blocker finding #1).
export { JOURNAL_FORMAT_PATH, ensureJournalFormat, readJournalFormat } from "./model/journal-format"

export type { WriteMutex, WriteMutexChain, WriteMutexChainResult, WriteMutexDeps } from "./model/write-mutex"
export { WritePermitInvalidError, assertActivePermit, createWriteMutex, defaultWriteMutexDeps, mintWritePermitId } from "./model/write-mutex"

export type { RollForwardInput, RunTransactionInput, TransactionFsDeps } from "./model/engine"
export {
  TRANSACTIONS_LOCAL_DIR,
  TransactionIoError,
  TransactionIoPendingError,
  TransactionRecoveryConflictError,
  appliedDir,
  appliedMarkerPath,
  classifyAppendTail,
  committedPath,
  conflictPath,
  intentPath,
  loadTransactionPayloads,
  nodeTransactionFsDeps,
  payloadPath,
  payloadsDir,
  planPath,
  readCommitted,
  readIntent,
  readPlan,
  rollForwardTransaction,
  runTransaction,
  transactionDir,
} from "./model/engine"

// Startup recovery (turn-durability §4.6; storage-identity §10.2): scan
// `transactions.local/` in stable lexical UUID order, classify each journal directory
// BEFORE touching any target, and act — discard/roll-forward/recognize-complete/re-present
// the same conflict.
export type { ClassifyError, RecoverOneError, RecoveredTransaction, RecoveryOutcome, TransactionClassification } from "./model/recovery"
export { classifyTransaction, listTransactionIds, nodeRecoveryFsDeps, recoverTransactions } from "./model/recovery"
export type { RecoveryFsDeps } from "./model/recovery"

// The mandatory fault-injection harness (turn-durability §14.1): spawns a real `bun` child
// that performs one transaction and terminates itself — without cleanup — at an injected
// physical boundary; the caller reopens fresh, runs recovery, and asserts the managed tree
// landed at exactly the pre-intent old state or the exact committed new state.
export type { ChildCrashMode, ChildPayload, ChildRunResult, CrashCase, CrashCaseOutcome, PlanTargetsState, RunPlanInChildInput } from "./model/crash-harness"
export {
  CHILD_SETUP_ERROR_EXIT_CODE,
  CHILD_TX_ERROR_EXIT_CODE,
  CRASH_EXIT_CODE,
  hasNoDuplicateAppendIdentity,
  observePlanTargetsState,
  runCrashCase,
  runPlanInChildProcess,
} from "./model/crash-harness"

// The domain wrappers (turn-durability §6-§11): `TurnTransaction` (admission/finalization/
// terminalization), the generic `project-mutation` base-engine wrapper, and the
// infrastructure-only `RestoreTransaction`/`ExportPublishTransaction`/`MigrationTransaction`
// builders (built and unit-tested; MVP wires no caller for any of the three — see
// `./model/wrappers.ts`'s header comment).
export type {
  ChangedPageOp,
  ExportPublishInput,
  MigrationTransactionInput,
  PinEventInput,
  ProjectMutationInput,
  ProjectMutationKind,
  ResolvedPinAppend,
  RestoreTransactionInput,
  StandalonePinEventInput,
  TransactionWrapperDeps,
  TurnAdmissionInput,
  TurnFinalizeInput,
  TurnReadSet,
  TurnTerminalRecord,
  TurnTerminalizeInput,
} from "./model/wrappers"
export {
  ChatMutationLockedError,
  SourceChangedError,
  StaleError,
  TurnAlreadyTerminalError,
  TurnFinalizeInputError,
  TurnRecordNotFoundError,
  admitTurn,
  buildExportPublishTransaction,
  buildManifestOperation,
  buildMigrationTransaction,
  buildPinEventOperations,
  buildRestoreTransaction,
  buildStandalonePinEventOperation,
  buildWorkspaceLocalPatchOperation,
  canonicalPagePath,
  chatJsonlPath,
  finalizeTurn,
  observeFileImage,
  pageCommentsPath,
  runProjectMutation,
  terminalizeTurn,
} from "./model/wrappers"
