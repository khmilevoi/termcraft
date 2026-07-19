# Phase 4 — `store/` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking. Load `/reatom` and `/errore`
> before touching code (CLAUDE.md mandate). TDD every task (failing test → run red →
> minimal impl → run green → commit). Keep `bun test` + `bun x tsc --noEmit` green after
> every task; `bun test` must return to the shell (no hang). All storage values —
> layouts, field names, byte encodings, limits — come from the specs, never invented
> (CLAUDE.md design/source-of-truth rule); this module has no visual surface.

**Goal:** Build `src/store/` — termcraft's project-state persistence layer: durable
identity, the portable/local split (`project.toml` / `workspace.local.toml`), JSONL
chats + pins with valid-prefix recovery, the recoverable `ProjectTransaction` engine
(plan → intent → idempotent roll-forward → committed) with startup recovery,
`SafeProjectFs`, the OS-held `ProjectLease`, the machine-local `TrustStore` +
byte-exact `TrustSubjectV1`, the `{userStateRoot}` sandboxes / turn workspaces /
verified backups, an empty-but-live migration chain, and the rebuildable projections
(page-meta cache, `DiagnosticsStore`, `ChatIndex`, render cache). Plus the three
domain-free `infrastructure/fs` primitives the store depends on (durable flush,
reparse-point check, filesystem identity). Per roadmap phase 4;
`2026-07-16-production-storage-identity-design.md` (layout/identity authority),
`2026-07-16-turn-durability-staging-design.md` (journal + append protocol authority),
`2026-07-16-projections-observability-scale-design.md` (projections authority), and
Spikes F/G.

**Architecture:** `store/` is a core-consumed adapter (`docs/architecture/code-structure.md`).
It imports `entities/` (the Chat/Pin/Page vocabulary it persists) and `infrastructure/`
(domain-free fs/uuid/clock capabilities), and **imports no other module**. Every
impure boundary — the durable-flush FFI, the reparse-point FFI, `statSync`, the wall
clock, UUIDv7 minting — is injected, so the whole store is testable against fakes and a
crash-injection harness. The store declares the port shapes that `core` will consume in
`store/types.ts`; per the roadmap those shapes are lifted verbatim into `core/ports/` in
phase 6 and the composition root injects the store's implementations. The store is
almost entirely **non-Reatom** pure/async adapter code (like `gate/` and `host/`); the
Reatom state machines that drive turns/exports/startup live in `core/` (phase 6). No
atoms in this phase.

