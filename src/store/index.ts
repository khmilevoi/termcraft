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
  BackupStore,
  ChangedPageOp,
  ChatHandle,
  ChatStore,
  CreateProjectInput,
  CreateTurnWorkspaceInput,
  GitIdentity,
  LeaseAdvisory,
  LeaseError,
  LeaseStore,
  LoadResult,
  ManifestStore,
  MigrationError,
  MigrationRegistry,
  OpenProject,
  OrphanTurnOutcome,
  PageCursor,
  PageStore,
  PinStore,
  ProjectionStore,
  ProjectLease,
  ProjectMutationInput,
  ProjectWritePermit,
  RecoveryOutcome,
  ResolvedPinAppend,
  Sha256Hex,
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
} from "./types"

export type { DiagnosticsEntry, DiagnosticsKey, ExportRenderKey, PageMetaEntry, PageMetaKey } from "./types"

// Tagged error classes are values (usable with `instanceof`) as well as types, so they are
// re-exported here rather than under `export type` above.
export { JsonlOpenError, ProjectAlreadyExistsError, ProjectLayoutError, createStore, nodeStoreDeps, toTxOutcome } from "./model/factory"
