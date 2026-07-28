import type { ChatHeader, ChatRecord } from "entities/chat";
import type { PageSlug } from "entities/page";
import type { Pin, PinEvent } from "entities/pin";
import type { Clock } from "infrastructure/clock";
import type { DurabilityError } from "infrastructure/durability";
import type { PageCursor } from "store/jsonl";
import type { LeaseLockApi, ProjectLease } from "store/lease";
import type {
  BackupStore,
  MigrationBackupFailedError,
  MigrationRegistry,
  MigrationStaleError,
} from "store/migration";
import type {
  DiagnosticsEntry,
  DiagnosticsKey,
  ExportRenderKey,
  PageMetaEntry,
  PageMetaKey,
  ProjectionsError,
  RenderEntry,
} from "store/projections";
import type {
  SafeFsError,
  SafeProjectFs,
  SafeProjectFsDeps,
  StorageLimitExceededError,
} from "store/safe-fs";
import type { StagingStore } from "store/sandbox";
import type {
  ManifestCorruptError,
  ManifestMigrationRequiredError,
  ManifestTooNewError,
  ProjectManifest,
  WorkspaceLocalState,
  WorkspaceStateLoad,
} from "store/toml";
import type {
  CommittedMarker,
  JournalCorruptError,
  ProjectMutationInput,
  RecoveryOutcome,
  SourceChangedError,
  StaleError,
  TransactionBoundary,
  TransactionIoPendingError,
  TransactionRecoveryConflictError,
  TurnAdmissionInput,
  TurnFinalizeInput,
  TurnTerminalizeInput,
  WriteMutex,
} from "store/transaction";
import type { TrustStore } from "store/trust";

import type { JsonlOpenError } from "./model/factory";

// This is the STORE PORT CONTRACT (plan "Store port shapes"): the shapes `core/ports/`
// lifts verbatim in phase 6. Every already-landed submodule (`store/lease`, `store/trust`,
// `store/toml`, `store/transaction`, `store/sandbox`, `store/migration`, `store/projections`,
// `store/safe-fs`) exports its own real port type, re-exported here under the plan's name
// rather than re-declared — a second, parallel declaration would drift from the type the
// implementation actually satisfies. `ManifestStore`, `WorkspaceStateStore`, `ChatStore`,
// `ChatHandle`, `PinStore`, `PageStore`, `ProjectionStore`, and `TransactionEngine` have no
// landed submodule of their own (T19 is the first task that needs one flat interface spanning
// several submodules), so they are declared fresh here and implemented in `./model/factory.ts`.
//
// DOCUMENTED DIVERGENCES from the plan's draft (CLAUDE.md: adapt where feasible, otherwise
// document — these five could not be adapted without editing an already-landed submodule
// outside this task's file list):
//
// 1. `TransactionEngine.prepare()` / `PreparedTransaction` are DROPPED, and so is the
//    plan's `(permit, input)` calling convention. The plan sketched a two-step
//    prepare-then-apply handle plus an explicit `ProjectWritePermit` on every call; the
//    landed `store/transaction` engine (`runTransaction`) never split prepare from apply —
//    every wrapper (T15) calls it as one atomic prepare-through-roll-forward async
//    function — and every wrapper input already carries its own `mutex`/`permit` fields.
//    Rather than surface that plumbing on every named method (a caller would otherwise have
//    to acquire a permit it can never meaningfully hold onto between two engine calls), each
//    `TransactionEngine` method acquires/releases its own permit internally; a caller of
//    those methods never sees `ProjectWritePermit` at all.
//
//    UPDATED (phase 6 blocker B2): export preparation still needs to hold ONE SHORT permit
//    across several non-engine reads (capture a coherent source/settings snapshot), release
//    it before rendering, then reacquire the mutex for publication (kernel contract §7.5,
//    §12.5) — a need the paragraph above did not anticipate. `OpenProject.writeMutex` now
//    exposes the SAME `WriteMutex` instance every `TransactionEngine` method acquires
//    against internally (never a second, independently-created mutex — that would silently
//    break single-writer exclusion). A caller that only invokes named `TransactionEngine`
//    methods still never touches `ProjectWritePermit`; only a caller that needs to hold
//    exclusion across multiple non-engine steps reaches for `writeMutex` directly.
// 2. `TxOutcome`/`RecoveryOutcome` are kept as NAMED types for the phase-6 lift, but
//    `TransactionEngine`'s own methods return the landed wrappers' actual return type
//    (`Error | CommittedMarker`, the plain errore union every other boundary in this
//    codebase uses) rather than a pre-wrapped `{ok, ...}` object — wrapping a flat errore
//    union in a second Result-shaped wrapper is exactly what the errore convention this
//    codebase follows throughout (`errore` skill: "no wrapper types, no Result monads")
//    argues against, and `store/transaction`'s own landed code already committed to the
//    flat-union shape. `toTxOutcome` (factory.ts) adapts a landed result into the plan's
//    `TxOutcome` shape for a caller — e.g. the phase-6 `core/ports/` lift — that wants it.
// 3. `TxOutcome`'s error union drops `RestoreRecordConflictError` and `ExportStaleError`.
//    Neither class was ever landed: Restore and Export publication are infrastructure-only
//    in this phase (plan "Deferred / cross-phase" — no MVP caller invokes
//    `buildRestoreTransaction`/`buildExportPublishTransaction`), so no wrapper ever needed
//    to construct either error. Referencing a nonexistent type would not typecheck.
// 4. `RecoveryOutcome` is re-exported from `store/transaction` VERBATIM rather than the
//    plan's narrower sketch (`{ok:true, recovered}` / `{ok:false, conflict}`). The landed
//    shape carries strictly more information (`discarded`/`alreadyComplete` counts, and
//    `error` typed as the full `ClassifyError | RecoverOneError` union with the failing
//    `transactionId`) — narrowing it back to the sketch would throw away data the landed
//    `recoverTransactions` (T14) already computes.
// 5. `StagingStore` is re-exported from `store/sandbox` VERBATIM, which — per that
//    submodule's own header comment — omits the plan's `snapshotCandidate` method. The
//    post-run immutable-candidate assembly is `store/safe-fs`'s already-landed
//    `snapshotToCandidate` (T6); duplicating it as a second `StagingStore` method would
//    fork one capability into two names for the same behavior.

