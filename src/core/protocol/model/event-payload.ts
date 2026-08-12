import { z } from "zod";

import type {
  CommitAction,
  CommitState,
  ExportAction,
  ExportState,
  MigrationAction,
  MigrationState,
  PreviewAction,
  PreviewState,
  ProjectAction,
  ProjectState,
  RestoreAction,
  RestoreState,
  TurnAction,
  TurnState,
} from "core/machines";
import { pageSlugSchema } from "entities/page";
import type { AgentToolOp } from "entities/turn";
import { rfc3339UtcSchema } from "infrastructure/clock";

import { type CapabilityTargetByKindV1, capabilityTargetByKindV1Schema } from "./capability-target";
import { type ChatRecordDtoV1, chatRecordDtoV1Schema } from "./chat-record";
import { type CommandKindV1, commandKindV1Schema } from "./command-kind";
import type { EventKindV1 } from "./event-kind";
import { type FailureDtoV1, failureDtoV1Schema } from "./failure";
import {
  type HostNonce,
  type Sha256Hex,
  type UUIDv7,
  hostNonceSchema,
  sha256HexSchema,
  uuidv7Schema,
} from "./ids";
import {
  type ChatPageCursorDtoV1,
  type DiagnosticDtoV1,
  type FrameIdentityV1,
  type FrameTokenV1,
  type GeometryTokenV1,
  type PageDescriptorChangeV1,
  type PageDescriptorV1,
  type PageRemovePlanV1,
  type PinDtoV1,
  chatPageCursorDtoV1Schema,
  diagnosticDtoV1Schema,
  frameIdentityV1Schema,
  frameTokenV1Schema,
  geometryTokenV1Schema,
  pageDescriptorChangeV1Schema,
  pageDescriptorV1Schema,
  pageRemovePlanV1Schema,
  pinDtoV1Schema,
} from "./shared-dto";
import { type UInt64String, uint64StringSchema } from "./uint64";
import { type UnavailableReason, unavailableReasonV1Schema } from "./unavailable-reason";

/**
 * The 43 closed `EventPayloadByKindV1` payload schemas (kernel-command-contract §9,
 * table at KCC:791-829). Every schema is `z.strictObject` and every nullable field is
 * `.nullable()`, never `.optional()` — the same rules as `shared-dto.ts`, because §9
 * states "Unknown payload keys are invalid" and "fields marked nullable carry JSON
 * `null`, not omission" for this contract too.
 *
 * Several event kinds share one payload TYPE by the spec's own map (KCC:715-759):
 * `turn.completed`/`turn.failed`/`turn.cancelled` -> `TurnTerminalPayloadV1`,
 * `restore.completed`/`restore.failed` -> `RestoreTerminalPayloadV1`,
 * `commit.completed`/`commit.failed` -> `CommitTerminalPayloadV1`,
 * `export.completed`/`export.failed` -> `ExportTerminalPayloadV1`,
 * `preview.backpressured`/`preview.writable` -> `PreviewBackpressurePayloadV1`.
 * Each such type/schema is defined exactly once below and mapped twice in
 * `eventPayloadV1SchemaByKind`.
 *
 * Git-produced identifiers (a full commit id, a blob/content hash) are typed as plain
 * `string`, mirroring the one place the spec gives their concrete TS shape —
 * `{ pageSlug: string, sourceCommit: string }` for `preview.selectHistorical` and
 * `restore.plan` (KCC:885, KCC:894). They are deliberately NOT `Sha256Hex`: that brand
 * is reserved for termcraft's own canonical page-content `sourceHash` (fixed in
 * `shared-dto.ts` and used throughout this file for that one concept), and Git's own
 * object ids/hashes are a different, externally-produced value. They are, however,
 * validated at Git's two object-id lengths (see `fullGitObjectIdSchema` below) — the
 * spec repeats the word "FULL" for exactly these fields, which a bare non-empty
 * string does not enforce.
 *
 * Several fields originally depended on DTOs slice 6A did not build yet: the seven
 * Reatom state machines and their capability projection (6C), and Git's status
 * projection (no owning slice is named yet). 6C has since landed (kernel-assembly
 * plan, WP-1 task 2, 2026-07-23): `kernel.snapshot`'s seven model DTOs,
 * `kernel.stateChanged`'s `action`/`previousTag`/`nextTag` unions, and the
 * capability-entry `target` are now closed, real types built from the machines'
 * own exported phase/action unions (`core/machines`) and Task 1's
 * `CapabilityTargetByKindV1` (`./capability-target.ts`). Only Git's status
 * projection remains a `*Placeholder` type with its own `TODO` comment — no owning
 * slice is named for it yet.
 */

// ---------------------------------------------------------------------------
// FailureDtoV1 — the closed schema owned by ./failure
// ---------------------------------------------------------------------------

// §9 states that "The type names in `EventPayloadByKindV1` are closed DTO schemas", so
// every terminal payload below carries the real closed failure object: the 30-member
// §11.2 code enum and the bounded primitive-only details record. An open placeholder
// here would let an arbitrary code and a nested object through on exactly the payloads
// §11.2 protects — the ones that must never carry a native Error or unbounded output.

// ---------------------------------------------------------------------------
// Small shared building blocks
// ---------------------------------------------------------------------------

const nonNegativeIntSchema = z.number().int().nonnegative();
const positiveIntSchema = z.number().int().positive();

/** Attempts are integers 1 through 4 (§7.2, KCC:241: "Attempts are integers 1 through 4"). */
const turnAttemptV1Schema = z.number().int().min(1).max(4);

/**
 * A full Git object id, per KCC's own concrete typing of `sourceCommit` (see file
 * header). The spec says "FULL source commit id" repeatedly (KCC:804, KCC:807) to
 * contrast with the abbreviated hex prefixes Git itself accepts elsewhere; validated
 * here as lowercase hex at Git's two object-id lengths — 40 characters (the default
 * `sha1` object format) or 64 (the newer `sha256` object format, `git init
 * --object-format=sha256`). Both lengths are accepted because the spec does not fix
 * which object format a termcraft-managed repository uses.
 */
const FULL_GIT_OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const fullGitObjectIdSchema = z.string().regex(FULL_GIT_OBJECT_ID);

// ---------------------------------------------------------------------------
// kernel.snapshot / kernel.stateChanged / kernel.capabilitiesChanged
// ---------------------------------------------------------------------------

/**
 * The seven `reatom*StateMachine` state-atom names, transcribed verbatim from §6's
 * factory table (KCC:170-176). This part of `kernel.stateChanged`'s `modelId` is
 * fixed today; `action`/`previousTag`/`nextTag`/`metadata` are not (see below).
 */
const KERNEL_MODEL_IDS_V1 = [
  "kernel.project.state",
  "kernel.turn.state",
  "kernel.restore.state",
  "kernel.commit.state",
  "kernel.export.state",
  "kernel.preview.state",
  "kernel.migration.state",
] as const;

export type KernelModelIdV1 = (typeof KERNEL_MODEL_IDS_V1)[number];
const kernelModelIdV1Schema = z.enum(KERNEL_MODEL_IDS_V1);

/**
 * The seven machines' phase unions, transcribed here as literal arrays and checked
 * against each machine's real exported `*State` type with `satisfies` — the same
 * technique this file already uses for `AGENT_TOOL_OPS_V1`/`GATE_ERROR_KINDS_V1`
 * above. `core/protocol` cannot import a RUNTIME array of these from `core/machines`
 * (none of the seven files exports one, only the type), so each array below is a
 * verbatim copy of that file's own union, and `satisfies` fails `tsc` if a member is
 * added, dropped, or misspelled here relative to the real type. Same known limit as
 * every other transcription of this kind in this file: `satisfies` does NOT catch
 * the real type gaining a member this array forgets to add — there is no test in
 * this file (or its established precedent, `AGENT_TOOL_OPS_V1` etc.) that closes
 * that direction either.
 */
const KERNEL_PROJECT_STATES_V1 = [
  "closed",
  "opening",
  "recovering",
  "ready",
  "blocked",
  "closing",
] as const satisfies readonly ProjectState[];

const KERNEL_TURN_STATES_V1 = [
  "idle",
  "admitting",
  "workspace-ready",
  "running",
  "stopping",
  "snapshotting",
  "validating",
  "finalizing",
  "committed",
  "terminalizing",
  "terminal",
  "backend-unhealthy",
] as const satisfies readonly TurnState[];

const KERNEL_RESTORE_STATES_V1 = [
  "idle",
  "planning",
  "awaiting-confirmation",
  "executing",
  "record-pending",
  "recovering",
  "blocked",
] as const satisfies readonly RestoreState[];

const KERNEL_COMMIT_STATES_V1 = [
  "idle",
  "planning",
  "awaiting-confirmation",
  "executing",
  "refreshing",
] as const satisfies readonly CommitState[];

const KERNEL_EXPORT_STATES_V1 = [
  "idle",
  "preparing",
  "rendering",
  "publishing",
  "recovering",
  "blocked",
] as const satisfies readonly ExportState[];

const KERNEL_PREVIEW_STATES_V1 = [
  "disabled",
  "idle",
  "starting",
  "live",
  "switching",
  "failed",
  "circuit-open",
] as const satisfies readonly PreviewState[];

const KERNEL_MIGRATION_STATES_V1 = [
  "idle",
  "planning",
  "awaiting-confirmation",
  "backing-up",
  "transforming",
  "publishing",
  "recovering",
  "blocked",
] as const satisfies readonly MigrationState[];

/**
 * `kernel.stateChanged`'s `previousTag`/`nextTag` (§9, KCC:794). DESIGN CHOICE (the
 * task-2 brief explicitly left this open): a FLAT union over all seven machines'
 * phases, not a `modelId`-discriminated one. `modelId` (fixed above) already keys
 * which machine fired, so a reader branching on `modelId` narrows the tag itself; a
 * discriminated union would only re-key the same fact inside the tag type, at the
 * cost of wrapping every one of the seven phase sets a second time.
 */
export type KernelPhaseTagV1 =
  | ProjectState
  | TurnState
  | RestoreState
  | CommitState
  | ExportState
  | PreviewState
  | MigrationState;

const KERNEL_PHASE_TAGS_V1 = [
  ...KERNEL_PROJECT_STATES_V1,
  ...KERNEL_TURN_STATES_V1,
  ...KERNEL_RESTORE_STATES_V1,
  ...KERNEL_COMMIT_STATES_V1,
  ...KERNEL_EXPORT_STATES_V1,
  ...KERNEL_PREVIEW_STATES_V1,
  ...KERNEL_MIGRATION_STATES_V1,
] as const satisfies readonly KernelPhaseTagV1[];

const kernelPhaseTagV1Schema = z.enum(KERNEL_PHASE_TAGS_V1);

/**
 * `kernel.stateChanged`'s `action` (§9, KCC:794). Project's and Turn's OWN
 * `ProjectAction`/`TurnAction` types are bare verbs (e.g. `"beginCreate"`) — each
 * file's own header comment explains its table keys deliberately drop the
 * `kernel.<domain>.` prefix — while Restore/Commit/Export/Preview/Migration's
 * `*Action` types are already the full `kernel.<domain>.<verb>` form. The
 * wire-level action name is always the FULL form (matching `KernelModelIdV1`'s own
 * `"kernel.turn.state"` style, and `PROJECT_ACTION_FULL_NAME`/`TURN_ACTION_FULL_NAME`'s
 * own "for traceability" comment in their source files), so Project's and Turn's
 * members below are the template-literal form over the real verb union, not the
 * bare verb.
 */
type ProjectActionFullNameV1 = `kernel.project.${ProjectAction}`;
type TurnActionFullNameV1 = `kernel.turn.${TurnAction}`;

const PROJECT_ACTION_FULL_NAMES_V1 = [
  "kernel.project.beginCreate",
  "kernel.project.beginOpen",
  "kernel.project.beginRecovery",
  "kernel.project.finishOpen",
  "kernel.project.blockOpen",
  "kernel.project.setTrust",
  "kernel.project.renamePageTitle",
  "kernel.project.reorderPages",
  "kernel.project.beginPageRemovePlan",
  "kernel.project.confirmPageRemove",
  "kernel.project.discardPageRemovePlan",
  "kernel.project.beginClose",
  "kernel.project.finishClose",
  "kernel.project.retryOpen",
] as const satisfies readonly ProjectActionFullNameV1[];

