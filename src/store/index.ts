// `store/` — termcraft's project-state persistence layer (phase 4). This is the
// composition-root entry point: `createStore` wires every already-landed submodule
// (`store/lease`, `store/safe-fs`, `store/toml`, `store/jsonl`, `store/transaction`,
// `store/trust`, `store/projections`, `store/sandbox`, `store/migration`) against one
// injected `StoreDeps` bundle into the flat `Store` port `./types.ts` declares — the
// contract phase 6 lifts verbatim into `core/ports/` (roadmap cross-phase registry).
//
// `Store.openProject` runs the existing-project launch sequence (storage-identity §14.1 /
// turn-durability §12): lease -> durability adapter + SafeProjectFs -> journal format ->
// recover transactions -> migrations -> schemas -> orphan turn scan -> load stores -> open.
// `Store.createProject` runs new-project creation (storage-identity §14.2): one
// project-mutation transaction mints the format-1 layout, then the implicit trust grant is
// recorded. Every impure boundary (durable install, directory flush, reparse check, fs
// identity, the wall clock, UUIDv7 minting, the OS lock) is `StoreDeps` — injected, so the
// whole store is testable against fakes and the T14 crash-injection harness.
export type {
  AbsPath,
  AdvanceSessionCheckpointInput,
  AppendPinEventInput,
  BackupStore,
  ChangedDesignFileOp,
  ChatHandle,
  ChatListEntry,
  ChatStore,
  CreateChatInput,
  CreateProjectInput,
  CreateTurnWorkspaceInput,
  DesignTreeStore,
  GitIdentity,
  LeaseAdvisory,
  LeaseError,
  LeaseStore,
  LoadResult,
  ManifestStore,
  MigrationError,
  MigrationOutcomeV1,
  MigrationPlanV1,
  MigrationRegistry,
  OpenProject,
  OrphanTurnOutcome,
  PageCursor,
  PinStore,
  ProjectionStore,
  ProjectLease,
  ProjectMutationInput,
  ProjectWritePermit,
  RecoveryOutcome,
  RemovePageInput,
  RenamePageTitleInput,
  ReorderPagesInput,
  ResolvedPinAppend,
  SetActiveChatInput,
  SetActivePageInput,
  SetWorkspaceLocalInput,
  Sha256Hex,
  StagedTurnReadSet,
  StagingError,
  StagingStore,
  Store,
  StoreDeps,
  TransactionEngine,
  TransactionError,
  TrustError,
  TrustStore,
  TrustSubject,
  TurnAdmissionInput,
  TurnFinalizeInput,
  TurnReadSet,
  TurnTerminalRecord,
  TurnTerminalizeInput,
  TurnWorkspace,
  TxOutcome,
  WorkspaceStateStore,
  WriteMutex,
} from "./types";

export type {
  DiagnosticsEntry,
  DiagnosticsKey,
  ExportRenderKey,
  PageMetaEntry,
  PageMetaKey,
} from "./types";

// Tagged error classes are values (usable with `instanceof`) as well as types, so they are
// re-exported here rather than under `export type` above.
export {
  JsonlOpenError,
  ProjectAlreadyExistsError,
  ProjectLayoutError,
  ReorderPagesInvalidOrderError,
  createStore,
  nodeStoreDeps,
  toTxOutcome,
} from "./model/factory";
export { DesignTreeTooDeepError, PageEntryNotFoundError } from "./model/design-tree-store";

// ---- candidate assembly + session-checkpoint facade (phase-6 blocker B3 exposure) ------
//
// Neither of these is new capability — `snapshotToCandidate` (turn-durability §5.4/§7.3) and
// the checkpoint facade (storage-identity §6.2) already exist in `store/safe-fs`/`store/jsonl`
// — but `core` may not import a submodule directly (module DAG), so both are re-exported at
// this top level for the first time here.
export type { CandidateDeps, CandidateFile, CandidateSnapshot } from "store/safe-fs";
export { snapshotToCandidate } from "store/safe-fs";

export type {
  SessionPrefixHash,
  SessionResumeDecision,
  SessionResumeMismatchReason,
  SessionSeed,
} from "store/jsonl";
export {
  SESSION_SEED_MAX_RECORDS,
  SESSION_SEED_MAX_TEXT_BYTES,
  SessionPrefixError,
  advanceSessionCheckpoint,
  computeSessionPrefixHash,
  evaluateSessionResume,
  selectSeedRecords,
} from "store/jsonl";

// ---- adapter ring (WP-2): one production adapter per `core/ports` contract this module
// owns, each wrapping the real `OpenProject` facade above -------------------------------
export type { StoreAdapterDeps } from "./adapters/types";
export { toFailureDto } from "./adapters/failure";
export { createProjectStoreAdapter } from "./adapters/project-store";
export { createChatStoreAdapter } from "./adapters/chat-store";
export { createDesignStoreAdapter } from "./adapters/design-store";
export { createPinStoreAdapter } from "./adapters/pin-store";
export { createStagingAdapter } from "./adapters/staging";
export { createTurnTransactionsAdapter } from "./adapters/turn-transactions";
export { createProjectWriteAdapter } from "./adapters/project-write";
export type { ProjectionsAdapter } from "./adapters/projections";
export { createProjectionsAdapter } from "./adapters/projections";
export { createTrustAdapter } from "./adapters/trust";
export { createRecoveryAdapter } from "./adapters/recovery";
export { createSessionCheckpointAdapter } from "./adapters/session-checkpoint";
export { ExportSnapshotStaleError, createExportPublishAdapter } from "./adapters/export-publish";