// ---- shared vocabulary ----------------------------------------------------------

/** Lowercase-hex SHA-256. Every submodule declares this locally per this codebase's own convention; this is the canonical alias `store/index.ts` re-exports. */
export type Sha256Hex = string;

/**
 * An OS-absolute path handed in by the composition root — never a caller-built managed
 * relative path (plan invariant 7). Every submodule declares this locally; this is the
 * canonical alias.
 */
export type AbsPath = string;

// ---- lease (storage-identity §9) -------------------------------------------------

export type { LeaseAdvisory, LeaseError, LeaseStore, ProjectLease } from "store/lease";

// ---- manifest + workspace state (storage-identity §5.1, §6.1) --------------------

/**
 * Reads go through the already-landed `store/toml` decoder; writes go through the
 * transaction engine (project-mutation / turn finalization), matching the plan. The return
 * union mirrors `decodeProjectManifest`'s own (project-toml format_version 2, task 5):
 * `ManifestMigrationRequiredError` is a version-1 project's honest refusal, not a shape
 * complaint — this plan does not implement the migration path.
 */
export interface ManifestStore {
  read(): Promise<
    | SafeFsError
    | ManifestCorruptError
    | ManifestTooNewError
    | ManifestMigrationRequiredError
    | ProjectManifest
  >;
}

/**
 * DIVERGENCE (documented): the plan's draft returns bare `WorkspaceLocalState` — "corrupt/
 * missing → deterministic defaults". The landed `loadWorkspaceLocalState` (`store/toml`,
 * T9) already returns the richer `WorkspaceStateLoad` (`{state, missing, corrupt,
 * preservedText}`), because storage-identity §6.1 requires a corrupt file to be REPORTED,
 * not merely defaulted past in silence. Narrowing back to bare `WorkspaceLocalState` would
 * throw that reporting obligation away, so this port returns the landed shape verbatim.
 */
export interface WorkspaceStateStore {
  read(): Promise<SafeFsError | WorkspaceStateLoad>;
}

// ---- chats (storage-identity §11, projections §7) --------------------------------

export type { PageCursor } from "store/jsonl";

/** One `loadTail`/`loadBefore` page: decoded records in display order, plus the cursor for the older page. */
export interface LoadResult {
  readonly records: readonly ChatRecord[];
  readonly prevCursor: PageCursor | null;
}