const TURN_ACTION_FULL_NAMES_V1 = [
  "kernel.turn.beginAdmission",
  "kernel.turn.finishAdmission",
  "kernel.turn.beginAttempt",
  "kernel.turn.beginStopping",
  "kernel.turn.beginSnapshot",
  "kernel.turn.beginTerminalization",
  "kernel.turn.markBackendUnhealthy",
  "kernel.turn.candidateCaptured",
  "kernel.turn.retryAfterGate",
  "kernel.turn.retryAfterSessionFallback",
  "kernel.turn.beginFinalization",
  "kernel.turn.markCommitted",
  "kernel.turn.settle",
  "kernel.turn.finishTerminalization",
  "kernel.turn.confirmBackendHealthy",
  "kernel.turn.requestCancel",
] as const satisfies readonly TurnActionFullNameV1[];

const RESTORE_ACTIONS_V1 = [
  "kernel.restore.beginPlan",
  "kernel.restore.planReady",
  "kernel.restore.planFailed",
  "kernel.restore.confirm",
  "kernel.restore.discardPlan",
  "kernel.restore.markRecordPending",
  "kernel.restore.complete",
  "kernel.restore.failBeforeIntent",
  "kernel.restore.beginRecovery",
  "kernel.restore.retryRecord",
  "kernel.restore.blockRecovery",
  "kernel.restore.retryRecovery",
] as const satisfies readonly RestoreAction[];

const COMMIT_ACTIONS_V1 = [
  "kernel.commit.beginPlan",
  "kernel.commit.planReady",
  "kernel.commit.planFailed",
  "kernel.commit.confirm",
  "kernel.commit.discardPlan",
  "kernel.commit.beginRefresh",
  "kernel.commit.finishRefresh",
] as const satisfies readonly CommitAction[];

const EXPORT_ACTIONS_V1 = [
  "kernel.export.begin",
  "kernel.export.beginRendering",
  "kernel.export.beginPublication",
  "kernel.export.complete",
  "kernel.export.fail",
  "kernel.export.failBeforeIntent",
  "kernel.export.beginRecovery",
  "kernel.export.completeRecovery",
  "kernel.export.blockRecovery",
  "kernel.export.retryRecovery",
] as const satisfies readonly ExportAction[];

const PREVIEW_ACTIONS_V1 = [
  "kernel.preview.enable",
  "kernel.preview.beginStart",
  "kernel.preview.beginSwitch",
  "kernel.preview.sessionReady",
  "kernel.preview.sessionFailed",
  "kernel.preview.openCircuit",
  "kernel.preview.retryCircuit",
  "kernel.preview.setMode",
  "kernel.preview.setTweak",
  "kernel.preview.resize",
  "kernel.preview.setThemeCapabilities",
  "kernel.preview.forwardInput",
  "kernel.preview.queryGeometry",
  "kernel.preview.disable",
] as const satisfies readonly PreviewAction[];

const MIGRATION_ACTIONS_V1 = [
  "kernel.migration.beginPlan",
  "kernel.migration.planReady",
  "kernel.migration.planFailed",
  "kernel.migration.confirm",
  "kernel.migration.discardPlan",
  "kernel.migration.backupVerified",
  "kernel.migration.failBeforeIntent",
  "kernel.migration.beginPublication",
  "kernel.migration.complete",
  "kernel.migration.beginRecovery",
  "kernel.migration.completeRecovery",
  "kernel.migration.blockRecovery",
  "kernel.migration.retryRecovery",
] as const satisfies readonly MigrationAction[];

export type KernelStateActionV1 =
  | ProjectActionFullNameV1
  | TurnActionFullNameV1
  | RestoreAction
  | CommitAction
  | ExportAction
  | PreviewAction
  | MigrationAction;

const KERNEL_STATE_ACTIONS_V1 = [
  ...PROJECT_ACTION_FULL_NAMES_V1,
  ...TURN_ACTION_FULL_NAMES_V1,
  ...RESTORE_ACTIONS_V1,
  ...COMMIT_ACTIONS_V1,
  ...EXPORT_ACTIONS_V1,
  ...PREVIEW_ACTIONS_V1,
  ...MIGRATION_ACTIONS_V1,
] as const satisfies readonly KernelStateActionV1[];

const kernelStateActionV1Schema = z.enum(KERNEL_STATE_ACTIONS_V1);