**Tech Stack:** Bun ≥1.3.14 (`bun test`, `bun x tsc --noEmit`), TypeScript 7.0.2
(`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), `errore` (errors as
values), `bun:ffi` → `kernel32.dll` for the Windows durability + reparse + identity
primitives (Spikes F/G), `node:crypto` `createHash("sha256")`, the injected `Clock` /
`uuidv7` seams. Non-Reatom.

## Global constraints (inherited by reference)

Inherits the roadmap **Global constraints** (`2026-07-17-termcraft-mvp-roadmap.md`,
lines 26–108) verbatim. Phase-4-critical:

- **errore mandatory:** namespace import; return `Error | T` unions; `createTaggedError`
  for every domain error; `.catch()` / `errore.try` **only** at the fs/FFI/JSON.parse
  boundaries (fs and FFI throw; `JSON.parse` throws; TOML parse throws); flat control
  flow with one-line `instanceof Error` early returns; `| null` for optional values;
  never a silent swallow (log any dropped error). A validation/recovery failure is a
  returned tagged error, never a throw.
- **Reatom:** the store is a pure/async persistence adapter — **no atoms** (phase 6 owns
  the state machines). Long-lived lifetimes (the lease handle, the write mutex, the
  transaction journal) are owned by explicit constructors/closures with explicit
  teardown, never a connect hook (roadmap §3.8 rule).
- **Module DAG:** `store` imports only `entities/` and `infrastructure/`. It never imports
  `core`/`gate`/`host`/`agent`/`ui`. Port shapes it declares live in `store/types.ts`
  (lifted to `core/ports/` in phase 6). No shared `contracts/` folder.
- **Folder shape (CLAUDE.md):** feature submodules under `store/` (`safe-fs/`, `lease/`,
  `toml/`, `jsonl/`, `transaction/`, `trust/`, `projections/`, `migration/`, `sandbox/`),
  each with an internal `model/` (never loose files) plus `types.ts`/`index.ts` where it
  has shared types / a public boundary. `store/types.ts` + `store/index.ts` at the root.
  Atomic single-purpose functions.
- **Identities:** page identity is the branded `PageSlug` (`entities/page`, mask
  `^[a-z0-9][a-z0-9-]{0,31}$` minus Windows device names). Every other durable identity
  (`projectId`, `chatId`, `turnId`, `recordId`, `pinId`, `actionId`, `restoreActionId`,
  `transactionId`, `generationId`, `migrationPlanId`, `migrationActionId`, `commandId`,
  `leaseNonce`) is a **UUIDv7** (except `leaseNonce`, a 128-bit base64url random) minted
  through `infrastructure/uuid`, canonical lowercase RFC 9562.
- **Durability primitive (Spike G):** dir flush = `CreateFileW(FILE_FLAG_BACKUP_SEMANTICS,
  GENERIC_WRITE)` **alone** + `FlushFileBuffers` via `bun:ffi`; ~19 ms median per flush —
  budget transactions accordingly; unsupported volume detected by `GetDriveTypeW`
  (`DRIVE_REMOTE`) **and** a real flush probe (`ERROR_INVALID_FUNCTION`); `renameSync`
  replaces on Windows (libuv `MOVEFILE_REPLACE_EXISTING`); no `O_NOFOLLOW` on Windows →
  `lstatSync`-before-open (residual TOCTOU, recorded not closed); `import.meta.dir` does
  **not** survive `bun build --compile` — use runtime paths.
- **Reparse/identity primitive (Spike F):** escape check = `realpathSync(joined)` vs
  `realpathSync(root)` prefix compare (naive `join` misses a planted junction);
  tag-agnostic reparse backstop = `GetFileAttributesW` + `FILE_ATTRIBUTE_REPARSE_POINT`
  via `bun:ffi`, **not** `isSymbolicLink()` alone; `statSync(dir, { bigint: true })` gives
  `dev` = volume serial (8 lowercase hex) and a `git`/atomic-rename-stable `ino`; the
  Windows file-id half is variable-length (NTFS ≤ 8 bytes), not a fixed 16.
- **English only** for code/comments/commits; commits per task with the Claude co-author
  trailer.
- **Architecture docs:** when this phase lands, move the `storage.md` /
  `code-structure.md` Source anchors that point at spec sections onto the real
  `src/store/**` and `src/infrastructure/fs/**` paths (architecture-update skill).

---

## Architecture: `infrastructure/` vs `store/` placement

The mechanical test (code-structure §6): *does the file know what a `Page`, `Chat`, or
`Turn` is?* If no → `infrastructure/` (domain-free ring). If yes → `store/`.

| Capability | Layer | Justification against the "knows what a Page is" test |
|---|---|---|
| Durable flush + 6-step install (`CreateFileW`/`FlushFileBuffers`, Spike G §4.2) | `infrastructure/fs` | Operates on absolute paths + byte buffers + SHA-256. Knows nothing of pages/chats. Domain-free. |
| Reparse-point check (`GetFileAttributesW`, Spike F) | `infrastructure/fs` | Answers "is this absolute path a reparse point?" — a raw fs fact. Domain-free. |
| Filesystem identity (`statSync` bigint dev/ino → canonical string, Spike F §8) | `infrastructure/fs` | Formats a generic `unix:`/`windows:` identity string for any path. Page-agnostic. **Borderline** (the string format is named by storage §8) — flagged below. |
| Unsupported-volume probe (`GetDriveTypeW` + real flush probe) | `infrastructure/fs` | A volume capability check. Domain-free. |
| `SafeProjectFs` (path rules, `.termcraft/` namespace grammar, candidate copy, per-namespace limits) | `store/safe-fs` | Knows the managed namespaces (`pages/<slug>.tsx`, `pages.json`, chat/comments JSONL), page-slug rules, and candidate semantics → domain. |
| `ProjectTransaction` engine + wrappers | `store/transaction` | Knows turn/restore/export/migration domains and the JSONL append/pin semantics → domain. |
| `TrustSubjectV1` encoder + `TrustStore` | `store/trust` | Assembles project root + `projectId` + `GitIdentity` into the `termcraft-trust-subject-v1` digest → domain (uses the infra fs-identity string as an input). |
| `ChatIndex`, `DiagnosticsStore`, page-meta cache, render cache | `store/projections` | Keyed by `pageSlug`/`sourceHash`/`kitApiVersion` and chat records → domain. |
| `ProjectLease` | `store/lease` | Locks `.termcraft/lock` for the project's write ownership → domain (project lifetime), though thin. |

> **Placement note (fs-identity):** the raw `statSync` read + the `unix:<dev>:<ino>` /
> `windows:<serial-8hex>:<file-id-hex>` string formatting is domain-free and lives in
> `infrastructure/fs`. The **assembly** of that string with the canonical project path,
> `projectId`, and `GitIdentity` into the `TrustSubjectV1` byte stream is domain and lives
> in `store/trust`. This keeps the FFI/`statSync` details out of the domain layer while
> the trust semantics stay in `store`.

---

## Entity type shapes (the durable contract)

Per the roadmap cross-phase registry, the Chat/pin record types land as **pure
`entities/` vocabulary** (no ports, no I/O) in this phase, consumed by `store`, `core`,
and `ui`. They are byte-faithful to storage-identity §11.2 cross-checked against
turn-durability §6.1. `entities/chat` and `entities/pin` may import `PageSlug` from
`entities/page` (pure→pure is legal); they import nothing else.

### Branding rule (decision)

`entities/page` brands `PageSlug` (constructed only via `parsePageSlug`); `entities/turn`
leaves `turnId`/`leaseNonce` as plain `string`. The resolving rule for this phase, stated
once and applied everywhere:

> **Brand an identity iff it carries a domain-specific validation grammar and is obtained
> through a `parse*` function. Only `PageSlug` qualifies. Every UUIDv7 identity
> (`projectId`, `chatId`, `turnId`, `recordId`, `pinId`, `actionId`, `restoreActionId`,
> `transactionId`, `generationId`, `migration*Id`, `commandId`) is a plain `string`,
> because they share one uniform canonical-form check and are minted, not parsed.** The
> shared validator `isCanonicalUuidv7(s: string): boolean` lives in `infrastructure/uuid`;
> record decoders call it, but it does not brand.

This keeps consistency with both existing precedents (`PageSlug` branded because it is
parsed; `turnId` plain because it is minted).

### `entities/chat/types.ts`

```ts
import type { PageSlug } from "../page"

/** First line of every chat JSONL (storage §11.2). */
export interface ChatHeader {
  readonly kind: "chat"
  readonly formatVersion: 1
  readonly projectId: string
  readonly chatId: string
  readonly createdAt: string // UTC RFC 3339
}

/** A resolved element selection sent with a user message (turn-durability §6.1). */
export interface ChatSelection {
  readonly pageSlug: PageSlug
  readonly element: string
}

/**
 * A gate-warning snapshot stored on an agent record. IMMUTABLE historical
 * presentation (projections §6.2) — never the source of current diagnostics.
 * Decoupled from gate's `GateWarning` because `entities/` imports no adapter.
 */
export interface ChatWarningSnapshot {
  readonly kind: string
  readonly message: string
}

/** The initiating record of a turn (storage §11.2; turn-durability §6.1). */
export interface ChatUserRecord {
  readonly kind: "user"
  readonly recordId: string
  readonly turnId: string
  readonly text: string
  readonly selection?: ChatSelection
  readonly pins?: readonly string[] // included pinId references
  readonly ts: string
}

/** The successful terminal record of a turn (storage §11.2; turn-durability §6.1/§7.4). */
export interface ChatAgentRecord {
  readonly kind: "agent"
  readonly recordId: string
  readonly turnId: string
  readonly text: string
  readonly changedPages: readonly PageSlug[]
  readonly warnings: readonly ChatWarningSnapshot[]
  readonly ts: string
}

/** Terminal failure/interruption record (storage §11.2; turn-durability §6.1/§7.6). */
export interface ChatSystemErrorRecord {
  readonly kind: "system:error"
  readonly recordId: string
  readonly turnId?: string // exactly one of turnId/actionId (decoder-enforced)
  readonly actionId?: string
  readonly outcome: "error" | "stale" | "interrupted"
  readonly reason?: string // e.g. "process_restart_before_intent"
  readonly text: string
  readonly ts: string
}

/** Terminal cancellation record (storage §11.2; turn-durability §6.1). */
export interface ChatSystemCancelledRecord {
  readonly kind: "system:cancelled"
  readonly recordId: string
  readonly turnId?: string // exactly one of turnId/actionId (decoder-enforced)
  readonly actionId?: string
  readonly text: string
  readonly ts: string
}

/**
 * Restore audit record (storage §11.2). DEFINED for reader completeness and
 * forward-compat, but Restore is OUT OF MVP SCOPE (roadmap Out-of-scope): NO phase-4
 * code path writes this record, so it cannot legitimately appear in an MVP-created
 * chat. The decoder recognizes and validates it; no writer exists.
 */
export interface ChatSystemRestoreRecord {
  readonly kind: "system:restore"
  readonly recordId: string
  readonly restoreActionId: string
  readonly pageSlug: PageSlug
  readonly sourceCommit: string // full Git object id
  readonly ts: string
}

export type ChatRecord =
  | ChatUserRecord
  | ChatAgentRecord
  | ChatSystemErrorRecord
  | ChatSystemCancelledRecord
  | ChatSystemRestoreRecord
```

### `entities/pin/types.ts`

```ts
import type { PageSlug } from "../page"

/** First line of every comments JSONL (storage §11.2). */
export interface CommentsHeader {
  readonly kind: "pins"
  readonly formatVersion: 1
  readonly projectId: string
  readonly pageSlug: PageSlug
}

/** Pin creation event; initial folded status is `open` (storage §11.2). */
export interface PinCreatedEvent {
  readonly kind: "pin:created"
  readonly recordId: string
  readonly pinId: string
  readonly element: string // anchored element id
  readonly fx: number // fractional x in [0,1]
  readonly fy: number // fractional y in [0,1]
  readonly text: string
  readonly ts: string
}

/**
 * Pin status transition (storage §11.2). Status is an EVENT FOLD, never in-place.
 * A user change carries `actionId`; automatic resolution after a successful apply
 * carries the responsible `turnId`. Exactly one of the two is present.
 */
export interface PinStatusEvent {
  readonly kind: "pin:status"
  readonly recordId: string
  readonly pinId: string
  readonly status: "open" | "resolved"
  readonly actionId?: string
  readonly turnId?: string
  readonly ts: string
}

export type PinEvent = PinCreatedEvent | PinStatusEvent

/** Derived pin state; the fold of a comments log (storage §11.2). */
export interface Pin {
  readonly pinId: string
  readonly element: string
  readonly fx: number
  readonly fy: number
  readonly text: string
  readonly status: "open" | "resolved"
}
```

**Fold rule (implemented in `store/jsonl`, contract stated here):** file order is
authoritative. `pin:created` establishes a pin with status `open`; the **latest valid
file-order** `pin:status` for that `pinId` sets its status (never a timestamp/UUID
comparison). A second `pin:created` for one `pinId`, or a `pin:status` before its
`pin:created`, is **corruption**. Reopen appends `pin:status open`; resolve appends
`pin:status resolved`.

---

## File structure

```
src/
  entities/
    chat/
      model/
        decode.ts        record/header decoders (schema + identity checks); fold helpers off ChatRecord
        decode.test.ts
      types.ts           ChatHeader, ChatRecord union (above)
      index.ts
    pin/
      model/
        decode.ts        event/header decoders; foldPins(events) → Pin[]
        decode.test.ts
      types.ts           CommentsHeader, PinEvent union, Pin (above)
      index.ts

  infrastructure/
    fs/                  domain-free Windows fs primitives (Spikes F/G)
      model/
        ffi.ts           bun:ffi dlopen kernel32 symbol table (CreateFileW, FlushFileBuffers, GetFileAttributesW, GetDriveTypeW); UTF-16LE arg helper
        durable-fs.ts    6-step install / delete / flushDir / probeDurability (Spike G)
        reparse-check.ts isReparsePoint(absPath) via GetFileAttributesW backstop (Spike F)
        fs-identity.ts   statSync bigint → {dev,ino}; formatIdentity() canonical string (Spike F §8)
        *.test.ts
      types.ts           DurableFs, ReparseCheck, FsIdentity ifaces; FileImage; UnsupportedDurabilityError
      index.ts

  store/
    types.ts             STORE PORT contracts (drafted for phase-6 lift to core/ports/) + shared store errors
    index.ts             factory wiring the composition root calls
    safe-fs/
      model/
        path-rules.ts    §5.1 relative-path grammar rejection (.., abs, UNC, ADS, reserved, overlong, NFC/case collision)
        no-follow.ts     per-component no-follow open + realpath escape check (Spike F)
        leaf-identity.ts §5.2 regular-file / one-link / file-type checks
        limits.ts        §5.3 per-namespace/count/aggregate/depth limits
        candidate.ts     §5.4 immutable candidate snapshot (copy-while-hashing + recheck)
        *.test.ts
      types.ts           SafeProjectFs iface, ManagedRoot, SafeFs error union
      index.ts
    lease/
      model/
        lease.ts         §9 non-blocking exclusive OS lock on .termcraft/lock; advisory metadata
        lease.test.ts
      types.ts           ProjectLease, LeaseAdvisory, LeaseStore, LeaseHeldError
      index.ts
    toml/
      model/
        project-toml.ts  §5.1 format_version=1 encode/decode/validate
        workspace-toml.ts §6.1 local-state encode/decode + deterministic defaults + corrupt-preserve
        gitignore.ts     generated anchored .gitignore (§13, turn-durability §3.1)
        *.test.ts
      types.ts           ProjectManifest, WorkspaceLocalState, SessionCheckpoint, ResourceLimitOverrides
      index.ts
    jsonl/
      model/
        line-codec.ts    UTF-8/no-BOM/LF, 1 MiB physical-line bound, header+record encode/decode
        reader.ts        streaming valid-prefix reader + 3 repair classifications (§11.3)
        append-builder.ts prepared-append byte builder (before length/prefix hash/appended bytes) feeding the tx engine (§4.4)
        chat-index.ts    ChatIndex projection: offsets, generations, loadTail/loadBefore (projections §7)
        checkpoint.ts    session checkpoint (chatId, sessionScopeId) prefix hash (§6.2)
        *.test.ts
      types.ts           RepairClassification, ChatIndexEntry, PageCursor, LoadResult, JSONL error union
      index.ts
    transaction/
      model/
        plan.ts          §3.3 FileImage/TransactionOperation/TransactionPlan canonical JSON + SHA-256
        engine.ts        §4.3 prepare→intent→apply→committed; §4.4 exactly-once JSONL append classification
        recovery.ts      §4.6/§10.2 startup recovery classification + decision table
        write-mutex.ts   §4.5 FIFO project-write mutex + ProjectWritePermit (random id, invalidate-on-release)
        wrappers.ts      TurnTransaction / RestoreTransaction / ExportPublishTransaction / MigrationTransaction / project-mutation
        *.test.ts
      types.ts           TransactionEngine iface, wrapper inputs, TransactionState, tx error union
      index.ts
    trust/
      model/
        subject.ts       §8 TrustSubjectV1 byte-exact encoder + SHA-256 digest
        trust-store.ts   machine-local ledger under {userStateRoot}; grant match/record
        *.test.ts
      types.ts           TrustSubject, GitIdentity, TrustDecision, TrustStore iface
      index.ts
    projections/
      model/
        page-meta-cache.ts   §7 (pageSlug, sourceHash, extractorVersion) atomic entry store
        diagnostics-store.ts projections §6 (pageSlug, sourceHash, kitApiVersion) + quota/LRU
        render-cache.ts      projections §10.2 ExportRenderKey content-addressed store
        *.test.ts
      types.ts           DiagnosticsKey, ExportRenderKey, PageMetaEntry, ProjectionStore iface
      index.ts
    migration/
      model/
        registry.ts      §12 EMPTY chain + format-counter reads + newer-than-binary hard error
        backup-store.ts  §12 verified external backup protocol ({userStateRoot}/backups)
        *.test.ts
      types.ts           MigrationRegistry, BackupStore iface, migration error union
      index.ts
    sandbox/
      model/
        project-key.ts   §4/§6.2 SHA-256(UTF-8(root) || 0x00 || UTF-8(projectId))
        staging-store.ts sandboxes/<projectKey>/turns/<turnId>/workspace + turn.json (create-new)
        *.test.ts
      types.ts           StagingStore iface, TurnWorkspace, WorkspaceCollisionError
      index.ts
```

---

## Store port shapes (`store/types.ts`)

Drafted now as the **stable contract phase 6 lifts verbatim into `core/ports/`** (roadmap
cross-phase registry). Every method returns an errore `Error | T` union; every failure is
a `createTaggedError` domain error. Absolute paths are the injected roots; the store never
takes a caller-built managed path (invariant 7). `AbsPath` is `string` (an OS-absolute
path handed in by the composition root / launch path — never a managed relative path).

```ts
// ---- shared vocabulary --------------------------------------------------------
export type Sha256Hex = string
export type AbsPath = string

// ---- lease (storage §9) -------------------------------------------------------
export interface ProjectLease {
  readonly nonce: string
  release(): Promise<void>
}
export interface LeaseAdvisory {
  readonly pid: number | null
  readonly startedAt: string | null
  readonly hostname: string | null
  readonly nonce: string | null
} // ALWAYS labeled advisory; never ownership proof
export interface LeaseStore {
  acquire(root: AbsPath): Promise<LeaseHeldError | UnsupportedDurabilityError | ProjectLease>
  readAdvisory(root: AbsPath): Promise<LeaseAdvisory | null>
}

// ---- manifest + workspace state (storage §5.1, §6.1) --------------------------
export interface ManifestStore {
  read(): Promise<ManifestCorruptError | ManifestTooNewError | ProjectManifest>
  // writes go through the transaction engine (project-mutation / turn finalization)
}
export interface WorkspaceStateStore {
  read(): Promise<WorkspaceLocalState> // corrupt/missing → deterministic defaults (§6.1)
  readCheckpoint(chatId: string, sessionScopeId: string): Promise<SessionCheckpoint | null>
  // writes go through the transaction engine (project-mutation)
}

// ---- chats (storage §11, projections §7) --------------------------------------
export interface ChatStore {
  open(chatId: string): Promise<JsonlOpenError | ChatHandle>
}
export interface ChatHandle {
  readonly header: ChatHeader
  loadTail(limit: number, byteBudget: number): Promise<JsonlReadError | LoadResult>
  loadBefore(cursor: PageCursor, limit: number, byteBudget: number): Promise<JsonlReadError | LoadResult>
}
export interface LoadResult {
  readonly records: readonly ChatRecord[] // display order
  readonly prevCursor: PageCursor | null
}

// ---- pins (storage §11.2) -----------------------------------------------------
export interface PinStore {
  fold(pageSlug: PageSlug): Promise<JsonlReadError | readonly Pin[]>
  // pin events are appended via project-mutation / turn finalization
}

// ---- pages (storage §3.2, staging §9) -----------------------------------------
export interface PageStore {
  readSource(pageSlug: PageSlug): Promise<SafeFsError | { bytes: Uint8Array; sourceHash: Sha256Hex }>
  listSlugs(): Promise<ManifestCorruptError | readonly PageSlug[]> // = ProjectManifest.pages
}

// ---- transaction engine (turn-durability §4) ----------------------------------
export interface ProjectWritePermit {
  readonly permitId: string
}
export interface WriteMutex {
  acquire(): Promise<ProjectWritePermit> // FIFO fair
  release(permit: ProjectWritePermit): void
}
export interface TransactionEngine {
  /** Prepare payloads + plan; returns a prepared handle (no target changed yet). */
  prepare(
    permit: ProjectWritePermit,
    plan: TransactionPlanInput,
  ): Promise<JournalCorruptError | StorageLimitExceededError | PreparedTransaction>
  /** Domain wrappers (turn-durability §6–§11); each is prepare+CAS+intent+roll-forward. */
  runProjectMutation(permit: ProjectWritePermit, input: ProjectMutationInput): Promise<TxOutcome>
  runTurnAdmission(permit: ProjectWritePermit, input: TurnAdmissionInput): Promise<TxOutcome>
  finalizeTurn(permit: ProjectWritePermit, input: TurnFinalizeInput): Promise<TxOutcome>
  terminalizeTurn(permit: ProjectWritePermit, input: TurnTerminalizeInput): Promise<TxOutcome>
  publishExport(permit: ProjectWritePermit, input: ExportPublishInput): Promise<TxOutcome>
  runMigration(permit: ProjectWritePermit, input: MigrationInput): Promise<TxOutcome>
  /** Startup roll-forward before Workspace opens (§10.2 / §12). */
  recover(permit: ProjectWritePermit): Promise<RecoveryOutcome>
}
export type TxOutcome =
  | { ok: true; committed: CommittedMarker }
  | { ok: false; error: SourceChangedError | StaleError | TransactionRecoveryConflictError
      | TransactionIoPendingError | JournalCorruptError | StorageLimitExceededError
      | RestoreRecordConflictError | ExportStaleError | MigrationStaleError | MigrationBackupFailedError }
export type RecoveryOutcome =
  | { ok: true; recovered: number }
  | { ok: false; conflict: TransactionRecoveryConflictError | JournalCorruptError | JournalTooNewError }

// ---- trust (storage §8) -------------------------------------------------------
export interface TrustStore {
  buildSubject(root: AbsPath, projectId: string, git: GitIdentity | null): Promise<SafeFsError | TrustSubject>
  isGranted(subject: TrustSubject): Promise<boolean>
  grant(subject: TrustSubject): Promise<UnsupportedDurabilityError | void>
}

// ---- projections (projections §6, §7, §10, storage §7) ------------------------
export interface ProjectionStore {
  pageMetaGet(key: PageMetaKey): Promise<PageMetaEntry | null> // miss on any mismatch
  pageMetaPut(entry: PageMetaEntry): Promise<void> // atomic; never mutates portable state
  diagnosticsGet(key: DiagnosticsKey): Promise<DiagnosticsEntry | null>
  diagnosticsPut(entry: DiagnosticsEntry): Promise<void>
  renderGet(key: ExportRenderKey): Promise<RenderEntry | null>
  renderPut(entry: RenderEntry): Promise<void>
}

// ---- staging (turn-durability §6.2, projections §9) ---------------------------
export interface StagingStore {
  createTurnWorkspace(input: CreateTurnWorkspaceInput): Promise<WorkspaceCollisionError | SafeFsError | TurnWorkspace>
  snapshotCandidate(workspace: TurnWorkspace): Promise<WorkspaceChangedDuringSnapshotError | SafeFsError | CandidateRef>
}
```

Supporting value types (`ProjectManifest`, `WorkspaceLocalState`, `SessionCheckpoint`,
`TransactionPlan`, `DiagnosticsKey`, `ExportRenderKey`, `PageMetaKey`, `GitIdentity`,
`TrustSubject`, cursors, wrapper inputs) are defined in the owning submodule's `types.ts`
and re-exported from `store/index.ts`. Key ones fixed by spec:

```ts
export interface ProjectManifest {
  readonly formatVersion: 1
  readonly projectId: string
  readonly name: string
  readonly createdAt: string
  readonly targetStack: "rust-ratatui" | "go-bubbletea" | "js-opentui" | "generic"
  readonly pages: readonly PageSlug[] // ordered, duplicate-free
}
export interface SessionCheckpoint {
  readonly chatId: string
  readonly sessionScopeId: string
  readonly sessionId: string // backend opaque
  readonly recordCount: number // complete records after the header
  readonly prefixHash: Sha256Hex // SHA-256 of header line + recordCount record lines, each incl. LF
}
export interface DiagnosticsKey {
  readonly pageSlug: string
  readonly sourceHash: Sha256Hex
  readonly kitApiVersion: number
}
export interface PageMetaKey {
  readonly pageSlug: string
  readonly sourceHash: Sha256Hex
  readonly extractorVersion: number
}
export interface ExportRenderKey {
  readonly sourceHash: Sha256Hex
  readonly kitApiVersion: number
  readonly rendererVersion: string
  readonly size: { readonly width: number; readonly height: number }
  readonly theme: string
  readonly flags: Record<string, boolean | number | string> // sorted canonical encoding
}
export interface GitIdentity {
  readonly canonicalGitCommonDir: string
  readonly gitCommonDirFilesystemIdentity: string
  readonly projectPathRelativeToWorktreeRoot: string
}
```

---

## Tasks (TDD, dependency-ordered)

Legend: **[P]** = parallelizable (independent file set, no dependency on an unlanded
task in the same wave). Each task: files · normative spec · hostile / fault-injection
tests. The fault-injection harness (T14) is the test authority for every durability
boundary (turn-durability §14.1); the TrustSubject vectors (T8) and JSONL repair
classification (T10) are their own authorities.

### Wave A — pure vocabulary + domain-free primitives (all [P])

- [ ] **T1 [P] — `entities/chat`** · storage §11.2, turn-durability §6.1. Land the
  types above + `model/decode.ts` (header/record decoders: `kind` discrimination,
  `isCanonicalUuidv7` on every id, RFC-3339 `ts`, XOR of `turnId`/`actionId` on system
  records, `system:restore` recognized but note "no writer"). Tests: every record kind
  round-trips; missing `turnId` on a `user` record → schema-invalid; both `turnId` and
  `actionId` on a system record → invalid; unknown `kind` → invalid.
- [ ] **T2 [P] — `entities/pin`** · storage §11.2. Types above + `model/decode.ts` with
  `foldPins(events)`. Tests (incl. property test): fold arbitrary valid event streams →
  latest file-order status wins independent of `ts`/UUID order; second `pin:created` for
  one `pinId` → corruption; `pin:status` before `pin:created` → corruption; reopen/resolve
  transitions fold correctly.
- [ ] **T3 [P] — `infrastructure/fs/ffi.ts` + `reparse-check.ts`** · Spike F. `dlopen`
  `kernel32` (`GetFileAttributesW`, `GetDriveTypeW` here; `CreateFileW`/`FlushFileBuffers`
  in T4); the UTF-16LE arg helper (`Buffer.from(s + "\0","utf16le")` + `ptr()`, NOT
  `FFIType.cstring` — Spike G trap). `isReparsePoint(absPath)` = `GetFileAttributesW` &
  `FILE_ATTRIBUTE_REPARSE_POINT`. Tests (Windows): a junction (`mklink /J`) → `true`; a
  plain dir/file → `false`; nonexistent path → typed error. Verified in a compiled binary
  (`import.meta.dir` trap — use `process.cwd()`).
- [ ] **T4 [P] — `infrastructure/fs/durable-fs.ts`** · Spike G, turn-durability §4.2.
  `installFile(absPath, bytes)` = the 6-step (create-new temp → write+flush+close →
  `lstatSync`+reopen-verify size/sha256 → `renameSync` replace → `flushDir` →
  reopen-verify realized `FileImage`); `deleteFile(absPath, oldImage)`; `flushDir(absDir)`
  = `CreateFileW(FILE_FLAG_BACKUP_SEMANTICS, GENERIC_WRITE)` **alone** +
  `FlushFileBuffers`; `probeDurability(absDir)` = `GetDriveTypeW` reject `DRIVE_REMOTE`
  **and** a real flush probe (`ERROR_INVALID_FUNCTION` → `UnsupportedDurabilityError`).
  Expose a **test-only crash injector** keyed by boundary (`payload-flush`,
  `install+dir-flush`, `verify`, …) that terminates before returning — the substrate T14
  drives. Tests: install/replace/delete round-trip; `GENERIC_READ` reproduces the
  `ERROR_ACCESS_DENIED` fault (regression guard); UNC/loopback share → `probeDurability`
  fails; median-latency smoke (documented ~19 ms, not asserted tight).
- [ ] **T5 [P] — `infrastructure/fs/fs-identity.ts`** · Spike F §8. `statIdentity(absPath)`
  = `statSync(path, { bigint: true })` → `{ dev, ino }` (**bigint mandatory** — 64-bit
  file id); `formatIdentity(platform, dev, ino)` → `unix:<dev-dec>:<ino-dec>` (no leading
  zeroes) or `windows:<serial-8hex-lower>:<file-id-hex-lower>` (serial exactly 8 hex;
  file-id variable-length lower-hex, no leading zeroes). Tests: `dev` renders 8-hex and
  matches `vol C:`; `ino` stable across a file create + editor-style atomic rename inside
  the dir; format has no leading zeroes; short (<8-byte) NTFS file-id is a valid encoding.

### Wave B — SafeProjectFs + lease (depend on Wave A fs primitives)

- [ ] **T6 — `store/safe-fs`** · storage §4/§5, turn-durability §5, Spike F. Depends T3,
  T4. `path-rules.ts` (§5.1 rejections: empty/NUL/control, `.`/`..`, POSIX-abs,
  drive-rooted/relative, UNC, `\\?\`/`\\.\` device ns, backslash/alt-separator, colon/ADS,
  trailing dot/space, reserved device names, >240 UTF-8 bytes / >16 components / >120-byte
  component, NFC+case-fold collisions). `no-follow.ts` (per-component open relative to the
  opened parent + `isReparsePoint` reject at each component + `realpathSync(joined)` vs
  `realpathSync(root)` prefix escape check). `leaf-identity.ts` (§5.2 regular-file,
  `nlink === 1` → else `unsafe_hardlink`, reject FIFO/socket/device/reparse-dir).
  `limits.ts` (§5.3 table — checked before allocation AND while streaming). `candidate.ts`
  (§5.4 open-source-once → record id/nlink/size/mtime → hash while streaming to a
  create-new destination → recheck source identity → `workspace_changed_during_snapshot`
  on drift). `SafeProjectFs` is rooted at an opened handle (`.termcraft`, a turn
  workspace, a candidate, an export candidate, or a backup) — never a string join. Hostile
  tests (turn-durability §14.5): every path-class rejection; a planted junction escape
  caught (naive `join` proven insufficient in the same test); every reparse-tag component;
  hardlinked intake; each limit at boundary and one byte over; a semantically-hostile
  workspace passes **zero** bytes to any consumer.
- [ ] **T7 [P w/ T6] — `store/lease`** · storage §9, §14.5. Non-blocking exclusive OS lock
  on an open `.termcraft/lock` handle held for process lifetime; on fail →
  `LeaseHeldError` + bounded advisory metadata (labeled advisory, never ownership);
  crashed-owner path re-acquires the existing file and rewrites diagnostics **while
  holding the lock**; never deletes/steals by PID. Tests: two real processes contend →
  exactly one holds (spawn a second `bun` child); abrupt termination releases the OS lock
  though the file remains; a forged/absent/reused PID never authorizes takeover.

### Wave C — TOML + JSONL (depend on Wave B safe-fs/durable)

- [ ] **T8 [P] — `store/trust`** · storage §8, Spike F §8. Depends T5. `subject.ts` =
  byte-exact `TrustSubjectV1`: prefix `termcraft-trust-subject-v1` + `0x00`, then each
  field as `u32be(NFC-UTF8 length) || NFC-UTF8 bytes` in order (canonical project path;
  fs-identity string; lowercase project UUID; literal tag `absent`|`present`; then for
  `present`: canonical git common-dir, its fs-identity string, NFC repo-relative project
  path). Canonical paths use `/`, preserve resolved case except uppercase Windows drive
  letter, no trailing separator except root. Digest = lowercase hex SHA-256.
  **Normative fixtures (proven exact this session — reproduce as tests):**
  - Unix/no-Git `/home/alice/project` · `unix:2049:123456` ·
    `0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10` · `absent`
    → `d4e6fdfbde06ba486ac28297a4a55e0eaaf086fdfb70ba6302e162afb12ad6a9`
  - Windows/Git `C:/work/termcraft` ·
    `windows:1a2b3c4d:00112233445566778899aabbccddeeff` ·
    `0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d11` · `present` · `C:/work/.git` ·
    `windows:1a2b3c4d:ffeeddccbbaa99887766554433221100` · `termcraft`
    → `3912b4962af0420f5c76cd2890d90369815af23768f3b3cffd3b5127ec3824b1`

  `trust-store.ts` = machine-local ledger under `{userStateRoot}` (its own SafeProjectFs
  root + DurableFs writes). Tests: both vectors byte-exact; alias paths resolving to the
  same canonical object match one subject; path move / dir replacement / `projectId`
  change / Git init+replace / worktree-path change → new subject (no grant); `HEAD`/branch/
  commit change → **same** subject (grant survives).
- [ ] **T9 — `store/toml`** · storage §5.1, §6.1, §13. Depends T6, T4. `project-toml.ts`
  (format_version=1, exactly the five semantic fields; newer `format_version` → hard
  `ManifestTooNewError` naming the file; reject any non-portable field). `workspace-toml.ts`
  (§6.1 fields incl. resource-limit overrides validated in-range; missing file →
  deterministic defaults without touching portable state; corrupt file → preserve+report,
  in-memory defaults, never copied to portable). `gitignore.ts` (anchored rules mirroring
  `StoragePathPolicy` incl. `/transactions.local/`, `/**/.termcraft-tx-*.tmp`, `cache/`,
  `diagnostics/`, `logs/`, `workspace.local.toml`, `*.local*`). Tests: portable snapshot
  proves target stack + page order travel while active page/chat/backend/preview do **not**
  (§16.1); out-of-range override → invalid; corrupt local preserved+ignored.
- [ ] **T10 — `store/jsonl` codec + reader** · storage §11.1/§11.3, projections §7.2.
  Depends T1, T2, T6. `line-codec.ts` (UTF-8/no-BOM/LF; physical line ≤ 1,048,576 B incl.
  LF → serialized object ≤ 1,048,575 B; oversize → reject before mutation with measured
  vs allowed). `reader.ts` streams from byte zero, validates the header, exposes only
  complete LF-terminated valid records, retains last valid offset + count + incremental
  prefix hash, and classifies the tail into **exactly the three §11.3 cases**:
  (1) transaction-proven append interruption (empty / complete / exact-leading-prefix of
  the planned append) — the **only** automatic truncation, and only under a matching
  prepared plan; (2) unproven corrupt suffix → return valid prefix read-only + mutation-lock
  + report path/last-offset/last-recordId/suffix-bytes/suffix-sha256; (3) mid-file
  corruption (a valid record after corruption, or an identity/reference violation in the
  prefix) → hard error, no partial open, no truncate. Tests (storage §16.4): line exactly
  1 MiB passes, one byte over fails without buffer growth or mutation; valid JSON without
  final LF = uncommitted suffix; invalid UTF-8 / malformed final JSON / blank line /
  duplicate `recordId` / valid-record-after-corruption each map to the specified class;
  multibyte UTF-8 chunk boundaries; **only** an exact prepared plan triggers truncation
  (wrong base length / prefix hash / append hash / partial bytes cannot).
- [ ] **T11 [P w/ T12] — `store/jsonl` chat-index** · projections §7. Depends T10.
  `ChatIndex`: streaming valid-prefix build (1 MiB buffer + ≤ 1 record line); stores only
  `recordId`, optional `turnId`, `ts`, `changedPages`, and structural byte/offset/
  generation/checksum metadata (never bodies/pins/warnings/Git ids); ≤ 512-entry
  checksummed pages, ≤ 8 resident; `loadTail`/`loadBefore` read only selected canonical
  byte ranges (default 100 / max 200 records / 8 MiB); append fast-path vs
  truncation/branch generation rebuild from byte zero. Tests: 100k-record fixture with
  bounded resident memory; partial-final-line, truncation, and same-length-branch variants
  force rebuild; backward pagination follows byte offsets; a single oversized record
  returns alone.
- [ ] **T12 [P w/ T11] — `store/jsonl` checkpoint** · storage §6.2. Depends T10.
  `SessionCheckpoint` prefix hash over header + `recordCount` record lines (each incl. LF);
  resume gate: chat has ≥ `recordCount` valid records AND identical prefix hash → additional
  valid records are the permissible suffix/delta; any mismatch (shorter file, changed
  prefix, identity mismatch, different scope) → no re-resume; caller starts fresh + seeds
  ≤ 32 records / 64 KiB (drop oldest whole records first). Tests: unchanged prefix + extra
  records → delta; each mismatch class → fresh-seed signal; seed bound exactly 32 / 64 KiB
  with whole records only.

### Wave D — transaction engine (the crux; depends on Waves B/C)

- [ ] **T13 — `store/transaction` plan + engine** · turn-durability §3.3, §4.3, §4.4.
  Depends T4, T6, T10. `plan.ts` (canonical sorted-key JSON for `plan.json`; `FileImage`
  `absent`|`{file,sha256,size}`; `TransactionOperation` `replace`|`delete`|`append-jsonl`
  with `oldImage`/`newImage`/`payloadId`/`append{beforeLength,beforePrefixSha256,
  appendedPayloadId,appendedSha256,appendedLength,recordIds,domainIdentity?}`; plan hash in
  every marker). `write-mutex.ts` (§4.5 FIFO fair `ProjectWritePermit` with a random id;
  every mutating call checks it is still the active permit; release invalidates → a stale
  async continuation cannot write). `engine.ts` (§4.3 protocol: acquire permit → write+verify
  payloads → write+flush `plan.json` → re-check preconditions → write+flush `intent.json`
  = **point of no rollback** → per-operation apply in `index` order with §4.4 JSONL
  append classification → verify realized images → write+flush `committed.json`). Durable
  state machine: `building → prepared → intended → applying → record-pending → committed →
  conflict`. Tests: create/replace/delete/multi-file plans; old-image/new-image/neither
  branches; ambiguous install-before-marker; corrupt plan / missing / wrong payload hash /
  too-new journal; FIFO fairness + invalidated-permit rejection + stale-writer denial.
- [ ] **T14 — `store/transaction` recovery + crash harness** · turn-durability §4.6,
  §10.2, §14.1. Depends T13. `recovery.ts` scans `transactions.local/` in stable lexical
  UUID order and classifies **before** touching targets — the four §10.2 branches: valid
  plan+payloads no `intent` → **discard** (no target compare); valid `intent` no valid
  `committed` → **roll forward** op-by-op; valid `committed` → **recognize complete**, do
  not compare targets; invalid plan/payload/marker/identity/path/size/hash → **stop** with
  `JournalCorruptError`, write nothing. Full §4.6 decision table incl. the JSONL
  old-prefix / exact-new / leading-partial-truncate / conflict rows. Build the **mandatory
  fault-injection harness**: for every wrapper × every physical boundary (§14.1 list),
  terminate the test process without cleanup, reopen, run recovery, and assert the managed
  tree equals the exact pre-intent OR exact committed state — never a mixed/overwritten
  state, never a duplicate append identity. Tests: before/after/empty-append/exact-partial/
  complete-without-ack/changed-target/missing-payload/bad-hash/corrupt-intent each hit
  their distinct branch; startup order with several prepared+intended+committed+conflict
  journals; committed-then-legitimate-later-drift not treated as conflict.
- [ ] **T15 — `store/transaction` domain wrappers** · turn-durability §6–§8, §7.4–§7.6.
  Depends T14. `TurnTransaction` (admission appends the user record before any agent
  process; finalization = changed canonical pages + `project.toml.pages` derived from the
  validated **`pages.json`** (see reconciliation below) + optional `workspace.local.toml`
  active-page replacement + one agent record + append-only `pin:status resolved` per
  resolved sent pin, in that canonical operation order; terminalization = one system
  record only; the §7.5 pre-intent CAS over the full send-time read set →
  `source_changed`/`stale`). `project-mutation` (project creation, local-state write,
  title edit, standalone pin event, explicit JSONL repair). `RestoreTransaction` /
  `ExportPublishTransaction` / `MigrationTransaction` **infrastructure built and unit-tested
  here, but MVP registers no caller for Restore** (see deferred). Tests: user record durable
  before "launch"; empty diff → `changedPages: []`, one agent record, **no** pin resolution;
  failed/cancelled/stale/interrupted → no pin resolution; a hook/external drift in
  canonical/manifest/chat/pins → typed stale, no overwrite; orphan scan terminalizes once
  and rejects duplicate/cross-chat `turnId`.

### Wave E — external stores + projections (depend on Waves B/C/D)

- [ ] **T16 [P] — `store/sandbox`** · storage §4/§6.2, turn-durability §6.2, projections §9.
  Depends T5, T6. `project-key.ts` = lowercase-hex SHA-256 over
  `UTF-8(canonicalProjectRoot) || 0x00 || UTF-8(projectId)` (no salt, no temp fallback).
  `staging-store.ts` = `{userStateRoot}/sandboxes/<projectKey>/turns/<turnId>/workspace`
  create-new (existing path → `WorkspaceCollisionError`, never clear+reuse); all listed
  pages + `pages.json` + `RUNTIME.md` + runtime `.d.ts` copied while hashing (§7.2 read
  set); `turn.json` machine-local metadata. Tests: `projectKey` deterministic + distinct
  for same-basename different-root; collision refused; all-pages copy writes exactly `S`
  bytes once with no hardlinks (projections §16.3).
- [ ] **T17 [P] — `store/migration`** · storage §12, turn-durability §11. Depends T4, T6,
  T8-independent. `registry.ts` = **empty** migration chain + per-kind format-counter
  reads + newer-than-binary → hard error naming the file. `backup-store.ts` = the §12
  verified-backup protocol under `{userStateRoot}/backups/{projectId}/{migrationActionId}/`
  (copy → manifest → flush → reopen+verify length/sha256 vs source & manifest → write
  `VERIFIED` last). Tests (turn-durability §14.8): a synthetic test-only migration runs
  through the live infra (backup→verify→transform→`MigrationTransaction`); backup
  copy/hash/manifest failure leaves sources untouched; source drift during backup →
  `migration_stale`; Git presence never waives backup; the empty-chain assertion (no
  shipped migration exists).
- [ ] **T18 [P] — `store/projections`** · storage §7, projections §6/§10. Depends T4, T6.
  `page-meta-cache.ts` (key `(pageSlug, sourceHash, extractorVersion)`; hit only on exact
  match; miss → re-extract + atomic replace; never falls back to a different source hash;
  hard-excluded from Git). `diagnostics-store.ts` (key `(pageSlug, sourceHash,
  kitApiVersion)`; 128 MiB default quota, LRU across unpinned keys; no chat id). 
  `render-cache.ts` (content-addressed `ExportRenderKey`; temp-sibling + create/rename;
  512 MiB default quota). All projections: temp-write→checksum→rename; corrupt/missing =
  rebuild; never a portable write; classified local + rejected by Git scopes. Tests
  (storage §16.5, projections §17): exact-key hit; any one-key change → miss + rebuild;
  malformed entry → miss; store-generation bump rebuilds without a portable write.

### Wave F — assembly

- [ ] **T19 — `store/types.ts` + `store/index.ts` + integration** · all specs. Depends all.
  Finalize the port contracts (above) + shared error vocabulary; `index.ts` exposes the
  factory the composition root calls (constructs each store with injected `DurableFs`,
  `ReparseCheck`, `FsIdentity`, `Clock`, `uuidv7`, `{userStateRoot}`). Land the
  **existing-project-launch** integration test (storage §14.1 / turn-durability §12
  ordering: lease → durability adapter + SafeProjectFs → journal format → recover
  transactions → migrations → schemas → orphan turn scan → load stores → open) and the
  **new-project creation** test (§14.2: one `project-mutation` mints `projectId` + format-1
  layout + gitignore + workspace file + first chat header, then records the implicit trust
  grant). Full crash-injection sweep across project creation, one-file replace, multi-page
  finalization, chat/pin append, local-state update, and (infra-only) export/migration.

---

## Deferred / cross-phase

- **`pages.json` vs `project.toml.pages` reconciliation (phase 3 T5 gap).** These are two
  distinct artifacts and phase 4 must not conflate them:
  - `project.toml.pages` (storage §5.1) is the **portable, durable** ordered page-slug
    array — the listing/tab order. Written by `store/toml` and by turn finalization.
  - `pages.json` (SafeProjectFs §5.3 limits; turn-durability §7.4.2) is the **agent
    workspace manifest slice** — the transient page inventory the agent proposes inside
    its turn workspace/candidate. The **Gate** (phase 3 T5) validates the candidate's
    `pages.json`; **turn finalization** (T15) derives `project.toml.pages` from the
    *validated* `pages.json`. Phase 3's plan says "pages.json schema authority is
    storage-identity (phase 4)": that schema is the agent-workspace manifest, owned here as
    a `store/sandbox` + `store/toml` translation input, **never** written as a portable
    file. Document this in `store/toml` and `store/sandbox`.
- **Phase 6 (`core/`) consumes** the `store/types.ts` port shapes lifted verbatim into
  `core/ports/`; the composition root injects the store implementations. `core` owns the
  Reatom turn/export/preview/startup state machines, the 120 s silence watchdog + 30 min
  absolute deadline (projections §12), and the orchestration that calls
  `runTurnAdmission`/`finalizeTurn`/`recover`. This phase provides the values, not the
  timers/state machines.
- **MVP out of scope (build the engine, not the caller / or skip entirely):**
  - **Restore** (roadmap Out-of-scope): `ChatSystemRestoreRecord` is defined for reader
    completeness; `RestoreTransaction` + the `record-pending` rebase marker are built and
    unit-tested as transaction infrastructure (they exercise the durable-rebase path), but
    **no MVP command invokes them** and no `system:restore` record is written.
  - **Git commit scope** (`/commit-*`, `GitHistory`, `GitCommitter`, `StoragePathPolicy` as
    a live commit planner) — out of MVP; the generated `.gitignore` (T9) and the
    hard-exclusion path list are still produced (they are storage output), but no Git
    adapter is built here. `entities/chat` keeps `changedPages` as slug lists (never Git
    correlation).
  - **Export publication** (`ExportPublishTransaction`) infrastructure is built + unit
    tested (§10) so phase 6 can drive it, but the render pool / size ladder live in phase 6.
  - **Migration beyond the empty live chain** — no shipped migration exists (storage §12);
    the abandoned numbered-page/`cN`/`config.toml`/cached-meta/PID-stale designs get no
    reader.
  - **`OperationsLog`** (projections §13) is deferred — its taxonomy/redaction/rotation are
    explicitly not owned by storage (§11.2) and belong to a later observability slice; not
    built in phase 4.
  - **Copy-on-write staging accelerator** (projections §9) — deferred behind the benchmark
    gate; T16 ships the baseline streaming copy only.

---

## Unresolved contract questions (confirm before implementation)

Places where the specs underspecify a type shape and I made a judgment call — the
orchestrator should confirm these:

1. **`agent` record `warnings` shape.** Storage §11.2 / turn-durability §7.4 say the agent
   record stores "Gate warnings" and the §6.1 example shows `"warnings":[]`, but no field
   schema is pinned. I chose a minimal decoupled `ChatWarningSnapshot { kind: string;
   message: string }` (entities import no adapter, so it cannot reuse gate's `GateWarning`
   with `line`/`column`). **Confirm** whether the stored snapshot should also carry
   `line`/`column` (mirroring `GateWarning`) or stay minimal.
2. **`system:cancelled` / `system:error` `turnId` vs `actionId`.** §11.2 says "related
   `turnId` or `actionId`". I modeled both as optional with a decoder-enforced XOR. For
   MVP turns only `turnId` is ever populated. **Confirm** the XOR modeling (vs. a tagged
   union split on which id is present).
3. **`system:cancelled` `text` field.** §11.2 lists `text` for `system:error` explicitly
   but is terser for `system:cancelled`; §6.1 shows `text` on the error example only. I
   included `text: string` on `system:cancelled` by analogy. **Confirm** it is required (vs
   optional/absent).
4. **fs-identity string placement.** I placed the `unix:`/`windows:` identity-string
   formatting in `infrastructure/fs` (domain-free) and the `TrustSubjectV1` assembly in
   `store/trust`. The string format is *named* by storage §8, which is arguably a storage
   concern. **Confirm** the split (vs. moving `formatIdentity` into `store/trust`). Both
   satisfy the DAG; this is a taste call on the domain-free boundary.
5. **`WorkspaceLocalState` field-name spellings + `ResourceLimitOverrides` key set.** §6.1
   enumerates the fields prose-style (active page/chat, backend/model/effort, preview size
   mode + custom w/h, theme override, color-capability sim, static/interactive, fullscreen
   flag, session checkpoints, and the projections §12/§10/§6 override keys) but gives no
   exact TOML key names. I will name them in `store/toml/types.ts` at implementation time
   following the prose; **flag** if a specific serialized key spelling must match an
   external consumer (none known in phase 4).