export interface ChatHandle {
  readonly header: ChatHeader;
  loadTail(limit?: number, byteBudget?: number): Promise<Error | LoadResult>;
  loadBefore(cursor: PageCursor, limit?: number, byteBudget?: number): Promise<Error | LoadResult>;
}

/**
 * One chat's listing facts (fix-bundle spec §2.1). `firstUserText` is the RAW first `user`
 * record's text, not a display name: the ~60-character truncation rule is design §3.9's and
 * lives in `core/chats`'s `truncateChatDisplayName`, so `store` never owns a presentation
 * decision.
 */
export interface ChatListEntry {
  readonly chatId: string;
  readonly createdAt: string;
  readonly firstUserText: string | null;
}

export interface ChatStore {
  open(chatId: string): Promise<JsonlOpenError | SafeFsError | ChatHandle>;
  /**
   * Every chat under the project, in `SafeProjectFs.list("chats")` order. A missing `chats/`
   * directory is an empty list, not a failure (a project can legitimately have none yet); a
   * chat whose own bytes cannot be read, or whose header identity does not match, is logged
   * and left out rather than failing the whole listing.
   */
  list(): Promise<SafeFsError | readonly ChatListEntry[]>;
}

// ---- pins (storage-identity §11.2) ------------------------------------------------

export interface PinStore {
  /** `[]` for a page with no comments log yet — not distinguished from "no open pins". */
  fold(pageSlug: PageSlug): Promise<SafeFsError | JsonlOpenError | readonly Pin[]>;
}

// ---- pages (storage-identity §3.2, staging §9) -------------------------------------

export interface PageStore {
  readSource(
    pageSlug: PageSlug,
  ): Promise<SafeFsError | { readonly bytes: Uint8Array; readonly sourceHash: Sha256Hex }>;
  /**
   * The ordered page slugs a page's listing/tab order and identity allocation are drawn
   * from. As of project.toml format_version 2 (task 5), `ProjectManifest` carries no
   * `pages` field — `design/pages.json`, inside the authored design tree, is now the sole
   * ordering authority (multi-file design tree design §3). This method's implementation is
   * NOT yet updated to read it (task 9's `store/model/factory.ts`).
   */
  listSlugs(): Promise<
    SafeFsError | ManifestCorruptError | ManifestTooNewError | readonly PageSlug[]
  >;
}

// ---- transaction engine (turn-durability §4) ---------------------------------------

export type { ProjectWritePermit, WriteMutex, RecoveryOutcome } from "store/transaction";
export type {
  ChangedPageOp,
  ProjectMutationInput,
  ResolvedPinAppend,
  TurnAdmissionInput,
  TurnFinalizeInput,
  TurnReadSet,
  TurnTerminalRecord,
  TurnTerminalizeInput,
} from "store/transaction";

/** See divergence note 2 above: kept for the phase-6 `core/ports/` lift; `toTxOutcome` (factory.ts) adapts a landed result into this shape. */
export type TxOutcome<E extends Error = Error> =
  | { readonly ok: true; readonly committed: CommittedMarker }
  | { readonly ok: false; readonly error: E };

/** The concrete error union every `TxOutcome` this store can produce may carry (divergence note 3). */
export type TransactionError =
  | SourceChangedError
  | StaleError
  | TransactionRecoveryConflictError
  | TransactionIoPendingError
  | JournalCorruptError
  | StorageLimitExceededError
  | MigrationStaleError
  | MigrationBackupFailedError;

// ---- named domain methods (phase-6 blocker B3) -------------------------------------
//
// `core` may not import `store/transaction`'s submodules (module DAG, CLAUDE.md
// "Imports"), so the six MVP commands the plan names — `chat.create`, `page.renameTitle`,
// `page.reorder`, `page.removeConfirm`, `pin.setStatus`, `model.select`, plus
// active-page/active-chat writes and checkpoint persistence — need a legal path that never
// requires a caller to learn `TransactionOperation`'s shape. Each method below builds its
// own operation(s) internally from `store/transaction`'s already-landed builders
// (`buildManifestOperation`, `buildWorkspaceLocalPatchOperation`,
// `buildStandalonePinEventOperation`, `observeFileImage`) and runs them through the same
// `runProjectMutation` base engine every other project mutation uses — `core` sees only
// these named methods and their plain-data inputs.