export interface KernelStateChangedPayloadV1 {
  readonly modelId: KernelModelIdV1;
  readonly action: KernelStateActionV1;
  readonly previousTag: KernelPhaseTagV1;
  readonly nextTag: KernelPhaseTagV1;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export const kernelStateChangedPayloadV1Schema = z.strictObject({
  modelId: kernelModelIdV1Schema,
  action: kernelStateActionV1Schema,
  previousTag: kernelPhaseTagV1Schema,
  nextTag: kernelPhaseTagV1Schema,
  metadata: z.record(z.string(), z.unknown()),
});

/**
 * §10.1's `CapabilityState` (KCC:852-857), now CLOSED: `core/capabilities/types.ts`'s
 * own `CapabilityState` has landed with exactly this shape. Echoed here by value
 * rather than imported — `core/protocol` cannot import `core/capabilities`
 * (`capabilities` already imports `protocol`; the reverse would cycle) — the same
 * precedent this file already uses for Gate's error/warning kinds above.
 */
export type CapabilityStateV1 =
  | Readonly<{ available: true }>
  | Readonly<{ available: false; reasons: readonly [UnavailableReason, ...UnavailableReason[]] }>;

const capabilityStateV1Schema = z.discriminatedUnion("available", [
  z.strictObject({ available: z.literal(true) }),
  z.strictObject({
    available: z.literal(false),
    // §10.1 fixes this as `readonly [UnavailableReason, ...UnavailableReason[]]`, and
    // `./unavailable-reason` already owns that closed union.
    reasons: z.tuple([unavailableReasonV1Schema], unavailableReasonV1Schema).readonly(),
  }),
]);

/**
 * `CapabilityEntry<K>`'s `target` field (§10.1, KCC:861-865), flattened across all 43
 * kinds at once for this file's heterogeneous arrays of entries
 * (`kernel.snapshot`'s `capabilities`, `kernel.capabilitiesChanged`'s
 * `changed`/`removed`) — the same "loosely-typed sibling" role
 * `capabilities/types.ts`'s own `CapabilityRecord` plays for its batch/diffing
 * operations, just with the real union of the 43 target shapes in place of that
 * type's `unknown`. This does NOT correlate a specific entry's `target` to its own
 * `id` (that precise per-kind pairing is `capabilities/types.ts`'s `CapabilityEntry<K>`,
 * which this heterogeneous-array DTO structurally cannot reuse without importing
 * `core/capabilities`) — it only proves the value is ONE of the 43 known shapes,
 * which is still a closed, real check in place of the former `z.unknown()`.
 */
export type CapabilityTargetV1 = CapabilityTargetByKindV1[CommandKindV1];

const capabilityTargetV1Schema = z.union(Object.values(capabilityTargetByKindV1Schema));

/**
 * §10.1's `CapabilityEntry<K>` (KCC:861-865). `target`'s real schema now comes from
 * Task 1's `capabilityTargetByKindV1Schema` (`./capability-target.ts`) instead of
 * `z.unknown()`.
 */
export interface CapabilityEntryV1 {
  readonly id: CommandKindV1;
  readonly target: CapabilityTargetV1;
  readonly state: CapabilityStateV1;
}

const capabilityEntryV1Schema = z.strictObject({
  id: commandKindV1Schema,
  target: capabilityTargetV1Schema,
  state: capabilityStateV1Schema,
});

/**
 * TODO: the closed Git status projection — "repository identity, `HEAD`, sequencer
 * state, and complete three-scope status summaries" (§9 row for `git.statusChanged`,
 * KCC:828) — has no concrete TS shape anywhere in this document; no phase-6 slice is
 * named as its owner yet either. Shared by `kernel.snapshot`, `git.statusChanged`,
 * and `commit.completed`/`commit.failed`'s "resulting Git status" so there is exactly
 * one placeholder to replace later, not three drifting ones.
 */
export interface GitStatusProjectionV1Placeholder {
  readonly repositoryId: string;
  readonly head: string | null;
  readonly sequencerState: string;
  readonly scopes: Readonly<Record<string, unknown>>;
}

const gitStatusProjectionV1PlaceholderSchema = z.strictObject({
  repositoryId: z.string().min(1),
  head: z.string().nullable(),
  sequencerState: z.string().min(1),
  scopes: z.record(z.string(), z.unknown()),
});

/**
 * "all seven tagged model DTOs" (§9 row for `kernel.snapshot`, KCC:793), now the
 * seven machines' real state shapes. Mirrors `capabilities/types.ts`'s
 * `KernelStateSnapshot` (`capabilities/types.ts:82-103`) field for field — echoed by
 * value rather than imported, for the same reason `CapabilityStateV1` is above:
 * `core/protocol` cannot import `core/capabilities` (`capabilities` already imports
 * `protocol`; the reverse would cycle). Only the phase TYPES themselves
 * (`ProjectState`, `TurnState`, ...) are imported, from `core/machines` — no cycle
 * there: `core/machines` does not import `core/protocol` at the value level (its one
 * `CommandRejectionCode` import in `state-machine.ts` is `import type`, fully erased
 * at runtime and untraceable by `import/no-cycle`, verified empirically before this
 * import was added).
 *
 * DESIGN DECISION (the task-2 brief left this open): each model carries its PHASE
 * plus only the extra fields `KernelStateSnapshot` itself names for that domain
 * (`project.trust`, `turn.activeTurnId`/`commitIntentRecorded`,
 * `preview.sourceKind`) — not each machine's full internal ledger (page/chat lists,
 * plan ids, Git projections, ...). `KernelStateSnapshot`'s own comment draws exactly
 * this line for the CAPABILITY read surface ("deliberately narrower than any one
 * machine's full model... Payload-only content/schema... are not capability
 * inputs"), and `kernel.snapshot`'s separate top-level fields already carry the
 * wider payload (`pageDescriptors`, `activeChatId`, ...) — duplicating it a second
 * time inside `models` would just be two copies of the same fact able to drift.
 */
export interface KernelModelsSnapshotV1 {
  readonly project: Readonly<{
    readonly phase: ProjectState;
    readonly trust: "trusted" | "untrusted-read-only" | null;
  }>;
  readonly turn: Readonly<{
    readonly phase: TurnState;
    readonly activeTurnId: UUIDv7 | null;
    readonly commitIntentRecorded: boolean;
  }>;
  readonly restore: Readonly<{ readonly phase: RestoreState }>;
  readonly commit: Readonly<{ readonly phase: CommitState }>;
  readonly export: Readonly<{ readonly phase: ExportState }>;
  readonly preview: Readonly<{
    readonly phase: PreviewState;
    readonly sourceKind: "current" | "historical" | null;
  }>;
  readonly migration: Readonly<{ readonly phase: MigrationState }>;
}

const kernelModelsSnapshotV1Schema = z.strictObject({
  project: z.strictObject({
    phase: z.enum(KERNEL_PROJECT_STATES_V1),
    trust: z.enum(["trusted", "untrusted-read-only"]).nullable(),
  }),
  turn: z.strictObject({
    phase: z.enum(KERNEL_TURN_STATES_V1),
    activeTurnId: uuidv7Schema.nullable(),
    commitIntentRecorded: z.boolean(),
  }),
  restore: z.strictObject({ phase: z.enum(KERNEL_RESTORE_STATES_V1) }),
  commit: z.strictObject({ phase: z.enum(KERNEL_COMMIT_STATES_V1) }),
  export: z.strictObject({ phase: z.enum(KERNEL_EXPORT_STATES_V1) }),
  preview: z.strictObject({
    phase: z.enum(KERNEL_PREVIEW_STATES_V1),
    sourceKind: z.enum(["current", "historical"]).nullable(),
  }),
  migration: z.strictObject({ phase: z.enum(KERNEL_MIGRATION_STATES_V1) }),
});

/**
 * M22 (MVP gap-closeout plan, 2026-07-23): the composer chip's agent-identity text
 * — design's `codex · gpt5.5` sample strings become data-driven (design's own
 * `Composer.tsx` divergence comment). NOT part of the original KCC §9 row for
 * `kernel.snapshot` — added here to close that gap alongside the rest of M21's
 * placeholder closure. Sourced from the selected `AgentRegistry` entry's
 * `BackendCapabilities` (`core/ports/agent-backend.ts`); `null` before any backend
 * is selected (e.g. pre-`ready`, or before `model.select` has run).
 */
export type AgentIdentityV1 = Readonly<{ backendId: string; modelLabel: string }> | null;

export const agentIdentityV1Schema = z
  .strictObject({
    backendId: z.string().min(1),
    modelLabel: z.string().min(1),
  })
  .nullable();

/**
 * `kernel.snapshot`'s payload (§9 row, KCC:793): "`models` ..., `projectId`,
 * `activePageSlug`, `activeChatId`, `trust`, complete `capabilities`, complete
 * ordered `pageDescriptors`, Git status projection, and current `eventSeq`;
 * nullable identities are explicit." `trust` is nullable too: the project may not
 * have reached `ready` yet when a subscriber first attaches (§7.1's `opening`/
 * `recovering`/`blocked` states precede `trust` existing at all). `activeChatId` is
 * nullable for the same reason: a subscriber can attach during that same pre-`ready`
 * window, before project-open has loaded or project-create has minted any chat
 * state. This is deliberately different from `chat.changed.activeChatId` below,
 * which is non-nullable — see that field's own comment for why the two do not
 * drift by accident. `agentIdentity` is M22's addition, not part of the original
 * §9 row — see `AgentIdentityV1`'s own comment.
 */
export interface KernelSnapshotPayloadV1 {
  readonly models: KernelModelsSnapshotV1;
  readonly projectId: UUIDv7 | null;
  readonly activePageSlug: string | null;
  readonly activeChatId: UUIDv7 | null;
  readonly trust: "trusted" | "untrusted-read-only" | null;
  readonly capabilities: readonly CapabilityEntryV1[];
  readonly pageDescriptors: readonly PageDescriptorV1[];
  readonly gitStatus: GitStatusProjectionV1Placeholder;
  readonly agentIdentity: AgentIdentityV1;
  readonly eventSeq: UInt64String;
}

export const kernelSnapshotPayloadV1Schema = z.strictObject({
  models: kernelModelsSnapshotV1Schema,
  projectId: uuidv7Schema.nullable(),
  activePageSlug: pageSlugSchema.nullable(),
  activeChatId: uuidv7Schema.nullable(),
  trust: z.enum(["trusted", "untrusted-read-only"]).nullable(),
  capabilities: z.array(capabilityEntryV1Schema).readonly(),
  pageDescriptors: z.array(pageDescriptorV1Schema).readonly(),
  gitStatus: gitStatusProjectionV1PlaceholderSchema,
  agentIdentity: agentIdentityV1Schema,
  eventSeq: uint64StringSchema,
});

/**
 * `kernel.capabilitiesChanged`'s payload (§9 row, KCC:795): "Complete replacement
 * `CapabilityEntry` values for every changed `(id,target)` key and `removed` keys
 * for targets no longer published." `removed`'s `target` is closed the same way as
 * `CapabilityEntryV1.target` above (see `CapabilityTargetV1`'s comment) — it is the
 * same "which target key is gone" concept, so it gets the same real shape rather
 * than staying `unknown` next to its now-closed sibling.
 */
export interface KernelCapabilitiesChangedPayloadV1 {
  readonly changed: readonly CapabilityEntryV1[];
  readonly removed: readonly Readonly<{ id: CommandKindV1; target: CapabilityTargetV1 }>[];
}

export const kernelCapabilitiesChangedPayloadV1Schema = z.strictObject({
  changed: z.array(capabilityEntryV1Schema).readonly(),
  removed: z
    .array(z.strictObject({ id: commandKindV1Schema, target: capabilityTargetV1Schema }))
    .readonly(),
});

// ---------------------------------------------------------------------------
// page.removePlanReady / page.descriptorsChanged
// ---------------------------------------------------------------------------

/** `page.removePlanReady`'s payload (§9 row, KCC:796): "Complete `PageRemovePlanV1`." */
export type PageRemovePlanReadyPayloadV1 = PageRemovePlanV1;
export const pageRemovePlanReadyPayloadV1Schema = pageRemovePlanV1Schema;

/** The closed 8-member reason union `page.descriptorsChanged` carries, verbatim (KCC:797). */
const PAGE_DESCRIPTORS_CHANGED_REASONS_V1 = [
  "project-open",
  "turn-apply",
  "restore",
  "migration",
  "rename-title",
  "remove-page",
  "reorder-pages",
  "external-refresh",
] as const;

export type PageDescriptorsChangedReasonV1 = (typeof PAGE_DESCRIPTORS_CHANGED_REASONS_V1)[number];

/**
 * `page.descriptorsChanged`'s payload, given verbatim (§9 row, KCC:797): "The
 * descriptor list is complete and ordered; each non-removed descriptor and every
 * change carries its exact before/after source-hash binding."
 *
 * `treeRevision` IS THE ONE FIELD KCC:797 DOES NOT DESCRIBE, and the multi-file design
 * tree's §7 is the newer authority for it (design-tree phase 2 Task 10). KCC was written
 * when a page WAS one file, so its "exact before/after source-hash binding" per descriptor
 * genuinely was the whole story about what a consumer is looking at. A page now spans its
 * closure, and every field above still speaks only about ENTRY files — so a turn that
 * rewrites a module three pages import moves no `sourceHash`, produces no `changes` entry,
 * and is byte-for-byte identical to a no-op publish for anyone reading this payload. The UI
 * cannot ask "is the live preview still rendering the right tree?" from the fields KCC
 * lists; the tree's own revision (`computeTreeRevision` over the sorted inventory,
 * `entities/design-tree`) is what answers it, and it is what `ui/app/model/deps.ts` keys
 * its preview request on.
 */
export interface PageDescriptorsChangedPayloadV1 {
  readonly reason: PageDescriptorsChangedReasonV1;
  readonly descriptors: readonly PageDescriptorV1[];
  readonly changes: readonly PageDescriptorChangeV1[];
  readonly activePageSlug: string | null;
  /** The canonical tree's revision at the moment this list was read — see the interface header. */
  readonly treeRevision: string;
}

export const pageDescriptorsChangedPayloadV1Schema = z.strictObject({
  reason: z.enum(PAGE_DESCRIPTORS_CHANGED_REASONS_V1),
  descriptors: z.array(pageDescriptorV1Schema).readonly(),
  changes: z.array(pageDescriptorChangeV1Schema).readonly(),
  activePageSlug: pageSlugSchema.nullable(),
  // `computeTreeRevision` folds a sha-256 Merkle hash, so the wire shape is the same 64-char
  // lowercase hex every other digest on this contract uses — validated, never merely `z.string()`.
  treeRevision: sha256HexSchema,
});

// ---------------------------------------------------------------------------
// turn.started / turn.attemptStarted / turn.progress / turn.gateRejected /
// turn.applyStarted / turn.completed|failed|cancelled
// ---------------------------------------------------------------------------

/** `turn.started`'s payload (§9 row, KCC:798): "`turnId`, captured `chatId`, and absolute deadline." */
export interface TurnStartedPayloadV1 {
  readonly turnId: UUIDv7;
  readonly chatId: UUIDv7;
  readonly deadline: string;
}

export const turnStartedPayloadV1Schema = z.strictObject({
  turnId: uuidv7Schema,
  chatId: uuidv7Schema,
  deadline: rfc3339UtcSchema,
});

/**
 * `turn.attemptStarted`'s payload (§9 row, KCC:799): "`turnId`, `attempt`, and
 * absolute deadline; `leaseNonce` remains internal." — `leaseNonce` is deliberately
 * absent; the strict schema rejects it if a caller tries to add it back.
 */
export interface TurnAttemptStartedPayloadV1 {
  readonly turnId: UUIDv7;
  readonly attempt: number;
  readonly deadline: string;
}

export const turnAttemptStartedPayloadV1Schema = z.strictObject({
  turnId: uuidv7Schema,
  attempt: turnAttemptV1Schema,
  deadline: rfc3339UtcSchema,
});

/**
 * The normalized backend-neutral progress content `turn.progress` carries. This
 * mirrors `entities/turn`'s already-landed `AgentEvent` union field-for-field — "the
 * normalized agent stream ... backends map vendor events into this; kernel and UI
 * never see vendor shapes" (`entities/turn/types.ts`) is exactly "normalized
 * progress kind, and bounded backend-neutral content" (§9 row, KCC:800). It is
 * re-declared as a strict Kernel DTO schema here rather than imported, because
 * `entities/` types carry no Zod schema of their own and Kernel protocol DTOs are
 * strict (§8.2) where `entities/` decoders are forward-compatible.
 */
const AGENT_TOOL_OPS_V1 = [
  "read",
  "edit",
  "run",
  "search",
  "other",
] as const satisfies readonly AgentToolOp[];

const turnProgressContentV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("reasoning"), text: z.string() }),
  z.strictObject({
    kind: z.literal("tool"),
    id: z.string(),
    op: z.enum(AGENT_TOOL_OPS_V1),
    target: z.string(),
  }),
  // `tool-failed` correlates back to the `tool` step it failed by `id` (never by
  // position — see `entities/turn`'s `AgentEvent` doc for why only the failure,
  // never a paired success, is emitted). Design's third step glyph, verbatim
  // (`design/03-workspace-generating.dc.html:44`: "✓ done, ▸ running, ✗ failed").
  // `reason` is the tool's own bounded error text, `null` when the vendor sent none — see
  // `entities/turn`'s `AgentEvent` doc for the diagnostics gap it closes.
  z.strictObject({
    kind: z.literal("tool-failed"),
    id: z.string(),
    reason: z.string().nullable(),
  }),
  z.strictObject({ kind: z.literal("final"), text: z.string() }),
  z.strictObject({
    kind: z.literal("usage"),
    tokens: z.strictObject({
      inputTokens: nonNegativeIntSchema,
      outputTokens: nonNegativeIntSchema,
      contextPercent: z.number().min(0).max(100).nullable(),
    }),
  }),
  z.strictObject({ kind: z.literal("error"), message: z.string() }),
]);

/** `turn.progress`'s payload (§9 row, KCC:800): "`turnId`, `attempt`, normalized progress kind, and bounded backend-neutral content after full internal lease validation." */
export interface TurnProgressPayloadV1 {
  readonly turnId: UUIDv7;
  readonly attempt: number;
  readonly content: z.infer<typeof turnProgressContentV1Schema>;
}

export const turnProgressPayloadV1Schema = z.strictObject({
  turnId: uuidv7Schema,
  attempt: turnAttemptV1Schema,
  content: turnProgressContentV1Schema,
});

/**
 * Gate's FATAL error/WARNING kinds, transcribed verbatim from the real, landed
 * `gate/types.ts` (`GateErrorKind`, `GateWarningKind`). `core/protocol` cannot
 * `import` from `gate/` — `core` imports only `entities/` and its own `ports/`
 * (`docs/architecture/code-structure.md` item 7: "`core` imports no other module")
 * — so this is a structural echo of that real shape by value, not a type import.
 * `gate/types.ts` marks `file`/`line`/`column` optional (`?`) because that source
 * is not a Kernel protocol DTO; this file's own binding rule reserves `.optional()`
 * for a field the KCC spec itself marks with `?`, so the Kernel-side echo widens
 * them to `.nullable()` instead — the location is always present-or-explicitly-absent
 * on this DTO, never merely omitted.
 */
const GATE_ERROR_KINDS_V1 = ["import", "contract", "type", "manifest", "smoke"] as const;
const GATE_WARNING_KINDS_V1 = [
  "dropped-id",
  "unpointed-element",
  // RENAMED from `unguarded-timer`/`unguarded-randomness` (design-agent-feedback-loop repair,
  // Task 4, 2026-08-09) — the old names promised a guard the token-scan lint has no scope
  // analysis to ever observe clearing. See `gate/model/lints.ts`'s `lintDeterminism`.
  "nondeterministic-time",
  "nondeterministic-randomness",
  "unlisted-navigation",
  // `any` written to make a type error go away — see `gate/model/lints.ts`'s
  // `lintSilencingAny` for the turn that made this its own warning kind.
  "silencing-any",
  // Design-tree phase 2 Task 4 (design §8 steps 2/3), produced only by `GateRunner.runTree`'s
  // whole-tree pass, never by a per-page stage: an import cycle among the closure walk's own
  // edges, and a code file no page's proven closure reaches.
  "import-cycle",
  "dead-module",
  // design-systems §4.5 — `useTokens()` read at MODULE SCOPE captures one theme's values
  // forever, so theme switching renders nothing new. See `gate/model/lints.ts`'s
  // `lintModuleScopeTokens`.
  "module-scope-tokens",
  // design-systems §4.5, §9, D10 — a token NAME written where a `Color` (`#rrggbb`) is
  // expected. `TS2322` already rejects this fatally; this warning carries the EXACT rewrite
  // alongside that verdict. See `gate/model/lints.ts`'s `lintTokenNameColors`.
  "token-name-as-color",
] as const;

const turnGateErrorV1Schema = z.strictObject({
  kind: z.enum(GATE_ERROR_KINDS_V1),
  code: z.string().min(1),
  message: z.string(),
  file: z.string().min(1).nullable(),
  line: positiveIntSchema.nullable(),
  column: positiveIntSchema.nullable(),
  /**
   * The pages this whole-tree diagnostic is attributed to — those whose closure contains its
   * `file` (`core/ports/gate-runner.ts`'s `GateErrorV1.blockedPages`) — `null` when it names
   * none.
   *
   * MEANING WIDENED BY design-tree phase 2 Task 3, in step with the port and `gate/types.ts`, so
   * all three declarations of this field say the same thing. It used to mean "the pages whose
   * closure the pass could not complete AT `file`"; the whole-tree pass now also runs the TYPE
   * CHECK, whose diagnostics are attributed by the same rule (design §8 step 5: "a diagnostic in
   * a shared file is attributed to every page whose closure contains it"). The old reading is
   * subsumed, not replaced. `null` here does NOT mean harmless: a diagnostic no closure reaches
   * is still fatal, and the turn's verdict never consults this field.
   *
   * WIDENED BY TASK 14 (task-13 review round 4, M-4). The field was added at the port surface
   * in task 13 so ONE diagnostic per underlying fact could still be attributed to the N pages
   * it blocked — a forbidden import in a module three pages share is reported once, naming the
   * module, with all three slugs here, instead of three near-identical copies. It could not
   * reach any consumer: this schema is a `z.strictObject` with no such key, and
   * `core/turns/model/validation.ts`'s `toGateErrorDto` listed fields by name. Both are fixed
   * together — a strict schema that rejected the field would have made carrying it impossible,
   * and a DTO that dropped it would have made widening the schema pointless.
   *
   * `.nullable()`, never `.optional()`, matching this file's own "nullable, never optional"
   * convention for a widened echo of an optional port field (`file`/`line`/`column` directly
   * above take the identical treatment for the identical reason).
   *
   * This is a DIAGNOSTIC, never a verdict input: the turn's pass/fail decision stays
   * whole-tree (`validation.ts`'s own header explains why attributing rejections per page
   * would turn `gate/model/tree-scan.ts`'s `isTrustedTarget` gap into a fail-open). It reaches
   * the agent through `core/turns/model/prompt.ts`'s `formatBlockedPages`, which renders it as
   * a `[blocks: …]` clause on the folded retry prompt — corrected in task-14 review round 1,
   * Important 2: this comment previously claimed the retry prompt carried it while
   * `formatGateError` listed fields by name and dropped it.
   */
  blockedPages: z.array(pageSlugSchema).readonly().nullable(),
});

const turnGateWarningV1Schema = z.strictObject({
  kind: z.enum(GATE_WARNING_KINDS_V1),
  message: z.string(),
  line: positiveIntSchema.nullable(),
  column: positiveIntSchema.nullable(),
  /**
   * The source this warning was produced against (`gate/types.ts`'s `GateWarning.file`,
   * `core/ports/gate-runner.ts`'s `GateWarningV1.file`) — every per-page lint stamps it at its
   * one call site in `gate/model/gate.ts` (defect fix, 2026-08-09), same as the whole-tree
   * pass already did for `import-cycle`/`dead-module`. `null` means the warning is about the
   * TREE, not a file — the rare case, not the default. `.nullable()`, never `.optional()`,
   * matching this file's own binding rule: a widened echo of an optional port field stays
   * present-or-explicitly-absent on the wire, never merely omitted (see
   * `turnGateErrorV1Schema`'s identical `file` field just above).
   */
  file: z.string().min(1).nullable(),
  /**
   * The pages this warning is attributed to (`gate/types.ts`'s `GateWarning.blockedPages`,
   * `core/ports/gate-runner.ts`'s `GateWarningV1.blockedPages`) — `null` when it names none.
   * SAME shape, SAME absence rule, SAME producer restriction as `turnGateErrorV1Schema`'s
   * `blockedPages` just above; read that field's doc comment for the full account rather than a
   * second copy of it here.
   *
   * ADDED (design-agent-feedback-loop repair, Task 5, 2026-08-09) alongside the closure-wide
   * determinism/`silencing-any` lint `GateRunner.runTree` now runs: a warning in a module three
   * pages share must reach the agent's retry prompt naming all three, the same way a fatal
   * already does. `.nullable()`, never `.optional()`, for the identical reason `file` just above
   * takes that treatment.
   */
  blockedPages: z.array(pageSlugSchema).readonly().nullable(),
});

/** "bounded closed Gate diagnostics" (§9 row for `turn.gateRejected`, KCC:801). */
export interface TurnGateDiagnosticsV1 {
  readonly errors: readonly z.infer<typeof turnGateErrorV1Schema>[];
  readonly warnings: readonly z.infer<typeof turnGateWarningV1Schema>[];
}

const turnGateDiagnosticsV1Schema = z.strictObject({
  errors: z.array(turnGateErrorV1Schema).readonly(),
  warnings: z.array(turnGateWarningV1Schema).readonly(),
});

/**
 * `turn.gateRejected`'s payload (§9 row, KCC:801): "`turnId`, `attempt`, retry
 * number, and bounded closed Gate diagnostics." §9 itself only says "retry number"
 * with no numeric range; the 0-3 bound below is NOT spec-stated — it is this file's
 * own inference from §7.2's attempt budget (KCC:255: "Legal only while `attempt <
 * 4`"), since a turn can retry at most 3 times (once each after attempts 1-3 fail;
 * attempt 4 has no further retry).
 */
export interface TurnGateRejectedPayloadV1 {
  readonly turnId: UUIDv7;
  readonly attempt: number;
  readonly retryNumber: number;
  readonly diagnostics: TurnGateDiagnosticsV1;
}

export const turnGateRejectedPayloadV1Schema = z.strictObject({
  turnId: uuidv7Schema,
  attempt: turnAttemptV1Schema,
  retryNumber: z.number().int().min(0).max(3),
  diagnostics: turnGateDiagnosticsV1Schema,
});

/** `turn.applyStarted`'s payload (§9 row, KCC:802): "`turnId`, candidate hash, and affected page slugs." */
export interface TurnApplyStartedPayloadV1 {
  readonly turnId: UUIDv7;
  readonly candidateHash: Sha256Hex;
  readonly affectedPageSlugs: readonly string[];
}

export const turnApplyStartedPayloadV1Schema = z.strictObject({
  turnId: uuidv7Schema,
  candidateHash: sha256HexSchema,
  affectedPageSlugs: z.array(pageSlugSchema).readonly(),
});

/**
 * The `turn.completed`/`turn.failed`/`turn.cancelled` outcome. §7.2 fixes the
 * `terminal` sub-state's failure-side codes verbatim ("`terminal` carries `failed |
 * cancelled | stale | interrupted`", KCC:234); `"completed"` is added here for the
 * separate `committed -> settle -> idle` success path (KCC:260, "Emits changed
 * pages, chat result, pin changes, and resulting hashes"), which needs a code of its
 * own because all three event kinds share this one payload type (§9 map, KCC:726-728).
 */
const TURN_OUTCOME_CODES_V1 = ["completed", "failed", "cancelled", "stale", "interrupted"] as const;
export type TurnOutcomeCodeV1 = (typeof TURN_OUTCOME_CODES_V1)[number];

/** One bounded warning carried on a terminal turn event, matching the code/safeMessage shape already fixed for `DiagnosticDtoV1`/`PageDescriptorV1`'s error. */
export interface TurnWarningV1 {
  readonly code: string;
  readonly safeMessage: string;
}

const turnWarningV1Schema = z.strictObject({
  code: z.string().min(1),
  safeMessage: z.string(),
});

/**
 * `turn.completed`, `turn.failed`, `turn.cancelled`'s shared payload (§9 row,
 * KCC:803): "`turnId`, exact outcome code, changed page slugs, resulting source
 * hashes, bounded warnings, and nullable closed failure DTO." Page slug and its
 * resulting hash are paired in one object per page, the same pairing style
 * `PageDescriptorChangeV1` already uses for before/after hashes, rather than two
 * parallel arrays whose index-correlation is easy to break.
 *
 * WP-8 item 4 ("Generic `turn.failed` — a typed outcome instead of the catch-all",
 * phase-8 design's documented-debt sweep) plus its own gate-exhaustion-vs-backend-failure
 * follow-up.
 *
 * CORRECTED (defect fix, 2026-07-26): this paragraph used to state that "`handlers/turn.ts`'s
 * own composer still cannot honestly reconstruct WHICH `TurnTerminalOutcome` a turn ended on —
 * so `outcome` still only ever carries `"failed"`". That claim outlived its own cause. The
 * gate-exhaustion follow-up below made `TerminalizeTurnResultV1` echo the originally requested
 * `TurnTerminalOutcome` back verbatim on BOTH its `"recorded"` and `"unrecorded"` variants
 * (`core/turns/model/terminalize.ts`'s own doc says it was added "so this caller could rebuild
 * the real outcome"), so the composer reads a measured value rather than guessing one:
 * `handlers/turn.ts`'s `terminalOutcomeCode` now publishes the real `cancelled`/`stale`/
 * `interrupted`/`failed`, and picks the matching event KIND with it. `"failed"` survives only
 * for the two branches that genuinely carry no echoed outcome (a refused terminalization and
 * the practically-unreachable `"finalized"` shapes). Until then a user pressing Esc — a hinted,
 * ordinary action — saw their deliberate cancel rendered as `✗ failed`, indistinguishable from
 * a backend crash. What ALSO changed, across both landings: `failure` is no longer a
 * fabricated `PERSISTENCE_FAILED` DTO — when the terminal chat record itself failed to
 * persist, `failure` carries the REAL adapter-level `FailureDtoV1` the store produced,
 * propagated verbatim (WP-8 item 4); and an ORDINARY `"recorded"` termination now surfaces a
 * real, closed `OperationalFailureCode` too when `core/turns` echoed one back as `reason`
 * (e.g. Gate exhaustion's `"GATE_RETRY_EXHAUSTED"`, a backend failure's `"BACKEND_FAILED"` —
 * see `handlers/turn.ts`'s own header, "GATE-EXHAUSTION-VS-BACKEND-FAILURE — CLOSED"). No NEW
 * field was added for either landing (a brand-new wire discriminant was considered and
 * rejected both times — `handlers/turn.ts`'s own header has the full reasoning: this type is
 * constructed as typed literals in `ui/app`/`ui/workspace` test fixtures outside either task's
 * scope, so a new required field would ripple beyond it, and an optional one would break this
 * file's own "nullable, never optional" convention for a KCC-fixed payload) — only WHICH
 * already-typed `FailureDtoV1`/`code` gets chosen changed, so no schema edit was needed for
 * either half of the fix.
 */