export interface CreateChatInput {
  readonly transactionId: string;
  readonly actionId: string;
  readonly chatId: string;
  readonly projectId: string;
  readonly createdAt: string;
}

export interface SetActiveChatInput {
  readonly transactionId: string;
  readonly actionId: string;
  /** `null` clears the explicit choice — the caller falls back to the newest valid chat (storage-identity §6.1). */
  readonly activeChatId: string | null;
  readonly createdAt: string;
}

export interface SetActivePageInput {
  readonly transactionId: string;
  readonly actionId: string;
  /** `null` clears the explicit choice — the caller falls back to the first listed page (storage-identity §6.1). */
  readonly activePageSlug: PageSlug | null;
  readonly createdAt: string;
}

export interface RenamePageTitleInput {
  readonly transactionId: string;
  readonly actionId: string;
  readonly pageSlug: PageSlug;
  /** The page's complete new source bytes (the `meta.title` edit is baked into the source by the caller — a page title is not a manifest field, entities/page's `PageMeta`). */
  readonly newBytes: Uint8Array;
  readonly createdAt: string;
}

export interface ReorderPagesInput {
  readonly transactionId: string;
  readonly actionId: string;
  /** The portable manifest as currently on disk — read by the caller first, matching `TurnFinalizeInput.manifestBefore`'s convention. */
  readonly manifestBefore: ProjectManifest;
  readonly orderedSlugs: readonly PageSlug[];
  readonly createdAt: string;
}

export interface RemovePageInput {
  readonly transactionId: string;
  readonly actionId: string;
  readonly manifestBefore: ProjectManifest;
  readonly pageSlug: PageSlug;
  readonly createdAt: string;
}

export interface AppendPinEventInput {
  readonly transactionId: string;
  readonly actionId: string;
  readonly pageSlug: PageSlug;
  /** Needed only to mint a NEW comments-log header when the page has no pins yet — a page's very first pin event durably creates its header in the SAME transaction. */
  readonly projectId: string;
  /** Fully built by the caller — a user-driven `pin:status` (`pin.setStatus`, `actionId` set) or a standalone `pin:created`. */
  readonly event: PinEvent;
  readonly createdAt: string;
}

export interface SetWorkspaceLocalInput {
  readonly transactionId: string;
  readonly actionId: string;
  /** Shallow-merged onto the current on-disk state (or the §6.1 defaults if absent/corrupt) — an omitted key keeps its current value. */
  readonly patch: Partial<WorkspaceLocalState>;
  readonly createdAt: string;
}

export interface AdvanceSessionCheckpointInput {
  readonly transactionId: string;
  readonly actionId: string;
  readonly chatId: string;
  readonly sessionScopeId: string;
  readonly sessionId: string;
  readonly recordCount: number;
  readonly createdAt: string;
}

/**
 * Every mutating method acquires and releases its own `ProjectWritePermit` internally
 * (see divergence note 1) — a caller passes only the wrapper's domain fields, never a
 * `mutex` or `permit`.
 */
export interface TransactionEngine {
  runProjectMutation(
    input: Omit<ProjectMutationInput, "mutex" | "permit">,
  ): Promise<Error | CommittedMarker>;
  admitTurn(input: Omit<TurnAdmissionInput, "mutex" | "permit">): Promise<Error | CommittedMarker>;
  finalizeTurn(
    input: Omit<TurnFinalizeInput, "mutex" | "permit">,
  ): Promise<Error | CommittedMarker>;
  terminalizeTurn(
    input: Omit<TurnTerminalizeInput, "mutex" | "permit">,
  ): Promise<Error | CommittedMarker>;
  /** Startup roll-forward before Workspace opens (§10.2 / §12). */
  recover(): Promise<RecoveryOutcome>;

  /** `chat.create`: mints a new chat header (create-new — a collision surfaces as the engine's ordinary CAS conflict). */
  createChat(input: CreateChatInput): Promise<Error | CommittedMarker>;
  /** Active-chat write (storage-identity §6.1). */
  setActiveChat(input: SetActiveChatInput): Promise<Error | CommittedMarker>;
  /** Active-page write (storage-identity §6.1). */
  setActivePage(input: SetActivePageInput): Promise<Error | CommittedMarker>;
  /** `page.renameTitle`: replaces one canonical page's source bytes in place. */
  renamePageTitle(input: RenamePageTitleInput): Promise<Error | CommittedMarker>;
  /** `page.reorder`: rewrites `project.toml`'s page order — a no-op plan when the order is already current. */
  reorderPages(input: ReorderPagesInput): Promise<Error | CommittedMarker>;
  /** `page.removeConfirm`: drops a page from the manifest and deletes its canonical source and comments log. */
  removePage(input: RemovePageInput): Promise<Error | CommittedMarker>;
  /** `pin.setStatus` (and standalone `pin:created`): one append-only comments-log event. */
  appendPinEvent(input: AppendPinEventInput): Promise<Error | CommittedMarker>;
  /** `model.select` and every other machine-local field write share this one generic patch. */
  setWorkspaceLocal(input: SetWorkspaceLocalInput): Promise<Error | CommittedMarker>;
  /** Checkpoint persistence (storage-identity §6.2): hashes the target chat's current prefix and durably records the advanced checkpoint. */
  advanceSessionCheckpoint(input: AdvanceSessionCheckpointInput): Promise<Error | CommittedMarker>;
}

// ---- trust (storage-identity §8) ---------------------------------------------------

export type { GitIdentity, TrustError, TrustStore, TrustSubject } from "store/trust";

// ---- projections (projections §6, §7, §10, storage-identity §7) --------------------

export type {
  DiagnosticsEntry,
  DiagnosticsKey,
  ExportRenderKey,
  PageMetaEntry,
  PageMetaKey,
  RenderEntry,
} from "store/projections";

/**
 * DIVERGENCE (documented): the plan sketched one flat `ProjectionStore` interface; the
 * landed `store/projections` (T18) is three independently quota-managed stores
 * (`PageMetaCache`/`DiagnosticsStore`/`RenderCache`), each its own `create*`/`Deps` pair —
 * splitting them let each own its own quota/generation/eviction policy cleanly. This port
 * is the flat facade the plan drew, composed from the three landed stores in
 * `./model/factory.ts` rather than re-implemented.
 */
export interface ProjectionStore {
  pageMetaGet(key: PageMetaKey): Promise<ProjectionsError | PageMetaEntry | null>;
  pageMetaPut(entry: PageMetaEntry): Promise<ProjectionsError | undefined>;
  diagnosticsGet(key: DiagnosticsKey): Promise<ProjectionsError | DiagnosticsEntry | null>;
  diagnosticsPut(entry: DiagnosticsEntry): Promise<ProjectionsError | undefined>;
  renderGet(key: ExportRenderKey): Promise<ProjectionsError | RenderEntry | null>;
  renderPut(entry: RenderEntry): Promise<ProjectionsError | undefined>;
}

// ---- staging (turn-durability §6.2, projections §9) ---------------------------------

export type {
  CreateTurnWorkspaceInput,
  StagedTurnReadSet,
  StagingError,
  StagingStore,
  TurnWorkspace,
} from "store/sandbox";

// ---- migration (storage-identity §12) ------------------------------------------------

export type { BackupStore, MigrationError, MigrationRegistry } from "store/migration";

// ---- orphan turn scan (turn-durability §7.7) -----------------------------------------

/** One turn the startup scan found without a terminal record, and what it did about it. */
export interface OrphanTurnOutcome {
  readonly chatId: string;
  readonly turnId: string;
  readonly terminalized: boolean;
}

// ---- the composition-root factory (this task) ----------------------------------------

/**
 * Every impure boundary `store/index.ts`'s factory needs, injected so the whole store is
 * testable against fakes (plan "every impure boundary ... is injected"). Production wiring
 * (`nodeStoreDeps`, `./model/factory.ts`) composes the real `infrastructure/durability`,
 * `infrastructure/fs-guard`, `infrastructure/uuid`, and `infrastructure/clock` bindings;
 * tests substitute a crash-injecting `durableWrite`/`onBoundary` or a fake clock/uuid.
 */