export interface TurnTerminalPayloadV1 {
  readonly turnId: UUIDv7;
  readonly outcome: TurnOutcomeCodeV1;
  readonly changedPages: readonly Readonly<{ pageSlug: string; sourceHash: Sha256Hex }>[];
  readonly warnings: readonly TurnWarningV1[];
  readonly failure: FailureDtoV1 | null;
}

export const turnTerminalPayloadV1Schema = z.strictObject({
  turnId: uuidv7Schema,
  outcome: z.enum(TURN_OUTCOME_CODES_V1),
  changedPages: z
    .array(z.strictObject({ pageSlug: pageSlugSchema, sourceHash: sha256HexSchema }))
    .readonly(),
  warnings: z.array(turnWarningV1Schema).readonly(),
  failure: failureDtoV1Schema.nullable(),
});

// ---------------------------------------------------------------------------
// restore.planReady / restore.started / restore.recordPending /
// restore.completed|failed
// ---------------------------------------------------------------------------

/**
 * `restore.planReady`'s payload (§9 row, KCC:804): "`restorePlanId`, page slug,
 * full source commit id, immutable blob hash, pre-Restore source hash, index
 * state, Gate-attestation hash, plan revision, and exact confirmation facts."
 * `indexState` excludes `"staged"`: a staged source fails planning outright and
 * never reaches `planReady` (§7.3, KCC:284: "A staged source or failed Gate
 * returns `planFailed` instead"). "exact confirmation facts" is modeled as the one
 * fact §7.3's prose names — whether confirming will overwrite local changes
 * (KCC:284: "exact overwrite and staged/unstaged facts"). `gateAttestationHash` is
 * `Sha256Hex`, not a Git object id: §7.3 (KCC:277) describes it as bound "to the
 * exact source bytes ..., runtime declaration bundle, and Gate policy version" — a
 * value the Kernel computes itself, the same category as `preRestoreSourceHash`,
 * not one Git produces (contrast `sourceCommitId`/`blobHash` above).
 */
export interface RestorePlanReadyPayloadV1 {
  readonly restorePlanId: UUIDv7;
  readonly pageSlug: string;
  readonly sourceCommitId: string;
  readonly blobHash: string;
  readonly preRestoreSourceHash: Sha256Hex;
  readonly indexState: "clean" | "unstaged";
  readonly gateAttestationHash: Sha256Hex;
  readonly planRevision: UInt64String;
  readonly willOverwrite: boolean;
}

export const restorePlanReadyPayloadV1Schema = z.strictObject({
  restorePlanId: uuidv7Schema,
  pageSlug: pageSlugSchema,
  sourceCommitId: fullGitObjectIdSchema,
  blobHash: fullGitObjectIdSchema,
  preRestoreSourceHash: sha256HexSchema,
  indexState: z.enum(["clean", "unstaged"]),
  gateAttestationHash: sha256HexSchema,
  planRevision: uint64StringSchema,
  willOverwrite: z.boolean(),
});

/** `restore.started`'s payload (§9 row, KCC:805): "`restorePlanId`, `restoreActionId`, page slug, full source commit id, and safe target-chat display identity." */
export interface RestoreStartedPayloadV1 {
  readonly restorePlanId: UUIDv7;
  readonly restoreActionId: UUIDv7;
  readonly pageSlug: string;
  readonly sourceCommitId: string;
  readonly safeTargetChatDisplay: string;
}

export const restoreStartedPayloadV1Schema = z.strictObject({
  restorePlanId: uuidv7Schema,
  restoreActionId: uuidv7Schema,
  pageSlug: pageSlugSchema,
  sourceCommitId: fullGitObjectIdSchema,
  safeTargetChatDisplay: z.string(),
});

/** `restore.recordPending`'s payload (§9 row, KCC:806): "`restoreActionId`, page slug, full source commit id, and safe target-chat display identity." */
export interface RestoreRecordPendingPayloadV1 {
  readonly restoreActionId: UUIDv7;
  readonly pageSlug: string;
  readonly sourceCommitId: string;
  readonly safeTargetChatDisplay: string;
}

export const restoreRecordPendingPayloadV1Schema = z.strictObject({
  restoreActionId: uuidv7Schema,
  pageSlug: pageSlugSchema,
  sourceCommitId: fullGitObjectIdSchema,
  safeTargetChatDisplay: z.string(),
});

/**
 * `restore.completed`/`restore.failed`'s shared payload (§9 row, KCC:807):
 * "`restorePlanId`, nullable `restoreActionId`, page slug, full source commit id,
 * phase, and nullable closed failure DTO." `phase` is the subset of `RestoreState`
 * (§7.3) that can reach `idle` through `complete`/`failBeforeIntent`:
 * `executing`, `record-pending`, `recovering` (KCC:289-291).
 */
export interface RestoreTerminalPayloadV1 {
  readonly restorePlanId: UUIDv7;
  readonly restoreActionId: UUIDv7 | null;
  readonly pageSlug: string;
  readonly sourceCommitId: string;
  readonly phase: "executing" | "record-pending" | "recovering";
  readonly failure: FailureDtoV1 | null;
}

export const restoreTerminalPayloadV1Schema = z.strictObject({
  restorePlanId: uuidv7Schema,
  restoreActionId: uuidv7Schema.nullable(),
  pageSlug: pageSlugSchema,
  sourceCommitId: fullGitObjectIdSchema,
  phase: z.enum(["executing", "record-pending", "recovering"]),
  failure: failureDtoV1Schema.nullable(),
});

// ---------------------------------------------------------------------------
// commit.planReady / commit.started / commit.completed|failed
// ---------------------------------------------------------------------------

/** The closed commit scope, given verbatim in §10.1's `commit.plan` target row (KCC:897). */
const COMMIT_SCOPES_V1 = ["current-page", "infrastructure", "whole-project"] as const;
export type CommitScopeV1 = (typeof COMMIT_SCOPES_V1)[number];

const commitScopeV1Schema = z.enum(COMMIT_SCOPES_V1);

/** One path entry in a commit plan's preview, per §7.4 (KCC:312: "exact added/modified/deleted paths, states, content hashes"). `contentHash` is null for a `deleted` path. */
const commitPathPreviewV1Schema = z.strictObject({
  path: z.string().min(1),
  state: z.enum(["added", "modified", "deleted"]),
  contentHash: fullGitObjectIdSchema.nullable(),
});

/**
 * `commit.planReady`'s payload (§9 row, KCC:808): "`commitPlanId`, scope, expected
 * `HEAD`, exact path/state/hash preview, message template, and detached-HEAD
 * warning flag."
 */
export interface CommitPlanReadyPayloadV1 {
  readonly commitPlanId: UUIDv7;
  readonly scope: CommitScopeV1;
  readonly expectedHead: string;
  readonly paths: readonly z.infer<typeof commitPathPreviewV1Schema>[];
  readonly messageTemplate: string;
  readonly detachedHeadWarning: boolean;
}

export const commitPlanReadyPayloadV1Schema = z.strictObject({
  commitPlanId: uuidv7Schema,
  scope: commitScopeV1Schema,
  expectedHead: fullGitObjectIdSchema,
  paths: z.array(commitPathPreviewV1Schema).readonly(),
  messageTemplate: z.string(),
  detachedHeadWarning: z.boolean(),
});

/** `commit.started`'s payload (§9 row, KCC:809): "`commitPlanId`, execution `operationId`, scope, and exact selected paths." */
export interface CommitStartedPayloadV1 {
  readonly commitPlanId: UUIDv7;
  readonly operationId: UUIDv7;
  readonly scope: CommitScopeV1;
  readonly selectedPaths: readonly string[];
}

export const commitStartedPayloadV1Schema = z.strictObject({
  commitPlanId: uuidv7Schema,
  operationId: uuidv7Schema,
  scope: commitScopeV1Schema,
  selectedPaths: z.array(z.string().min(1)).readonly(),
});

/**
 * `commit.completed`/`commit.failed`'s shared payload (§9 row, KCC:810):
 * "`commitPlanId`, execution `operationId`, scope, resulting Git status, and
 * nullable closed failure DTO." Reuses the shared `GitStatusProjectionV1Placeholder`
 * for "resulting Git status" — see that type's own TODO.
 */
export interface CommitTerminalPayloadV1 {
  readonly commitPlanId: UUIDv7;
  readonly operationId: UUIDv7;
  readonly scope: CommitScopeV1;
  readonly gitStatus: GitStatusProjectionV1Placeholder;
  readonly failure: FailureDtoV1 | null;
}

export const commitTerminalPayloadV1Schema = z.strictObject({
  commitPlanId: uuidv7Schema,
  operationId: uuidv7Schema,
  scope: commitScopeV1Schema,
  gitStatus: gitStatusProjectionV1PlaceholderSchema,
  failure: failureDtoV1Schema.nullable(),
});

// ---------------------------------------------------------------------------
// export.started / export.progress / export.completed|failed
// ---------------------------------------------------------------------------

/**
 * The `ExportState` phases the TERMINAL export events (`export.completed`/`export.failed`)
 * can name (§7.5: `kernel.export.beginRendering` -> `rendering`, `kernel.export.
 * beginPublication` -> `publishing`).
 *
 * `"idle"` widens the original in-flight-only pair for `export.failed` alone (never
 * `export.progress` — nothing ever progresses at `"idle"`, see `EXPORT_PROGRESS_PHASES_V1`
 * below, which deliberately excludes it): it reports a failure that happens BEFORE
 * `captureExportSnapshot` ever moves the export machine out of `"idle"` — either the machine
 * never left it, or `captureExportSnapshot`'s own `kernel.export.fail` forced it back there on
 * a page-read failure (`core/kernel/handlers/preview-export.ts`'s `runExportStart`, see its
 * header's "PRE-CAPTURE FAILURES" section). This reuses `ExportState`'s own `"idle"` member
 * verbatim (`core/machines/model/export-machine.ts`) rather than inventing a fourth phase
 * name — the widening this project's design chose over a whole new event kind, which would
 * have carried the full kernel-command-contract §8.2 obligation set for one
 * already-representable machine state.
 *
 * This tuple stays the wider, TERMINAL-only set (name kept stable — `exportTerminalPayloadV1Schema`
 * and every other consumer of `ExportPhaseV1` already depend on it); `export.progress` uses the
 * narrower `EXPORT_PROGRESS_PHASES_V1` below instead of sharing this one, so a phase
 * `export.progress` never actually emits cannot slip past its own schema (finding #12, part 2:
 * the two were briefly shared, which silently loosened `export.progress` too).
 */
const EXPORT_PHASES_V1 = ["idle", "rendering", "publishing"] as const;
export type ExportPhaseV1 = (typeof EXPORT_PHASES_V1)[number];

/**
 * The narrower phase set `export.progress` actually emits: `"rendering"` and `"publishing"`
 * only (§7.5, same mapping as `EXPORT_PHASES_V1` above, minus the terminal-only `"idle"`
 * widening). `export.progress` never fires before a snapshot is captured, so `"idle"` — a
 * real phase only a pre-capture `export.failed` can report — must be REJECTED here even
 * though it is accepted by the terminal schema below.
 */
const EXPORT_PROGRESS_PHASES_V1 = ["rendering", "publishing"] as const;
export type ExportProgressPhaseV1 = (typeof EXPORT_PROGRESS_PHASES_V1)[number];

/** `export.started`'s payload (§9 row, KCC:811): "export `operationId`, immutable source-snapshot digest, page count, render-job count, and destination identity." */
export interface ExportStartedPayloadV1 {
  readonly operationId: UUIDv7;
  readonly sourceSnapshotDigest: Sha256Hex;
  readonly pageCount: number;
  readonly renderJobCount: number;
  readonly destination: string;
}