export interface StoreDeps {
  /** The OS per-user termcraft state root that owns the trust ledger, sandboxes, and backups (storage-identity §4). */
  readonly userStateRoot: AbsPath;
  readonly clock: Clock;
  /** Mints every UUIDv7 identity this store assigns (`projectId`, `chatId`, `transactionId`, `recordId`, …). */
  readonly uuidv7: () => string;
  /** The durable atomic file install (`infrastructure/durability`'s `durableFileWrite`, injected so tests can fail/observe it). Typed `DurabilityError` (not bare `Error`) because `store/transaction`'s `TransactionFsDeps` requires exactly that return type. */
  readonly durableWrite: (absPath: AbsPath, bytes: Uint8Array) => DurabilityError | undefined;
  /** The directory-flush write-through equivalent of `fsync(dirfd)` (`infrastructure/durability`'s `flushDir`). Also the injection point `openProject`/`createProject` pass to `probeDurability`'s pre-flight check (M5), so a test can simulate a refused volume without one. */
  readonly flushDir: (absDir: AbsPath) => DurabilityError | undefined;
  /** The OS-lock primitive `store/lease` needs (`windowsLeaseLockApi` in production). */
  readonly lock: LeaseLockApi;
  /** The tag-agnostic reparse-point backstop (`infrastructure/fs-guard`'s `isReparsePoint`, Spike F). */
  readonly isReparsePoint: (absPath: AbsPath) => boolean | Error;
  /** The canonical filesystem-identity string (`infrastructure/fs-guard`'s `formatFsIdentity`, Spike F §8) — feeds `store/trust`'s subject assembly and the chat index's change-detection identity. */
  readonly fsIdentity: (absPath: AbsPath) => string | Error;
  /** Every impure boundary the no-follow walk and the reads a `SafeProjectFs` performs need; defaults to `nodeSafeFsDeps()` with `isReparsePoint` substituted for the one above. */
  readonly safeFsDeps?: SafeProjectFsDeps;
  /** Fires immediately after each named durable transaction artifact lands — the T14 fault-injection seam, threaded through for the crash-injection sweep. */
  readonly onBoundary?: (name: TransactionBoundary) => void;
}

export interface CreateProjectInput {
  readonly root: AbsPath;
  readonly name: string;
  readonly targetStack: ProjectManifest["targetStack"];
}

/** Everything one open project session exposes — the factory's return value, and what the composition root injects into `core`. */
export interface OpenProject {
  readonly root: AbsPath;
  readonly lease: ProjectLease;
  readonly safeFs: SafeProjectFs;
  readonly recovery: RecoveryOutcome;
  readonly orphanTurns: readonly OrphanTurnOutcome[];
  readonly transactions: TransactionEngine;
  /**
   * The SAME `WriteMutex` instance `transactions`'s own methods acquire/release against
   * internally (blocker B2) — never a second, independently-created mutex, which would
   * silently break single-writer exclusion. Export preparation is the reason this exists:
   * it holds one short permit while it captures a coherent source/settings snapshot,
   * releases it before rendering, then reacquires the mutex for publication (kernel
   * contract §7.5, §12.5) — a sequence no single `TransactionEngine` method call can express.
   */
  readonly writeMutex: WriteMutex;
  readonly manifest: ManifestStore;
  readonly workspaceState: WorkspaceStateStore;
  readonly chats: ChatStore;
  readonly pins: PinStore;
  readonly pages: PageStore;
  readonly trust: TrustStore;
  readonly projections: ProjectionStore;
  readonly staging: StagingStore;
  readonly backups: BackupStore;
  readonly migrations: MigrationRegistry;
  /** Releases the `ProjectLease`. Every other handle above becomes unsafe to use after this resolves. */
  close(): Promise<void>;
}

/** The composition-root entry point (plan "index.ts exposes the factory the composition root calls"). */
export interface Store {
  /**
   * The existing-project launch sequence (storage-identity §14.1 / turn-durability §12), in
   * this exact order: lease → durability adapter + `SafeProjectFs` → journal format →
   * recover transactions → migrations → schemas → orphan turn scan → load stores → open.
   */
  openProject(root: AbsPath): Promise<Error | OpenProject>;
  /**
   * New-project creation (storage-identity §14.2): ONE `project-mutation` transaction
   * mints `projectId`, the format-1 layout, the generated `.gitignore`, the workspace
   * file, and the first chat header — then records the implicit trust grant.
   */
  createProject(input: CreateProjectInput): Promise<Error | OpenProject>;
}

export type {
  JsonlOpenError,
  ProjectLayoutError,
  ProjectAlreadyExistsError,
} from "./model/factory";