export const exportStartedPayloadV1Schema = z.strictObject({
  operationId: uuidv7Schema,
  sourceSnapshotDigest: sha256HexSchema,
  pageCount: nonNegativeIntSchema,
  renderJobCount: nonNegativeIntSchema,
  destination: z.string().min(1),
});

/** `export.progress`'s payload (§9 row, KCC:812): "export `operationId`, phase, completed jobs, total jobs, nullable page slug, and nullable size." */
export interface ExportProgressPayloadV1 {
  readonly operationId: UUIDv7;
  readonly phase: ExportProgressPhaseV1;
  readonly completedJobs: number;
  readonly totalJobs: number;
  readonly pageSlug: string | null;
  readonly sizeBytes: number | null;
}

export const exportProgressPayloadV1Schema = z.strictObject({
  operationId: uuidv7Schema,
  phase: z.enum(EXPORT_PROGRESS_PHASES_V1),
  completedJobs: nonNegativeIntSchema,
  totalJobs: nonNegativeIntSchema,
  pageSlug: pageSlugSchema.nullable(),
  sizeBytes: nonNegativeIntSchema.nullable(),
});

/** `export.completed`/`export.failed`'s shared payload (§9 row, KCC:813): "export `operationId`, phase, destination identity, nullable generation id, and nullable closed failure DTO." */
export interface ExportTerminalPayloadV1 {
  readonly operationId: UUIDv7;
  readonly phase: ExportPhaseV1;
  readonly destination: string;
  readonly generationId: UUIDv7 | null;
  readonly failure: FailureDtoV1 | null;
}

export const exportTerminalPayloadV1Schema = z.strictObject({
  operationId: uuidv7Schema,
  phase: z.enum(EXPORT_PHASES_V1),
  destination: z.string().min(1),
  generationId: uuidv7Schema.nullable(),
  failure: failureDtoV1Schema.nullable(),
});

// ---------------------------------------------------------------------------
// migration.planReady / migration.started / migration.progress /
// migration.completed / migration.failed
// ---------------------------------------------------------------------------

/**
 * One rewrite entry, given verbatim (§9 row, KCC:814):
 * `(relativePath, fileKind, beforeHash, fromVersion, toVersion, sizeBytes)`.
 * `fromVersion`/`toVersion` are modeled as integers, mirroring the one landed
 * format-version field this codebase already has — `ChatHeader.formatVersion: 1`
 * (`entities/chat/types.ts`) — rather than an unconfirmed string. `fileKind` has no
 * closed union anywhere in this document (the roadmap's `MIGRATION_CHAIN` is empty
 * by design), so it stays a bounded free-form identifier.
 */
export interface MigrationRewriteEntryV1 {
  readonly relativePath: string;
  readonly fileKind: string;
  readonly beforeHash: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly sizeBytes: number;
}

const migrationRewriteEntryV1Schema = z.strictObject({
  relativePath: z.string().min(1),
  fileKind: z.string().min(1),
  beforeHash: fullGitObjectIdSchema,
  fromVersion: positiveIntSchema,
  toVersion: positiveIntSchema,
  sizeBytes: nonNegativeIntSchema,
});

/**
 * `migration.planReady`'s payload (§9 row, KCC:814): "`migrationPlanId`, exact
 * selected file-kind scope, exact rewrite entries ..., backup bytes, required free
 * bytes, and plan revision."
 */
export interface MigrationPlanReadyPayloadV1 {
  readonly migrationPlanId: UUIDv7;
  readonly selectedFileKinds: readonly string[];
  readonly rewriteEntries: readonly MigrationRewriteEntryV1[];
  readonly backupBytes: number;
  readonly requiredFreeBytes: number;
  readonly planRevision: UInt64String;
}

export const migrationPlanReadyPayloadV1Schema = z.strictObject({
  migrationPlanId: uuidv7Schema,
  selectedFileKinds: z.array(z.string().min(1)).readonly(),
  rewriteEntries: z.array(migrationRewriteEntryV1Schema).readonly(),
  backupBytes: nonNegativeIntSchema,
  requiredFreeBytes: nonNegativeIntSchema,
  planRevision: uint64StringSchema,
});

/** `migration.started`'s payload (§9 row, KCC:815): "`migrationPlanId`, `migrationActionId`, selected scope, and phase `backing-up`." */
export interface MigrationStartedPayloadV1 {
  readonly migrationPlanId: UUIDv7;
  readonly migrationActionId: UUIDv7;
  readonly selectedFileKinds: readonly string[];
  readonly phase: "backing-up";
}

export const migrationStartedPayloadV1Schema = z.strictObject({
  migrationPlanId: uuidv7Schema,
  migrationActionId: uuidv7Schema,
  selectedFileKinds: z.array(z.string().min(1)).readonly(),
  phase: z.literal("backing-up"),
});

/** The closed migration phase union, given verbatim (§9 row for `migration.progress`, KCC:816). */
const MIGRATION_PHASES_V1 = ["backing-up", "transforming", "publishing", "recovering"] as const;
export type MigrationPhaseV1 = (typeof MIGRATION_PHASES_V1)[number];

/** `migration.progress`'s payload (§9 row, KCC:816): "`migrationPlanId`, `migrationActionId`, phase ..., completed items, total items, and nullable relative path." */
export interface MigrationProgressPayloadV1 {
  readonly migrationPlanId: UUIDv7;
  readonly migrationActionId: UUIDv7;
  readonly phase: MigrationPhaseV1;
  readonly completedItems: number;
  readonly totalItems: number;
  readonly relativePath: string | null;
}

export const migrationProgressPayloadV1Schema = z.strictObject({
  migrationPlanId: uuidv7Schema,
  migrationActionId: uuidv7Schema,
  phase: z.enum(MIGRATION_PHASES_V1),
  completedItems: nonNegativeIntSchema,
  totalItems: nonNegativeIntSchema,
  relativePath: z.string().min(1).nullable(),
});

/**
 * `migration.completed`'s payload (§9 row, KCC:817): "`migrationPlanId`,
 * `migrationActionId`, transaction id, migrated-file count, resulting version map,
 * and `recovered` boolean." "Resulting version map" is `fileKind -> version`,
 * consistent with `MigrationRewriteEntryV1`'s integer `toVersion`.
 */
export interface MigrationTerminalPayloadV1 {
  readonly migrationPlanId: UUIDv7;
  readonly migrationActionId: UUIDv7;
  readonly transactionId: UUIDv7;
  readonly migratedFileCount: number;
  readonly resultingVersions: Readonly<Record<string, number>>;
  readonly recovered: boolean;
}

export const migrationTerminalPayloadV1Schema = z.strictObject({
  migrationPlanId: uuidv7Schema,
  migrationActionId: uuidv7Schema,
  transactionId: uuidv7Schema,
  migratedFileCount: nonNegativeIntSchema,
  resultingVersions: z.record(z.string().min(1), positiveIntSchema),
  recovered: z.boolean(),
});

/**
 * `migration.failed`'s payload, given VERBATIM as a discriminated union (§9 row,
 * KCC:818): the all-null planning variant, or the post-plan variant whose
 * `transactionId` "becomes non-null only after transaction preparation." Both
 * variants are discriminated on `phase`, whose `"planning"` literal never overlaps
 * the post-plan phase set.
 */
const migrationFailedPlanningVariantV1Schema = z.strictObject({
  migrationPlanId: z.null(),
  migrationActionId: z.null(),
  transactionId: z.null(),
  phase: z.literal("planning"),
  failure: failureDtoV1Schema,
});

const migrationFailedPostPlanVariantV1Schema = z.strictObject({
  migrationPlanId: uuidv7Schema,
  migrationActionId: uuidv7Schema,
  transactionId: uuidv7Schema.nullable(),
  phase: z.enum(MIGRATION_PHASES_V1),
  failure: failureDtoV1Schema,
});

export type MigrationFailedPayloadV1 =
  | Readonly<{
      migrationPlanId: null;
      migrationActionId: null;
      transactionId: null;
      phase: "planning";
      failure: FailureDtoV1;
    }>
  | Readonly<{
      migrationPlanId: UUIDv7;
      migrationActionId: UUIDv7;
      transactionId: UUIDv7 | null;
      phase: MigrationPhaseV1;
      failure: FailureDtoV1;
    }>;

export const migrationFailedPayloadV1Schema = z.discriminatedUnion("phase", [
  migrationFailedPlanningVariantV1Schema,
  migrationFailedPostPlanVariantV1Schema,
]);

// ---------------------------------------------------------------------------
// preview.sourceChanged / preview.sessionReady / preview.geometryResult /
// preview.backpressured|writable / preview.failed / preview.circuitOpened
// ---------------------------------------------------------------------------

/** `preview.setMode`'s closed interaction-mode union, given verbatim in §10.1 (KCC:888). */
const INTERACTION_MODES_V1 = ["static", "interactive"] as const;
export type InteractionModeV1 = (typeof INTERACTION_MODES_V1)[number];

/** A preview source selector: canonical Current design, or a full historical commit (§9 row, KCC:819: "`current` or full historical commit id"). */
const previewSourceSelectorV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("current") }),
  z.strictObject({ kind: z.literal("historical"), sourceCommit: fullGitObjectIdSchema }),
]);

/**
 * `preview.sourceChanged`'s payload (§9 row, KCC:819): "`previewSessionId`, page
 * slug, source selector ..., source hash, and host mode." `hostMode` is an opaque
 * HostSupervisor-defined mode string — its closed union lives in the host-
 * supervision-protocol design, not this document, so it is not enumerated here.
 */
export interface PreviewSourceChangedPayloadV1 {
  readonly previewSessionId: UUIDv7;
  readonly pageSlug: string;
  readonly source: z.infer<typeof previewSourceSelectorV1Schema>;
  readonly sourceHash: Sha256Hex;
  readonly hostMode: string;
}

export const previewSourceChangedPayloadV1Schema = z.strictObject({
  previewSessionId: uuidv7Schema,
  pageSlug: pageSlugSchema,
  source: previewSourceSelectorV1Schema,
  sourceHash: sha256HexSchema,
  hostMode: z.string().min(1),
});

/** `preview.sessionReady`'s payload (§9 row, KCC:820): "`previewSessionId`, current nonce, page slug, source hash, host mode, interaction mode, size, theme, and initial frame sequence." */
export interface PreviewSessionReadyPayloadV1 {
  readonly previewSessionId: UUIDv7;
  readonly nonce: HostNonce;
  readonly pageSlug: string;
  readonly sourceHash: Sha256Hex;
  readonly hostMode: string;
  readonly interactionMode: InteractionModeV1;
  readonly size: Readonly<{ w: number; h: number }>;
  readonly theme: string;
  readonly initialFrameSeq: UInt64String;
}

export const previewSessionReadyPayloadV1Schema = z.strictObject({
  previewSessionId: uuidv7Schema,
  nonce: hostNonceSchema,
  pageSlug: pageSlugSchema,
  sourceHash: sha256HexSchema,
  hostMode: z.string().min(1),
  interactionMode: z.enum(INTERACTION_MODES_V1),
  size: z.strictObject({ w: positiveIntSchema, h: positiveIntSchema }),
  theme: z.string().min(1),
  initialFrameSeq: uint64StringSchema,
});

/** The closed geometry-query-kind union, given verbatim in §10.1 (KCC:890). */
const PREVIEW_QUERY_KINDS_V1 = ["hit", "rect", "describe", "layout", "pin-anchor"] as const;
export type PreviewQueryKindV1 = (typeof PREVIEW_QUERY_KINDS_V1)[number];

/**
 * An absolute screen-space rectangle (design doc §4.2's `rectOf(id) → Rect`).
 * Field names taken verbatim from the real producer, `host/render/types.ts`'s own
 * `Rect` — `width`/`height`, NOT this package's WP-1 task brief's originally
 * suggested `w`/`h` — because that host type is backed by OpenTUI's own
 * `screenX`/`screenY`/`width`/`height` getters (`host/render/model/geometry.ts`'s
 * `rectOfRenderable`), and CLAUDE.md forbids inventing field names once a real
 * source fixes them.
 */
export interface RectV1 {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const rectV1Schema = z.strictObject({
  x: nonNegativeIntSchema,
  y: nonNegativeIntSchema,
  width: nonNegativeIntSchema,
  height: nonNegativeIntSchema,
});

/**
 * `describe(id) → component kind + label` (design doc §4.2/§3.2). `host/render/
 * types.ts`'s own `DescribedElement` has only `id`/`kind` today: `label` is a
 * documented gap there ("not yet populated ... requires the runtime catalog's own
 * per-component knowledge"), and the task brief's originally suggested extra
 * `rect` field is not part of that host type either — this DTO mirrors the real
 * producer exactly rather than inventing either field, and will grow `label`
 * when the host does.
 */
export interface DescribedElementV1 {
  readonly id: string;
  readonly kind: string;
}

const describedElementV1Schema = z.strictObject({
  id: z.string().min(1),
  kind: z.string().min(1),
});

/**
 * One node of `layoutTree() → the resolved node tree` (design doc §4.2/§3.7:
 * "id, kind, box, text, children"). Shape and field names taken verbatim from
 * `host/render/types.ts`'s own `LayoutNode`/`host/render/model/geometry.ts`'s
 * `layoutNodeOf`, diverging from the task brief's originally suggested shape in
 * two ways the real producer fixes: the box is named `box` (not the brief's
 * `rect`), and `id` is REQUIRED — not the brief's suggested `id?` — because
 * `layoutNodeOf` always reads `renderable.id` unconditionally. `text` is omitted
 * entirely, matching `LayoutNode`'s own documented gap ("omitted ... for the
 * same reason `describe`'s `label` is").
 */
export interface LayoutNodeV1 {
  readonly id: string;
  readonly kind: string;
  readonly box: RectV1;
  readonly children: readonly LayoutNodeV1[];
}

const layoutNodeV1Schema: z.ZodType<LayoutNodeV1> = z.lazy(() =>
  z.strictObject({
    id: z.string().min(1),
    kind: z.string().min(1),
    box: rectV1Schema,
    children: z.array(layoutNodeV1Schema).readonly(),
  }),
);

/**
 * `preview.geometryResult`'s closed "result" body (§9 row for `preview.
 * geometryResult`, KCC:821: "closed geometry result"), keyed by design doc §4.2's
 * own four query-FUNCTION names (`checkHit`/`rectOf`/`describe`/`layoutTree`) —
 * a DIFFERENT vocabulary from this file's own wire-level `PreviewQueryKindV1`
 * (`hit`/`rect`/`describe`/`layout`/`pin-anchor`, §10.1's `queryKind` enum
 * naming the REQUEST family). A resolving `pin-anchor` request (wire
 * `queryKind: "pin-anchor"`) always carries a `checkHit`-shaped result — §7.1 of
 * the host-supervision-protocol design: "the Kernel-level `pin-anchor`
 * refinement travels AS `query-hit` on the wire" — so this union has no separate
 * fifth member, matching `host/supervisor/types.ts`'s own `GeometryQuery` (which
 * likewise folds `pin-anchor` into `hit`).
 */
export type GeometryQueryResultV1 =
  | Readonly<{ kind: "checkHit"; hit: Readonly<{ id: string }> | null }>
  | Readonly<{ kind: "rectOf"; rect: RectV1 | null }>
  | Readonly<{ kind: "describe"; element: DescribedElementV1 | null }>
  | Readonly<{ kind: "layoutTree"; tree: LayoutNodeV1 }>;

export const geometryQueryResultV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("checkHit"),
    hit: z.strictObject({ id: z.string().min(1) }).nullable(),
  }),
  z.strictObject({ kind: z.literal("rectOf"), rect: rectV1Schema.nullable() }),
  z.strictObject({ kind: z.literal("describe"), element: describedElementV1Schema.nullable() }),
  z.strictObject({ kind: z.literal("layoutTree"), tree: layoutNodeV1Schema }),
]);

/**
 * `preview.geometryResult`'s payload (§9 row, KCC:821): "`previewSessionId`,
 * `frameTokenId`, queried `FrameIdentityV1`, query kind, closed geometry result,
 * and `geometryToken: GeometryTokenV1 | null`; the token is non-null only for a
 * successful resolving `hit` or `pin-anchor` query." That "only for" rule is a
 * producer invariant, not something this schema enforces — `geometryToken` is
 * simply nullable for every `queryKind`.
 */
export interface PreviewGeometryResultPayloadV1 {
  readonly previewSessionId: UUIDv7;
  readonly frameTokenId: FrameTokenV1;
  readonly frameIdentity: FrameIdentityV1;
  readonly queryKind: PreviewQueryKindV1;
  readonly result: GeometryQueryResultV1;
  readonly geometryToken: GeometryTokenV1 | null;
}

export const previewGeometryResultPayloadV1Schema = z.strictObject({
  previewSessionId: uuidv7Schema,
  frameTokenId: frameTokenV1Schema,
  frameIdentity: frameIdentityV1Schema,
  queryKind: z.enum(PREVIEW_QUERY_KINDS_V1),
  result: geometryQueryResultV1Schema,
  geometryToken: geometryTokenV1Schema.nullable(),
});

/** `preview.backpressured`/`preview.writable`'s shared payload (§9 row, KCC:822): "`previewSessionId`, current nonce, ordered-queue size, capacity, and low-water mark." */
export interface PreviewBackpressurePayloadV1 {
  readonly previewSessionId: UUIDv7;
  readonly nonce: HostNonce;
  readonly queueSize: number;
  readonly capacity: number;
  readonly lowWaterMark: number;
}

export const previewBackpressurePayloadV1Schema = z.strictObject({
  previewSessionId: uuidv7Schema,
  nonce: hostNonceSchema,
  queueSize: nonNegativeIntSchema,
  capacity: positiveIntSchema,
  lowWaterMark: nonNegativeIntSchema,
});

/**
 * `preview.failed`'s payload (§9 row, KCC:823): "`previewSessionId`, current
 * nonce, page slug, source hash, lifecycle phase, and closed host failure." `phase`
 * is the `PreviewState` set `sessionFailed` can fire from (§7.6, KCC:365).
 */
export interface PreviewFailurePayloadV1 {
  readonly previewSessionId: UUIDv7;
  readonly nonce: HostNonce;
  readonly pageSlug: string;
  readonly sourceHash: Sha256Hex;
  readonly phase: "starting" | "switching" | "live";
  readonly failure: FailureDtoV1;
}

export const previewFailurePayloadV1Schema = z.strictObject({
  previewSessionId: uuidv7Schema,
  nonce: hostNonceSchema,
  pageSlug: pageSlugSchema,
  sourceHash: sha256HexSchema,
  phase: z.enum(["starting", "switching", "live"]),
  failure: failureDtoV1Schema,
});

/**
 * `preview.circuitOpened`'s payload (§9 row, KCC:824): "`previewSessionId`, page
 * slug, source hash, attempts, final failure, and retry capability state." "retry
 * capability state" reuses the same closed `CapabilityStateV1` fixed above for
 * `kernel.capabilitiesChanged` — see that type's comment.
 */
export interface PreviewCircuitOpenedPayloadV1 {
  readonly previewSessionId: UUIDv7;
  readonly pageSlug: string;
  readonly sourceHash: Sha256Hex;
  readonly attempts: number;
  readonly finalFailure: FailureDtoV1;
  readonly retryCapability: CapabilityStateV1;
}

export const previewCircuitOpenedPayloadV1Schema = z.strictObject({
  previewSessionId: uuidv7Schema,
  pageSlug: pageSlugSchema,
  sourceHash: sha256HexSchema,
  attempts: positiveIntSchema,
  finalFailure: failureDtoV1Schema,
  retryCapability: capabilityStateV1Schema,
});

// ---------------------------------------------------------------------------
// chat.changed / selection.changed / pins.changed / git.statusChanged /
// diagnostics.changed
// ---------------------------------------------------------------------------

/**
 * A chat summary as `chat.changed` carries it. `chatId`/`createdAt` land on
 * `ChatHeader` (`entities/chat/types.ts`). `displayName` (WP-10 Task 4) is DERIVED,
 * never stored (design §3.9: "the first line of its first `user` record, truncated to
 * ~60 chars") — the Kernel fills it via `core/chats`'s `deriveChatDisplayName`
 * whenever it has loaded a chat's tail (`chat.create`/`chat.switch`/`project.open`);
 * `null` until that chat's first `user` record exists, in which case the UI renders
 * the design's own fresh-chat placeholder instead (`new chat — fresh context`,
 * `design/termcraft-engine.js:1078`'s `wsChatFresh`; `App.tsx`'s `FRESH_CHAT_LABEL`).
 * CORRECTED (2026-07-26): this used to name a `chatId.slice(0, 8)` hex fragment and call it
 * "the design's fallback" — the design has no such fallback and no unnamed row at all
 * (`wsChats`'s fourteen sample rows, `:1026-1039`, are every one a real name).
 * Capped at 80 chars in this
 * schema — a small margin over §3.9's ~60-char target, since the Kernel does the
 * actual truncation and this bound only guards the DTO from an unbounded string.
 */
export interface ChatSummaryV1 {
  readonly chatId: UUIDv7;
  readonly createdAt: string;
  readonly displayName: string | null;
}

const chatSummaryV1Schema = z.strictObject({
  chatId: uuidv7Schema,
  createdAt: rfc3339UtcSchema,
  displayName: z.string().max(80).nullable(),
});

/**
 * `chat.changed`'s payload (§9 row, KCC:825): "complete active chat identity plus
 * the exact added/updated chat summaries and removed chat ids." `activeChatId` is
 * deliberately non-nullable, unlike `KernelSnapshotPayloadV1.activeChatId` above:
 * storage-identity §14.2 fixes that project creation always mints an "initial chat
 * header" as part of becoming `ready`, so by the time any chat-lifecycle event can
 * fire at all an active chat is guaranteed to exist — `kernel.snapshot` alone can
 * observe the narrower pre-`ready` window where it does not yet.
 */
export interface ChatChangedPayloadV1 {
  readonly activeChatId: UUIDv7;
  readonly added: readonly ChatSummaryV1[];
  readonly updated: readonly ChatSummaryV1[];
  readonly removedChatIds: readonly UUIDv7[];
}

export const chatChangedPayloadV1Schema = z.strictObject({
  activeChatId: uuidv7Schema,
  added: z.array(chatSummaryV1Schema).readonly(),
  updated: z.array(chatSummaryV1Schema).readonly(),
  removedChatIds: z.array(uuidv7Schema).readonly(),
});

/**
 * `chat.records`'s payload (WP-10 Task 3, new event kind 43 -> 44): the bounded page
 * of persisted records for ONE chat, delivered command-time by `chat.switch`,
 * `chat.create`, and `project.open` (see `docs/superpowers/plans/
 * 2026-07-24-chat-transport.md`'s Decision section for why this must be an event and
 * not a command-result or snapshot field). `records` is the exact page `ChatReader.
 * loadTail`/`loadBefore` returned (`ChatLoadResultV1.records`, `chat-store.ts:45-48`),
 * mapped through `core/chats`'s `chatRecordToDtoV1`; `prevCursor` mirrors `ChatLoadResultV1.
 * prevCursor` — `null` once no earlier page exists.
 */
export interface ChatRecordsPayloadV1 {
  readonly chatId: UUIDv7;
  readonly records: readonly ChatRecordDtoV1[];
  readonly prevCursor: ChatPageCursorDtoV1 | null;
  /**
   * The chat's TOTAL record count (chat-scroll spec §6.3), from `ChatLoadResultV1.
   * totalRecordCount`. The UI's top-of-stream indicator counts records it has NOT loaded —
   * this minus the number it holds — so the label never needs a scroll metric to stay true.
   */
  readonly totalRecordCount: number;
}

export const chatRecordsPayloadV1Schema = z.strictObject({
  chatId: uuidv7Schema,
  records: z.array(chatRecordDtoV1Schema).readonly(),
  prevCursor: chatPageCursorDtoV1Schema.nullable(),
  totalRecordCount: nonNegativeIntSchema,
});

/**
 * `chat.records.older`'s payload (chat-scroll spec §6.2): one page of records OLDER than the
 * cursor the client sent, or the reason that page could not be read.
 *
 * The failure rides this event rather than a separate kind for two reasons the spec states:
 * one nullable field is cheaper than another member of a closed registry, and it retires the
 * UI's loading latch by the same path a success does. `diagnostics.changed` is deliberately
 * not the channel — it carries page and Gate diagnostics, not the outcome of a UI-issued
 * operation.
 *
 * WHEN `failure` IS NON-NULL the other three fields carry no information: `records` is empty,
 * `prevCursor` is `null` and `totalRecordCount` is `0`. The mirror must branch on `failure`
 * FIRST and leave its own cursor and window untouched — spec §7: "`prevCursor` is left as it
 * was so the load can be retried. No records are lost."
 */
export interface ChatRecordsOlderPayloadV1 {
  readonly chatId: UUIDv7;
  readonly records: readonly ChatRecordDtoV1[];
  readonly prevCursor: ChatPageCursorDtoV1 | null;
  readonly totalRecordCount: number;
  readonly failure: FailureDtoV1 | null;
}

export const chatRecordsOlderPayloadV1Schema = z.strictObject({
  chatId: uuidv7Schema,
  records: z.array(chatRecordDtoV1Schema).readonly(),
  prevCursor: chatPageCursorDtoV1Schema.nullable(),
  totalRecordCount: nonNegativeIntSchema,
  failure: failureDtoV1Schema.nullable(),
});

/** The selection DTO `selection.changed` carries when a selection exists (§9 row, KCC:826). */
export interface SelectionDtoV1 {
  readonly pageSlug: string;
  readonly elementId: string;
  readonly sourceHash: Sha256Hex;
}

const selectionDtoV1Schema = z.strictObject({
  pageSlug: pageSlugSchema,
  elementId: z.string().min(1),
  sourceHash: sha256HexSchema,
});

/** `selection.changed`'s payload (§9 row, KCC:826): "nullable selection DTO containing page slug, element id, and source hash." The payload itself is the nullable DTO, not a wrapper around it. */
export type SelectionChangedPayloadV1 = SelectionDtoV1 | null;
export const selectionChangedPayloadV1Schema = selectionDtoV1Schema.nullable();

/**
 * `pins.changed`'s payload (§9 row, KCC:827): "page slug, `affectedPins:
 * PinDtoV1[]`, affected record ids, and the transaction/action identity that
 * caused each persisted change." Modeled as one opaque `causeId` — the row does
 * not further discriminate whether that identity is a transaction or an action id,
 * and `pins.changed` is published once per Kernel operation that touched pins.
 */
export interface PinsChangedPayloadV1 {
  readonly pageSlug: string;
  readonly affectedPins: readonly PinDtoV1[];
  readonly affectedRecordIds: readonly UUIDv7[];
  readonly causeId: UUIDv7;
}

export const pinsChangedPayloadV1Schema = z.strictObject({
  pageSlug: pageSlugSchema,
  affectedPins: z.array(pinDtoV1Schema).readonly(),
  affectedRecordIds: z.array(uuidv7Schema).readonly(),
  causeId: uuidv7Schema,
});

/** `git.statusChanged`'s payload (§9 row, KCC:828) is exactly the shared Git status projection — see `GitStatusProjectionV1Placeholder`'s own TODO. */
export type GitStatusChangedPayloadV1 = GitStatusProjectionV1Placeholder;
export const gitStatusChangedPayloadV1Schema = gitStatusProjectionV1PlaceholderSchema;

/** `diagnostics.changed`'s payload, given verbatim (§9 row, KCC:829). */
export interface DiagnosticsChangedPayloadV1 {
  readonly generation: UInt64String;
  readonly upserts: readonly DiagnosticDtoV1[];
  readonly removedDiagnosticIds: readonly UUIDv7[];
}

export const diagnosticsChangedPayloadV1Schema = z.strictObject({
  generation: uint64StringSchema,
  upserts: z.array(diagnosticDtoV1Schema).readonly(),
  removedDiagnosticIds: z.array(uuidv7Schema).readonly(),
});

// ---------------------------------------------------------------------------
// The closed EventPayloadByKindV1 map (§9, KCC:715-759)
// ---------------------------------------------------------------------------

/** The exact type map §9 declares (KCC:715-759), transcribed with this file's type names. */
export type EventPayloadByKindV1 = Readonly<{
  "kernel.snapshot": KernelSnapshotPayloadV1;
  "kernel.stateChanged": KernelStateChangedPayloadV1;
  "kernel.capabilitiesChanged": KernelCapabilitiesChangedPayloadV1;
  "page.removePlanReady": PageRemovePlanReadyPayloadV1;
  "page.descriptorsChanged": PageDescriptorsChangedPayloadV1;
  "turn.started": TurnStartedPayloadV1;
  "turn.attemptStarted": TurnAttemptStartedPayloadV1;
  "turn.progress": TurnProgressPayloadV1;
  "turn.gateRejected": TurnGateRejectedPayloadV1;
  "turn.applyStarted": TurnApplyStartedPayloadV1;
  "turn.completed": TurnTerminalPayloadV1;
  "turn.failed": TurnTerminalPayloadV1;
  "turn.cancelled": TurnTerminalPayloadV1;
  "restore.planReady": RestorePlanReadyPayloadV1;
  "restore.started": RestoreStartedPayloadV1;
  "restore.recordPending": RestoreRecordPendingPayloadV1;
  "restore.completed": RestoreTerminalPayloadV1;
  "restore.failed": RestoreTerminalPayloadV1;
  "commit.planReady": CommitPlanReadyPayloadV1;
  "commit.started": CommitStartedPayloadV1;
  "commit.completed": CommitTerminalPayloadV1;
  "commit.failed": CommitTerminalPayloadV1;
  "export.started": ExportStartedPayloadV1;
  "export.progress": ExportProgressPayloadV1;
  "export.completed": ExportTerminalPayloadV1;
  "export.failed": ExportTerminalPayloadV1;
  "migration.planReady": MigrationPlanReadyPayloadV1;
  "migration.started": MigrationStartedPayloadV1;
  "migration.progress": MigrationProgressPayloadV1;
  "migration.completed": MigrationTerminalPayloadV1;
  "migration.failed": MigrationFailedPayloadV1;
  "preview.sourceChanged": PreviewSourceChangedPayloadV1;
  "preview.sessionReady": PreviewSessionReadyPayloadV1;
  "preview.geometryResult": PreviewGeometryResultPayloadV1;
  "preview.backpressured": PreviewBackpressurePayloadV1;
  "preview.writable": PreviewBackpressurePayloadV1;
  "preview.failed": PreviewFailurePayloadV1;
  "preview.circuitOpened": PreviewCircuitOpenedPayloadV1;
  "chat.changed": ChatChangedPayloadV1;
  "chat.records": ChatRecordsPayloadV1;
  "chat.records.older": ChatRecordsOlderPayloadV1;
  "selection.changed": SelectionChangedPayloadV1;
  "pins.changed": PinsChangedPayloadV1;
  "git.statusChanged": GitStatusChangedPayloadV1;
  "diagnostics.changed": DiagnosticsChangedPayloadV1;
}>;

/**
 * Binds the declared type map to `EventKindV1`. Without this, the map above is just a
 * hand-written object type: a dropped, misspelled, or wrongly-typed key produces no
 * error at all, because nothing relates it to the kind union or to the schema map. The
 * runtime `satisfies` on `eventPayloadV1SchemaByKind` protects only the schema side.
 *
 * Declared as a type-level assertion rather than a value so it costs nothing at runtime:
 * if a key is missing, `Record<EventKindV1, unknown>` is not satisfied and tsc fails; if
 * a key is misspelled, it is simultaneously missing and excess.
 */
type _EventPayloadMapIsExhaustive =
  EventPayloadByKindV1 extends Record<EventKindV1, unknown>
    ? Record<EventKindV1, unknown> extends Record<keyof EventPayloadByKindV1, unknown>
      ? true
      : ["event payload type map has a key that is not an EventKindV1"]
    : ["event payload type map is missing an EventKindV1"];
const _eventPayloadMapExhaustive: _EventPayloadMapIsExhaustive = true;
void _eventPayloadMapExhaustive;

/**
 * The runtime counterpart of `EventPayloadByKindV1`, keyed in `EVENT_KINDS_V1`'s
 * declared order. `satisfies Record<EventKindV1, z.ZodType>` is a compile-time
 * exhaustiveness check — dropping or misnaming a key here is a type error, not a
 * runtime surprise; the closure test additionally asserts the 43-key count and
 * order at runtime (§9: "Unknown event kinds ... are protocol errors").
 */
export const eventPayloadV1SchemaByKind = {
  "kernel.snapshot": kernelSnapshotPayloadV1Schema,
  "kernel.stateChanged": kernelStateChangedPayloadV1Schema,
  "kernel.capabilitiesChanged": kernelCapabilitiesChangedPayloadV1Schema,
  "page.removePlanReady": pageRemovePlanReadyPayloadV1Schema,
  "page.descriptorsChanged": pageDescriptorsChangedPayloadV1Schema,
  "turn.started": turnStartedPayloadV1Schema,
  "turn.attemptStarted": turnAttemptStartedPayloadV1Schema,
  "turn.progress": turnProgressPayloadV1Schema,
  "turn.gateRejected": turnGateRejectedPayloadV1Schema,
  "turn.applyStarted": turnApplyStartedPayloadV1Schema,
  "turn.completed": turnTerminalPayloadV1Schema,
  "turn.failed": turnTerminalPayloadV1Schema,
  "turn.cancelled": turnTerminalPayloadV1Schema,
  "restore.planReady": restorePlanReadyPayloadV1Schema,
  "restore.started": restoreStartedPayloadV1Schema,
  "restore.recordPending": restoreRecordPendingPayloadV1Schema,
  "restore.completed": restoreTerminalPayloadV1Schema,
  "restore.failed": restoreTerminalPayloadV1Schema,
  "commit.planReady": commitPlanReadyPayloadV1Schema,
  "commit.started": commitStartedPayloadV1Schema,
  "commit.completed": commitTerminalPayloadV1Schema,
  "commit.failed": commitTerminalPayloadV1Schema,
  "export.started": exportStartedPayloadV1Schema,
  "export.progress": exportProgressPayloadV1Schema,
  "export.completed": exportTerminalPayloadV1Schema,
  "export.failed": exportTerminalPayloadV1Schema,
  "migration.planReady": migrationPlanReadyPayloadV1Schema,
  "migration.started": migrationStartedPayloadV1Schema,
  "migration.progress": migrationProgressPayloadV1Schema,
  "migration.completed": migrationTerminalPayloadV1Schema,
  "migration.failed": migrationFailedPayloadV1Schema,
  "preview.sourceChanged": previewSourceChangedPayloadV1Schema,
  "preview.sessionReady": previewSessionReadyPayloadV1Schema,
  "preview.geometryResult": previewGeometryResultPayloadV1Schema,
  "preview.backpressured": previewBackpressurePayloadV1Schema,
  "preview.writable": previewBackpressurePayloadV1Schema,
  "preview.failed": previewFailurePayloadV1Schema,
  "preview.circuitOpened": previewCircuitOpenedPayloadV1Schema,
  "chat.changed": chatChangedPayloadV1Schema,
  "chat.records": chatRecordsPayloadV1Schema,
  "chat.records.older": chatRecordsOlderPayloadV1Schema,
  "selection.changed": selectionChangedPayloadV1Schema,
  "pins.changed": pinsChangedPayloadV1Schema,
  "git.statusChanged": gitStatusChangedPayloadV1Schema,
  "diagnostics.changed": diagnosticsChangedPayloadV1Schema,
} as const satisfies Record<EventKindV1, z.ZodType>;
