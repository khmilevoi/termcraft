import { z } from "zod"

import { rfc3339UtcSchema } from "infrastructure/clock"
import { pageSlugSchema } from "entities/page"
import type { AgentToolOp } from "entities/turn"

import { commandKindV1Schema, type CommandKindV1 } from "./command-kind"
import type { EventKindV1 } from "./event-kind"
import { failureDtoV1Schema, type FailureDtoV1 } from "./failure"
import { unavailableReasonV1Schema, type UnavailableReason } from "./unavailable-reason"
import { hostNonceSchema, sha256HexSchema, uuidv7Schema, type HostNonce, type Sha256Hex, type UUIDv7 } from "./ids"
import {
  diagnosticDtoV1Schema,
  frameIdentityV1Schema,
  frameTokenV1Schema,
  geometryTokenV1Schema,
  pageDescriptorChangeV1Schema,
  pageDescriptorV1Schema,
  pageRemovePlanV1Schema,
  pinDtoV1Schema,
  type DiagnosticDtoV1,
  type FrameIdentityV1,
  type FrameTokenV1,
  type GeometryTokenV1,
  type PageDescriptorChangeV1,
  type PageDescriptorV1,
  type PageRemovePlanV1,
  type PinDtoV1,
} from "./shared-dto"
import { uint64StringSchema, type UInt64String } from "./uint64"

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
 * Several fields depend on DTOs slice 6A does not build yet — the seven Reatom state
 * machines and their capability projection (6C), and Git's status projection (no
 * owning slice is named yet). Each such field uses a clearly-named `*Placeholder`
 * type with a `TODO` comment; none of them is presented as the final shape.
 * `FailureDtoV1` is a special case: another file in this same slice (6A) owns
 * `failure.ts` per the task split, so this file declares a local structural alias
 * instead of importing a module that does not exist yet — the controller repoints the
 * import when wiring the module up.
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

const nonNegativeIntSchema = z.number().int().nonnegative()
const positiveIntSchema = z.number().int().positive()

/** Attempts are integers 1 through 4 (§7.2, KCC:241: "Attempts are integers 1 through 4"). */
const turnAttemptV1Schema = z.number().int().min(1).max(4)

/**
 * A full Git object id, per KCC's own concrete typing of `sourceCommit` (see file
 * header). The spec says "FULL source commit id" repeatedly (KCC:804, KCC:807) to
 * contrast with the abbreviated hex prefixes Git itself accepts elsewhere; validated
 * here as lowercase hex at Git's two object-id lengths — 40 characters (the default
 * `sha1` object format) or 64 (the newer `sha256` object format, `git init
 * --object-format=sha256`). Both lengths are accepted because the spec does not fix
 * which object format a termcraft-managed repository uses.
 */
const FULL_GIT_OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/
const fullGitObjectIdSchema = z.string().regex(FULL_GIT_OBJECT_ID)

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
] as const

export type KernelModelIdV1 = (typeof KERNEL_MODEL_IDS_V1)[number]
const kernelModelIdV1Schema = z.enum(KERNEL_MODEL_IDS_V1)

/**
 * TODO(6C): `action`, `previousTag`, `nextTag`, and `metadata` become closed unions
 * scoped to each of the seven `reatom*StateMachine` factories once their named
 * transition tables land (§7.1-§7.7). `modelId` is the one part already fixed. This
 * whole payload is a structural placeholder for `kernel.stateChanged`; do not treat
 * `action`/`previousTag`/`nextTag` as plain free-text in the final DTO.
 */
export interface KernelStateChangedPayloadV1 {
  readonly modelId: KernelModelIdV1
  readonly action: string
  readonly previousTag: string
  readonly nextTag: string
  readonly metadata: Readonly<Record<string, unknown>>
}

export const kernelStateChangedPayloadV1Schema = z.strictObject({
  modelId: kernelModelIdV1Schema,
  action: z.string().min(1),
  previousTag: z.string().min(1),
  nextTag: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()),
})

/**
 * TODO(6C): `CapabilityState` (§10.1, KCC:852-857) is
 * `{ available: true } | { available: false, reasons: readonly [UnavailableReason, ...] }`
 * where `reasons` is a discriminated union over §11.1's 31 rejection codes with
 * per-code bounded details. This placeholder fixes only the `available` discriminant
 * and a non-empty bounded-object `reasons` array so callers of this file can compile;
 * it is not the final `UnavailableReason` shape.
 */
export type CapabilityStateV1Placeholder =
  | Readonly<{ available: true }>
  | Readonly<{ available: false; reasons: readonly [UnavailableReason, ...UnavailableReason[]] }>

const capabilityStateV1PlaceholderSchema = z.discriminatedUnion("available", [
  z.strictObject({ available: z.literal(true) }),
  z.strictObject({
    available: z.literal(false),
    // §10.1 fixes this as `readonly [UnavailableReason, ...UnavailableReason[]]`, and
    // `./unavailable-reason` already owns that closed union — only `target` (§10.1's
    // 43-row table) is still outstanding, and 6C owns it. Accepting a bare record here
    // would drop the code discrimination the UI branches on.
    reasons: z.tuple([unavailableReasonV1Schema], unavailableReasonV1Schema).readonly(),
  }),
])

/**
 * TODO(6C): `CapabilityEntry<K>`'s `target` field is `CapabilityTargetByKindV1[K]` —
 * a 43-member discriminated union over `CommandKindV1` (§10.1 table, KCC:875-901)
 * that `core/capabilities` owns (see `command-kind.ts`'s comment: "the identity is
 * enforced as a compile-time check in `core/capabilities`, not restated as a second
 * list"). `target` stays `unknown` here; only `id` (closed `CommandKindV1`) and the
 * `available`/`reasons` discriminant of `state` are fixed.
 */
export interface CapabilityEntryV1Placeholder {
  readonly id: CommandKindV1
  readonly target: unknown
  readonly state: CapabilityStateV1Placeholder
}

const capabilityEntryV1PlaceholderSchema = z.strictObject({
  id: commandKindV1Schema,
  target: z.unknown(),
  state: capabilityStateV1PlaceholderSchema,
})

/**
 * TODO: the closed Git status projection — "repository identity, `HEAD`, sequencer
 * state, and complete three-scope status summaries" (§9 row for `git.statusChanged`,
 * KCC:828) — has no concrete TS shape anywhere in this document; no phase-6 slice is
 * named as its owner yet either. Shared by `kernel.snapshot`, `git.statusChanged`,
 * and `commit.completed`/`commit.failed`'s "resulting Git status" so there is exactly
 * one placeholder to replace later, not three drifting ones.
 */
export interface GitStatusProjectionV1Placeholder {
  readonly repositoryId: string
  readonly head: string | null
  readonly sequencerState: string
  readonly scopes: Readonly<Record<string, unknown>>
}

const gitStatusProjectionV1PlaceholderSchema = z.strictObject({
  repositoryId: z.string().min(1),
  head: z.string().nullable(),
  sequencerState: z.string().min(1),
  scopes: z.record(z.string(), z.unknown()),
})

/**
 * TODO(6C): "all seven tagged model DTOs" (§9 row for `kernel.snapshot`, KCC:793).
 * The seven keys are fixed (mirroring §6's factory table domains); each value is a
 * placeholder for that machine's own tagged-union DTO, which does not exist until
 * the seven `reatom*StateMachine` factories land.
 */
export interface KernelModelsSnapshotV1Placeholder {
  readonly project: unknown
  readonly turn: unknown
  readonly restore: unknown
  readonly commit: unknown
  readonly export: unknown
  readonly preview: unknown
  readonly migration: unknown
}

const kernelModelsSnapshotV1PlaceholderSchema = z.strictObject({
  project: z.unknown(),
  turn: z.unknown(),
  restore: z.unknown(),
  commit: z.unknown(),
  export: z.unknown(),
  preview: z.unknown(),
  migration: z.unknown(),
})

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
 * drift by accident.
 */
export interface KernelSnapshotPayloadV1 {
  readonly models: KernelModelsSnapshotV1Placeholder
  readonly projectId: UUIDv7 | null
  readonly activePageSlug: string | null
  readonly activeChatId: UUIDv7 | null
  readonly trust: "trusted" | "untrusted-read-only" | null
  readonly capabilities: readonly CapabilityEntryV1Placeholder[]
  readonly pageDescriptors: readonly PageDescriptorV1[]
  readonly gitStatus: GitStatusProjectionV1Placeholder
  readonly eventSeq: UInt64String
}

export const kernelSnapshotPayloadV1Schema = z.strictObject({
  models: kernelModelsSnapshotV1PlaceholderSchema,
  projectId: uuidv7Schema.nullable(),
  activePageSlug: pageSlugSchema.nullable(),
  activeChatId: uuidv7Schema.nullable(),
  trust: z.enum(["trusted", "untrusted-read-only"]).nullable(),
  capabilities: z.array(capabilityEntryV1PlaceholderSchema).readonly(),
  pageDescriptors: z.array(pageDescriptorV1Schema).readonly(),
  gitStatus: gitStatusProjectionV1PlaceholderSchema,
  eventSeq: uint64StringSchema,
})

/**
 * `kernel.capabilitiesChanged`'s payload (§9 row, KCC:795): "Complete replacement
 * `CapabilityEntry` values for every changed `(id,target)` key and `removed` keys
 * for targets no longer published."
 */
export interface KernelCapabilitiesChangedPayloadV1 {
  readonly changed: readonly CapabilityEntryV1Placeholder[]
  readonly removed: readonly Readonly<{ id: CommandKindV1; target: unknown }>[]
}

export const kernelCapabilitiesChangedPayloadV1Schema = z.strictObject({
  changed: z.array(capabilityEntryV1PlaceholderSchema).readonly(),
  removed: z
    .array(z.strictObject({ id: commandKindV1Schema, target: z.unknown() }))
    .readonly(),
})

// ---------------------------------------------------------------------------
// page.removePlanReady / page.descriptorsChanged
// ---------------------------------------------------------------------------

/** `page.removePlanReady`'s payload (§9 row, KCC:796): "Complete `PageRemovePlanV1`." */
export type PageRemovePlanReadyPayloadV1 = PageRemovePlanV1
export const pageRemovePlanReadyPayloadV1Schema = pageRemovePlanV1Schema

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
] as const

export type PageDescriptorsChangedReasonV1 = (typeof PAGE_DESCRIPTORS_CHANGED_REASONS_V1)[number]

/**
 * `page.descriptorsChanged`'s payload, given verbatim (§9 row, KCC:797): "The
 * descriptor list is complete and ordered; each non-removed descriptor and every
 * change carries its exact before/after source-hash binding."
 */
export interface PageDescriptorsChangedPayloadV1 {
  readonly reason: PageDescriptorsChangedReasonV1
  readonly descriptors: readonly PageDescriptorV1[]
  readonly changes: readonly PageDescriptorChangeV1[]
  readonly activePageSlug: string | null
}

export const pageDescriptorsChangedPayloadV1Schema = z.strictObject({
  reason: z.enum(PAGE_DESCRIPTORS_CHANGED_REASONS_V1),
  descriptors: z.array(pageDescriptorV1Schema).readonly(),
  changes: z.array(pageDescriptorChangeV1Schema).readonly(),
  activePageSlug: pageSlugSchema.nullable(),
})

// ---------------------------------------------------------------------------
// turn.started / turn.attemptStarted / turn.progress / turn.gateRejected /
// turn.applyStarted / turn.completed|failed|cancelled
// ---------------------------------------------------------------------------

/** `turn.started`'s payload (§9 row, KCC:798): "`turnId`, captured `chatId`, and absolute deadline." */
export interface TurnStartedPayloadV1 {
  readonly turnId: UUIDv7
  readonly chatId: UUIDv7
  readonly deadline: string
}

export const turnStartedPayloadV1Schema = z.strictObject({
  turnId: uuidv7Schema,
  chatId: uuidv7Schema,
  deadline: rfc3339UtcSchema,
})

/**
 * `turn.attemptStarted`'s payload (§9 row, KCC:799): "`turnId`, `attempt`, and
 * absolute deadline; `leaseNonce` remains internal." — `leaseNonce` is deliberately
 * absent; the strict schema rejects it if a caller tries to add it back.
 */
export interface TurnAttemptStartedPayloadV1 {
  readonly turnId: UUIDv7
  readonly attempt: number
  readonly deadline: string
}

export const turnAttemptStartedPayloadV1Schema = z.strictObject({
  turnId: uuidv7Schema,
  attempt: turnAttemptV1Schema,
  deadline: rfc3339UtcSchema,
})

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
const AGENT_TOOL_OPS_V1 = ["read", "edit", "run", "search", "other"] as const satisfies readonly AgentToolOp[]

const turnProgressContentV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("reasoning"), text: z.string() }),
  z.strictObject({ kind: z.literal("tool"), op: z.enum(AGENT_TOOL_OPS_V1), target: z.string() }),
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
])

/** `turn.progress`'s payload (§9 row, KCC:800): "`turnId`, `attempt`, normalized progress kind, and bounded backend-neutral content after full internal lease validation." */
export interface TurnProgressPayloadV1 {
  readonly turnId: UUIDv7
  readonly attempt: number
  readonly content: z.infer<typeof turnProgressContentV1Schema>
}

export const turnProgressPayloadV1Schema = z.strictObject({
  turnId: uuidv7Schema,
  attempt: turnAttemptV1Schema,
  content: turnProgressContentV1Schema,
})

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
const GATE_ERROR_KINDS_V1 = ["import", "contract", "type", "manifest", "smoke"] as const
const GATE_WARNING_KINDS_V1 = [
  "dropped-id",
  "unpointed-element",
  "unguarded-timer",
  "unguarded-randomness",
  "unlisted-navigation",
] as const

const turnGateErrorV1Schema = z.strictObject({
  kind: z.enum(GATE_ERROR_KINDS_V1),
  code: z.string().min(1),
  message: z.string(),
  file: z.string().min(1).nullable(),
  line: positiveIntSchema.nullable(),
  column: positiveIntSchema.nullable(),
})

const turnGateWarningV1Schema = z.strictObject({
  kind: z.enum(GATE_WARNING_KINDS_V1),
  message: z.string(),
  line: positiveIntSchema.nullable(),
  column: positiveIntSchema.nullable(),
})

/** "bounded closed Gate diagnostics" (§9 row for `turn.gateRejected`, KCC:801). */
export interface TurnGateDiagnosticsV1 {
  readonly errors: readonly z.infer<typeof turnGateErrorV1Schema>[]
  readonly warnings: readonly z.infer<typeof turnGateWarningV1Schema>[]
}

const turnGateDiagnosticsV1Schema = z.strictObject({
  errors: z.array(turnGateErrorV1Schema).readonly(),
  warnings: z.array(turnGateWarningV1Schema).readonly(),
})

/**
 * `turn.gateRejected`'s payload (§9 row, KCC:801): "`turnId`, `attempt`, retry
 * number, and bounded closed Gate diagnostics." §9 itself only says "retry number"
 * with no numeric range; the 0-3 bound below is NOT spec-stated — it is this file's
 * own inference from §7.2's attempt budget (KCC:255: "Legal only while `attempt <
 * 4`"), since a turn can retry at most 3 times (once each after attempts 1-3 fail;
 * attempt 4 has no further retry).
 */
export interface TurnGateRejectedPayloadV1 {
  readonly turnId: UUIDv7
  readonly attempt: number
  readonly retryNumber: number
  readonly diagnostics: TurnGateDiagnosticsV1
}

export const turnGateRejectedPayloadV1Schema = z.strictObject({
  turnId: uuidv7Schema,
  attempt: turnAttemptV1Schema,
  retryNumber: z.number().int().min(0).max(3),
  diagnostics: turnGateDiagnosticsV1Schema,
})

/** `turn.applyStarted`'s payload (§9 row, KCC:802): "`turnId`, candidate hash, and affected page slugs." */
export interface TurnApplyStartedPayloadV1 {
  readonly turnId: UUIDv7
  readonly candidateHash: Sha256Hex
  readonly affectedPageSlugs: readonly string[]
}

export const turnApplyStartedPayloadV1Schema = z.strictObject({
  turnId: uuidv7Schema,
  candidateHash: sha256HexSchema,
  affectedPageSlugs: z.array(pageSlugSchema).readonly(),
})

/**
 * The `turn.completed`/`turn.failed`/`turn.cancelled` outcome. §7.2 fixes the
 * `terminal` sub-state's failure-side codes verbatim ("`terminal` carries `failed |
 * cancelled | stale | interrupted`", KCC:234); `"completed"` is added here for the
 * separate `committed -> settle -> idle` success path (KCC:260, "Emits changed
 * pages, chat result, pin changes, and resulting hashes"), which needs a code of its
 * own because all three event kinds share this one payload type (§9 map, KCC:726-728).
 */
const TURN_OUTCOME_CODES_V1 = ["completed", "failed", "cancelled", "stale", "interrupted"] as const
export type TurnOutcomeCodeV1 = (typeof TURN_OUTCOME_CODES_V1)[number]

/** One bounded warning carried on a terminal turn event, matching the code/safeMessage shape already fixed for `DiagnosticDtoV1`/`PageDescriptorV1`'s error. */
export interface TurnWarningV1 {
  readonly code: string
  readonly safeMessage: string
}

const turnWarningV1Schema = z.strictObject({
  code: z.string().min(1),
  safeMessage: z.string(),
})

/**
 * `turn.completed`, `turn.failed`, `turn.cancelled`'s shared payload (§9 row,
 * KCC:803): "`turnId`, exact outcome code, changed page slugs, resulting source
 * hashes, bounded warnings, and nullable closed failure DTO." Page slug and its
 * resulting hash are paired in one object per page, the same pairing style
 * `PageDescriptorChangeV1` already uses for before/after hashes, rather than two
 * parallel arrays whose index-correlation is easy to break.
 */
export interface TurnTerminalPayloadV1 {
  readonly turnId: UUIDv7
  readonly outcome: TurnOutcomeCodeV1
  readonly changedPages: readonly Readonly<{ pageSlug: string; sourceHash: Sha256Hex }>[]
  readonly warnings: readonly TurnWarningV1[]
  readonly failure: FailureDtoV1 | null
}

export const turnTerminalPayloadV1Schema = z.strictObject({
  turnId: uuidv7Schema,
  outcome: z.enum(TURN_OUTCOME_CODES_V1),
  changedPages: z
    .array(z.strictObject({ pageSlug: pageSlugSchema, sourceHash: sha256HexSchema }))
    .readonly(),
  warnings: z.array(turnWarningV1Schema).readonly(),
  failure: failureDtoV1Schema.nullable(),
})

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
  readonly restorePlanId: UUIDv7
  readonly pageSlug: string
  readonly sourceCommitId: string
  readonly blobHash: string
  readonly preRestoreSourceHash: Sha256Hex
  readonly indexState: "clean" | "unstaged"
  readonly gateAttestationHash: Sha256Hex
  readonly planRevision: UInt64String
  readonly willOverwrite: boolean
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
})

/** `restore.started`'s payload (§9 row, KCC:805): "`restorePlanId`, `restoreActionId`, page slug, full source commit id, and safe target-chat display identity." */
export interface RestoreStartedPayloadV1 {
  readonly restorePlanId: UUIDv7
  readonly restoreActionId: UUIDv7
  readonly pageSlug: string
  readonly sourceCommitId: string
  readonly safeTargetChatDisplay: string
}

export const restoreStartedPayloadV1Schema = z.strictObject({
  restorePlanId: uuidv7Schema,
  restoreActionId: uuidv7Schema,
  pageSlug: pageSlugSchema,
  sourceCommitId: fullGitObjectIdSchema,
  safeTargetChatDisplay: z.string(),
})

/** `restore.recordPending`'s payload (§9 row, KCC:806): "`restoreActionId`, page slug, full source commit id, and safe target-chat display identity." */
export interface RestoreRecordPendingPayloadV1 {
  readonly restoreActionId: UUIDv7
  readonly pageSlug: string
  readonly sourceCommitId: string
  readonly safeTargetChatDisplay: string
}

export const restoreRecordPendingPayloadV1Schema = z.strictObject({
  restoreActionId: uuidv7Schema,
  pageSlug: pageSlugSchema,
  sourceCommitId: fullGitObjectIdSchema,
  safeTargetChatDisplay: z.string(),
})

/**
 * `restore.completed`/`restore.failed`'s shared payload (§9 row, KCC:807):
 * "`restorePlanId`, nullable `restoreActionId`, page slug, full source commit id,
 * phase, and nullable closed failure DTO." `phase` is the subset of `RestoreState`
 * (§7.3) that can reach `idle` through `complete`/`failBeforeIntent`:
 * `executing`, `record-pending`, `recovering` (KCC:289-291).
 */
export interface RestoreTerminalPayloadV1 {
  readonly restorePlanId: UUIDv7
  readonly restoreActionId: UUIDv7 | null
  readonly pageSlug: string
  readonly sourceCommitId: string
  readonly phase: "executing" | "record-pending" | "recovering"
  readonly failure: FailureDtoV1 | null
}

export const restoreTerminalPayloadV1Schema = z.strictObject({
  restorePlanId: uuidv7Schema,
  restoreActionId: uuidv7Schema.nullable(),
  pageSlug: pageSlugSchema,
  sourceCommitId: fullGitObjectIdSchema,
  phase: z.enum(["executing", "record-pending", "recovering"]),
  failure: failureDtoV1Schema.nullable(),
})

// ---------------------------------------------------------------------------
// commit.planReady / commit.started / commit.completed|failed
// ---------------------------------------------------------------------------

/** The closed commit scope, given verbatim in §10.1's `commit.plan` target row (KCC:897). */
const COMMIT_SCOPES_V1 = ["current-page", "infrastructure", "whole-project"] as const
export type CommitScopeV1 = (typeof COMMIT_SCOPES_V1)[number]

const commitScopeV1Schema = z.enum(COMMIT_SCOPES_V1)

/** One path entry in a commit plan's preview, per §7.4 (KCC:312: "exact added/modified/deleted paths, states, content hashes"). `contentHash` is null for a `deleted` path. */
const commitPathPreviewV1Schema = z.strictObject({
  path: z.string().min(1),
  state: z.enum(["added", "modified", "deleted"]),
  contentHash: fullGitObjectIdSchema.nullable(),
})

/**
 * `commit.planReady`'s payload (§9 row, KCC:808): "`commitPlanId`, scope, expected
 * `HEAD`, exact path/state/hash preview, message template, and detached-HEAD
 * warning flag."
 */
export interface CommitPlanReadyPayloadV1 {
  readonly commitPlanId: UUIDv7
  readonly scope: CommitScopeV1
  readonly expectedHead: string
  readonly paths: readonly z.infer<typeof commitPathPreviewV1Schema>[]
  readonly messageTemplate: string
  readonly detachedHeadWarning: boolean
}

export const commitPlanReadyPayloadV1Schema = z.strictObject({
  commitPlanId: uuidv7Schema,
  scope: commitScopeV1Schema,
  expectedHead: fullGitObjectIdSchema,
  paths: z.array(commitPathPreviewV1Schema).readonly(),
  messageTemplate: z.string(),
  detachedHeadWarning: z.boolean(),
})

/** `commit.started`'s payload (§9 row, KCC:809): "`commitPlanId`, execution `operationId`, scope, and exact selected paths." */
export interface CommitStartedPayloadV1 {
  readonly commitPlanId: UUIDv7
  readonly operationId: UUIDv7
  readonly scope: CommitScopeV1
  readonly selectedPaths: readonly string[]
}

export const commitStartedPayloadV1Schema = z.strictObject({
  commitPlanId: uuidv7Schema,
  operationId: uuidv7Schema,
  scope: commitScopeV1Schema,
  selectedPaths: z.array(z.string().min(1)).readonly(),
})

/**
 * `commit.completed`/`commit.failed`'s shared payload (§9 row, KCC:810):
 * "`commitPlanId`, execution `operationId`, scope, resulting Git status, and
 * nullable closed failure DTO." Reuses the shared `GitStatusProjectionV1Placeholder`
 * for "resulting Git status" — see that type's own TODO.
 */
export interface CommitTerminalPayloadV1 {
  readonly commitPlanId: UUIDv7
  readonly operationId: UUIDv7
  readonly scope: CommitScopeV1
  readonly gitStatus: GitStatusProjectionV1Placeholder
  readonly failure: FailureDtoV1 | null
}

export const commitTerminalPayloadV1Schema = z.strictObject({
  commitPlanId: uuidv7Schema,
  operationId: uuidv7Schema,
  scope: commitScopeV1Schema,
  gitStatus: gitStatusProjectionV1PlaceholderSchema,
  failure: failureDtoV1Schema.nullable(),
})

// ---------------------------------------------------------------------------
// export.started / export.progress / export.completed|failed
// ---------------------------------------------------------------------------

/** The in-flight `ExportState` phases progress/terminal events can name (§7.5: `kernel.export.beginRendering` -> `rendering`, `kernel.export.beginPublication` -> `publishing`). */
const EXPORT_PHASES_V1 = ["rendering", "publishing"] as const
export type ExportPhaseV1 = (typeof EXPORT_PHASES_V1)[number]

/** `export.started`'s payload (§9 row, KCC:811): "export `operationId`, immutable source-snapshot digest, page count, render-job count, and destination identity." */
export interface ExportStartedPayloadV1 {
  readonly operationId: UUIDv7
  readonly sourceSnapshotDigest: Sha256Hex
  readonly pageCount: number
  readonly renderJobCount: number
  readonly destination: string
}

export const exportStartedPayloadV1Schema = z.strictObject({
  operationId: uuidv7Schema,
  sourceSnapshotDigest: sha256HexSchema,
  pageCount: nonNegativeIntSchema,
  renderJobCount: nonNegativeIntSchema,
  destination: z.string().min(1),
})

/** `export.progress`'s payload (§9 row, KCC:812): "export `operationId`, phase, completed jobs, total jobs, nullable page slug, and nullable size." */
export interface ExportProgressPayloadV1 {
  readonly operationId: UUIDv7
  readonly phase: ExportPhaseV1
  readonly completedJobs: number
  readonly totalJobs: number
  readonly pageSlug: string | null
  readonly sizeBytes: number | null
}

export const exportProgressPayloadV1Schema = z.strictObject({
  operationId: uuidv7Schema,
  phase: z.enum(EXPORT_PHASES_V1),
  completedJobs: nonNegativeIntSchema,
  totalJobs: nonNegativeIntSchema,
  pageSlug: pageSlugSchema.nullable(),
  sizeBytes: nonNegativeIntSchema.nullable(),
})

/** `export.completed`/`export.failed`'s shared payload (§9 row, KCC:813): "export `operationId`, phase, destination identity, nullable generation id, and nullable closed failure DTO." */
export interface ExportTerminalPayloadV1 {
  readonly operationId: UUIDv7
  readonly phase: ExportPhaseV1
  readonly destination: string
  readonly generationId: UUIDv7 | null
  readonly failure: FailureDtoV1 | null
}

export const exportTerminalPayloadV1Schema = z.strictObject({
  operationId: uuidv7Schema,
  phase: z.enum(EXPORT_PHASES_V1),
  destination: z.string().min(1),
  generationId: uuidv7Schema.nullable(),
  failure: failureDtoV1Schema.nullable(),
})

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
  readonly relativePath: string
  readonly fileKind: string
  readonly beforeHash: string
  readonly fromVersion: number
  readonly toVersion: number
  readonly sizeBytes: number
}

const migrationRewriteEntryV1Schema = z.strictObject({
  relativePath: z.string().min(1),
  fileKind: z.string().min(1),
  beforeHash: fullGitObjectIdSchema,
  fromVersion: positiveIntSchema,
  toVersion: positiveIntSchema,
  sizeBytes: nonNegativeIntSchema,
})

/**
 * `migration.planReady`'s payload (§9 row, KCC:814): "`migrationPlanId`, exact
 * selected file-kind scope, exact rewrite entries ..., backup bytes, required free
 * bytes, and plan revision."
 */
export interface MigrationPlanReadyPayloadV1 {
  readonly migrationPlanId: UUIDv7
  readonly selectedFileKinds: readonly string[]
  readonly rewriteEntries: readonly MigrationRewriteEntryV1[]
  readonly backupBytes: number
  readonly requiredFreeBytes: number
  readonly planRevision: UInt64String
}

export const migrationPlanReadyPayloadV1Schema = z.strictObject({
  migrationPlanId: uuidv7Schema,
  selectedFileKinds: z.array(z.string().min(1)).readonly(),
  rewriteEntries: z.array(migrationRewriteEntryV1Schema).readonly(),
  backupBytes: nonNegativeIntSchema,
  requiredFreeBytes: nonNegativeIntSchema,
  planRevision: uint64StringSchema,
})

/** `migration.started`'s payload (§9 row, KCC:815): "`migrationPlanId`, `migrationActionId`, selected scope, and phase `backing-up`." */
export interface MigrationStartedPayloadV1 {
  readonly migrationPlanId: UUIDv7
  readonly migrationActionId: UUIDv7
  readonly selectedFileKinds: readonly string[]
  readonly phase: "backing-up"
}

export const migrationStartedPayloadV1Schema = z.strictObject({
  migrationPlanId: uuidv7Schema,
  migrationActionId: uuidv7Schema,
  selectedFileKinds: z.array(z.string().min(1)).readonly(),
  phase: z.literal("backing-up"),
})

/** The closed migration phase union, given verbatim (§9 row for `migration.progress`, KCC:816). */
const MIGRATION_PHASES_V1 = ["backing-up", "transforming", "publishing", "recovering"] as const
export type MigrationPhaseV1 = (typeof MIGRATION_PHASES_V1)[number]

/** `migration.progress`'s payload (§9 row, KCC:816): "`migrationPlanId`, `migrationActionId`, phase ..., completed items, total items, and nullable relative path." */
export interface MigrationProgressPayloadV1 {
  readonly migrationPlanId: UUIDv7
  readonly migrationActionId: UUIDv7
  readonly phase: MigrationPhaseV1
  readonly completedItems: number
  readonly totalItems: number
  readonly relativePath: string | null
}

export const migrationProgressPayloadV1Schema = z.strictObject({
  migrationPlanId: uuidv7Schema,
  migrationActionId: uuidv7Schema,
  phase: z.enum(MIGRATION_PHASES_V1),
  completedItems: nonNegativeIntSchema,
  totalItems: nonNegativeIntSchema,
  relativePath: z.string().min(1).nullable(),
})

/**
 * `migration.completed`'s payload (§9 row, KCC:817): "`migrationPlanId`,
 * `migrationActionId`, transaction id, migrated-file count, resulting version map,
 * and `recovered` boolean." "Resulting version map" is `fileKind -> version`,
 * consistent with `MigrationRewriteEntryV1`'s integer `toVersion`.
 */
export interface MigrationTerminalPayloadV1 {
  readonly migrationPlanId: UUIDv7
  readonly migrationActionId: UUIDv7
  readonly transactionId: UUIDv7
  readonly migratedFileCount: number
  readonly resultingVersions: Readonly<Record<string, number>>
  readonly recovered: boolean
}

export const migrationTerminalPayloadV1Schema = z.strictObject({
  migrationPlanId: uuidv7Schema,
  migrationActionId: uuidv7Schema,
  transactionId: uuidv7Schema,
  migratedFileCount: nonNegativeIntSchema,
  resultingVersions: z.record(z.string().min(1), positiveIntSchema),
  recovered: z.boolean(),
})

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
})

const migrationFailedPostPlanVariantV1Schema = z.strictObject({
  migrationPlanId: uuidv7Schema,
  migrationActionId: uuidv7Schema,
  transactionId: uuidv7Schema.nullable(),
  phase: z.enum(MIGRATION_PHASES_V1),
  failure: failureDtoV1Schema,
})

export type MigrationFailedPayloadV1 =
  | Readonly<{
      migrationPlanId: null
      migrationActionId: null
      transactionId: null
      phase: "planning"
      failure: FailureDtoV1
    }>
  | Readonly<{
      migrationPlanId: UUIDv7
      migrationActionId: UUIDv7
      transactionId: UUIDv7 | null
      phase: MigrationPhaseV1
      failure: FailureDtoV1
    }>

export const migrationFailedPayloadV1Schema = z.discriminatedUnion("phase", [
  migrationFailedPlanningVariantV1Schema,
  migrationFailedPostPlanVariantV1Schema,
])

// ---------------------------------------------------------------------------
// preview.sourceChanged / preview.sessionReady / preview.geometryResult /
// preview.backpressured|writable / preview.failed / preview.circuitOpened
// ---------------------------------------------------------------------------

/** `preview.setMode`'s closed interaction-mode union, given verbatim in §10.1 (KCC:888). */
const INTERACTION_MODES_V1 = ["static", "interactive"] as const
export type InteractionModeV1 = (typeof INTERACTION_MODES_V1)[number]

/** A preview source selector: canonical Current design, or a full historical commit (§9 row, KCC:819: "`current` or full historical commit id"). */
const previewSourceSelectorV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("current") }),
  z.strictObject({ kind: z.literal("historical"), sourceCommit: fullGitObjectIdSchema }),
])

/**
 * `preview.sourceChanged`'s payload (§9 row, KCC:819): "`previewSessionId`, page
 * slug, source selector ..., source hash, and host mode." `hostMode` is an opaque
 * HostSupervisor-defined mode string — its closed union lives in the host-
 * supervision-protocol design, not this document, so it is not enumerated here.
 */
export interface PreviewSourceChangedPayloadV1 {
  readonly previewSessionId: UUIDv7
  readonly pageSlug: string
  readonly source: z.infer<typeof previewSourceSelectorV1Schema>
  readonly sourceHash: Sha256Hex
  readonly hostMode: string
}

export const previewSourceChangedPayloadV1Schema = z.strictObject({
  previewSessionId: uuidv7Schema,
  pageSlug: pageSlugSchema,
  source: previewSourceSelectorV1Schema,
  sourceHash: sha256HexSchema,
  hostMode: z.string().min(1),
})

/** `preview.sessionReady`'s payload (§9 row, KCC:820): "`previewSessionId`, current nonce, page slug, source hash, host mode, interaction mode, size, theme, and initial frame sequence." */
export interface PreviewSessionReadyPayloadV1 {
  readonly previewSessionId: UUIDv7
  readonly nonce: HostNonce
  readonly pageSlug: string
  readonly sourceHash: Sha256Hex
  readonly hostMode: string
  readonly interactionMode: InteractionModeV1
  readonly size: Readonly<{ w: number; h: number }>
  readonly theme: string
  readonly initialFrameSeq: UInt64String
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
})

/** The closed geometry-query-kind union, given verbatim in §10.1 (KCC:890). */
const PREVIEW_QUERY_KINDS_V1 = ["hit", "rect", "describe", "layout", "pin-anchor"] as const
export type PreviewQueryKindV1 = (typeof PREVIEW_QUERY_KINDS_V1)[number]

/**
 * TODO: "closed geometry result" (§9 row for `preview.geometryResult`, KCC:821) is
 * defined by the host-supervision-protocol design, not this document. Structural
 * placeholder only.
 */
const previewGeometryResultV1PlaceholderSchema = z.record(z.string(), z.unknown())

/**
 * `preview.geometryResult`'s payload (§9 row, KCC:821): "`previewSessionId`,
 * `frameTokenId`, queried `FrameIdentityV1`, query kind, closed geometry result,
 * and `geometryToken: GeometryTokenV1 | null`; the token is non-null only for a
 * successful resolving `hit` or `pin-anchor` query." That "only for" rule is a
 * producer invariant, not something this schema enforces — `geometryToken` is
 * simply nullable for every `queryKind`.
 */
export interface PreviewGeometryResultPayloadV1 {
  readonly previewSessionId: UUIDv7
  readonly frameTokenId: FrameTokenV1
  readonly frameIdentity: FrameIdentityV1
  readonly queryKind: PreviewQueryKindV1
  readonly result: Readonly<Record<string, unknown>>
  readonly geometryToken: GeometryTokenV1 | null
}

export const previewGeometryResultPayloadV1Schema = z.strictObject({
  previewSessionId: uuidv7Schema,
  frameTokenId: frameTokenV1Schema,
  frameIdentity: frameIdentityV1Schema,
  queryKind: z.enum(PREVIEW_QUERY_KINDS_V1),
  result: previewGeometryResultV1PlaceholderSchema,
  geometryToken: geometryTokenV1Schema.nullable(),
})

/** `preview.backpressured`/`preview.writable`'s shared payload (§9 row, KCC:822): "`previewSessionId`, current nonce, ordered-queue size, capacity, and low-water mark." */
export interface PreviewBackpressurePayloadV1 {
  readonly previewSessionId: UUIDv7
  readonly nonce: HostNonce
  readonly queueSize: number
  readonly capacity: number
  readonly lowWaterMark: number
}

export const previewBackpressurePayloadV1Schema = z.strictObject({
  previewSessionId: uuidv7Schema,
  nonce: hostNonceSchema,
  queueSize: nonNegativeIntSchema,
  capacity: positiveIntSchema,
  lowWaterMark: nonNegativeIntSchema,
})

/**
 * `preview.failed`'s payload (§9 row, KCC:823): "`previewSessionId`, current
 * nonce, page slug, source hash, lifecycle phase, and closed host failure." `phase`
 * is the `PreviewState` set `sessionFailed` can fire from (§7.6, KCC:365).
 */
export interface PreviewFailurePayloadV1 {
  readonly previewSessionId: UUIDv7
  readonly nonce: HostNonce
  readonly pageSlug: string
  readonly sourceHash: Sha256Hex
  readonly phase: "starting" | "switching" | "live"
  readonly failure: FailureDtoV1
}

export const previewFailurePayloadV1Schema = z.strictObject({
  previewSessionId: uuidv7Schema,
  nonce: hostNonceSchema,
  pageSlug: pageSlugSchema,
  sourceHash: sha256HexSchema,
  phase: z.enum(["starting", "switching", "live"]),
  failure: failureDtoV1Schema,
})

/**
 * `preview.circuitOpened`'s payload (§9 row, KCC:824): "`previewSessionId`, page
 * slug, source hash, attempts, final failure, and retry capability state." "retry
 * capability state" reuses the same `CapabilityStateV1Placeholder` TODO'd above for
 * `kernel.capabilitiesChanged` — see that type's comment.
 */
export interface PreviewCircuitOpenedPayloadV1 {
  readonly previewSessionId: UUIDv7
  readonly pageSlug: string
  readonly sourceHash: Sha256Hex
  readonly attempts: number
  readonly finalFailure: FailureDtoV1
  readonly retryCapability: CapabilityStateV1Placeholder
}

export const previewCircuitOpenedPayloadV1Schema = z.strictObject({
  previewSessionId: uuidv7Schema,
  pageSlug: pageSlugSchema,
  sourceHash: sha256HexSchema,
  attempts: positiveIntSchema,
  finalFailure: failureDtoV1Schema,
  retryCapability: capabilityStateV1PlaceholderSchema,
})

// ---------------------------------------------------------------------------
// chat.changed / selection.changed / pins.changed / git.statusChanged /
// diagnostics.changed
// ---------------------------------------------------------------------------

/**
 * A chat summary as `chat.changed` carries it. Fields are limited to what is
 * already real and landed on `ChatHeader` (`entities/chat/types.ts`: `chatId`,
 * `createdAt`) — no display-title/preview-text field is invented here because no
 * source in this slice's scope fixes one.
 */
export interface ChatSummaryV1 {
  readonly chatId: UUIDv7
  readonly createdAt: string
}

const chatSummaryV1Schema = z.strictObject({
  chatId: uuidv7Schema,
  createdAt: rfc3339UtcSchema,
})

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
  readonly activeChatId: UUIDv7
  readonly added: readonly ChatSummaryV1[]
  readonly updated: readonly ChatSummaryV1[]
  readonly removedChatIds: readonly UUIDv7[]
}

export const chatChangedPayloadV1Schema = z.strictObject({
  activeChatId: uuidv7Schema,
  added: z.array(chatSummaryV1Schema).readonly(),
  updated: z.array(chatSummaryV1Schema).readonly(),
  removedChatIds: z.array(uuidv7Schema).readonly(),
})

/** The selection DTO `selection.changed` carries when a selection exists (§9 row, KCC:826). */
export interface SelectionDtoV1 {
  readonly pageSlug: string
  readonly elementId: string
  readonly sourceHash: Sha256Hex
}

const selectionDtoV1Schema = z.strictObject({
  pageSlug: pageSlugSchema,
  elementId: z.string().min(1),
  sourceHash: sha256HexSchema,
})

/** `selection.changed`'s payload (§9 row, KCC:826): "nullable selection DTO containing page slug, element id, and source hash." The payload itself is the nullable DTO, not a wrapper around it. */
export type SelectionChangedPayloadV1 = SelectionDtoV1 | null
export const selectionChangedPayloadV1Schema = selectionDtoV1Schema.nullable()

/**
 * `pins.changed`'s payload (§9 row, KCC:827): "page slug, `affectedPins:
 * PinDtoV1[]`, affected record ids, and the transaction/action identity that
 * caused each persisted change." Modeled as one opaque `causeId` — the row does
 * not further discriminate whether that identity is a transaction or an action id,
 * and `pins.changed` is published once per Kernel operation that touched pins.
 */
export interface PinsChangedPayloadV1 {
  readonly pageSlug: string
  readonly affectedPins: readonly PinDtoV1[]
  readonly affectedRecordIds: readonly UUIDv7[]
  readonly causeId: UUIDv7
}

export const pinsChangedPayloadV1Schema = z.strictObject({
  pageSlug: pageSlugSchema,
  affectedPins: z.array(pinDtoV1Schema).readonly(),
  affectedRecordIds: z.array(uuidv7Schema).readonly(),
  causeId: uuidv7Schema,
})

/** `git.statusChanged`'s payload (§9 row, KCC:828) is exactly the shared Git status projection — see `GitStatusProjectionV1Placeholder`'s own TODO. */
export type GitStatusChangedPayloadV1 = GitStatusProjectionV1Placeholder
export const gitStatusChangedPayloadV1Schema = gitStatusProjectionV1PlaceholderSchema

/** `diagnostics.changed`'s payload, given verbatim (§9 row, KCC:829). */
export interface DiagnosticsChangedPayloadV1 {
  readonly generation: UInt64String
  readonly upserts: readonly DiagnosticDtoV1[]
  readonly removedDiagnosticIds: readonly UUIDv7[]
}

export const diagnosticsChangedPayloadV1Schema = z.strictObject({
  generation: uint64StringSchema,
  upserts: z.array(diagnosticDtoV1Schema).readonly(),
  removedDiagnosticIds: z.array(uuidv7Schema).readonly(),
})

// ---------------------------------------------------------------------------
// The closed EventPayloadByKindV1 map (§9, KCC:715-759)
// ---------------------------------------------------------------------------

/** The exact type map §9 declares (KCC:715-759), transcribed with this file's type names. */
export type EventPayloadByKindV1 = Readonly<{
  "kernel.snapshot": KernelSnapshotPayloadV1
  "kernel.stateChanged": KernelStateChangedPayloadV1
  "kernel.capabilitiesChanged": KernelCapabilitiesChangedPayloadV1
  "page.removePlanReady": PageRemovePlanReadyPayloadV1
  "page.descriptorsChanged": PageDescriptorsChangedPayloadV1
  "turn.started": TurnStartedPayloadV1
  "turn.attemptStarted": TurnAttemptStartedPayloadV1
  "turn.progress": TurnProgressPayloadV1
  "turn.gateRejected": TurnGateRejectedPayloadV1
  "turn.applyStarted": TurnApplyStartedPayloadV1
  "turn.completed": TurnTerminalPayloadV1
  "turn.failed": TurnTerminalPayloadV1
  "turn.cancelled": TurnTerminalPayloadV1
  "restore.planReady": RestorePlanReadyPayloadV1
  "restore.started": RestoreStartedPayloadV1
  "restore.recordPending": RestoreRecordPendingPayloadV1
  "restore.completed": RestoreTerminalPayloadV1
  "restore.failed": RestoreTerminalPayloadV1
  "commit.planReady": CommitPlanReadyPayloadV1
  "commit.started": CommitStartedPayloadV1
  "commit.completed": CommitTerminalPayloadV1
  "commit.failed": CommitTerminalPayloadV1
  "export.started": ExportStartedPayloadV1
  "export.progress": ExportProgressPayloadV1
  "export.completed": ExportTerminalPayloadV1
  "export.failed": ExportTerminalPayloadV1
  "migration.planReady": MigrationPlanReadyPayloadV1
  "migration.started": MigrationStartedPayloadV1
  "migration.progress": MigrationProgressPayloadV1
  "migration.completed": MigrationTerminalPayloadV1
  "migration.failed": MigrationFailedPayloadV1
  "preview.sourceChanged": PreviewSourceChangedPayloadV1
  "preview.sessionReady": PreviewSessionReadyPayloadV1
  "preview.geometryResult": PreviewGeometryResultPayloadV1
  "preview.backpressured": PreviewBackpressurePayloadV1
  "preview.writable": PreviewBackpressurePayloadV1
  "preview.failed": PreviewFailurePayloadV1
  "preview.circuitOpened": PreviewCircuitOpenedPayloadV1
  "chat.changed": ChatChangedPayloadV1
  "selection.changed": SelectionChangedPayloadV1
  "pins.changed": PinsChangedPayloadV1
  "git.statusChanged": GitStatusChangedPayloadV1
  "diagnostics.changed": DiagnosticsChangedPayloadV1
}>

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
type _EventPayloadMapIsExhaustive = EventPayloadByKindV1 extends Record<EventKindV1, unknown>
  ? Record<EventKindV1, unknown> extends Record<keyof EventPayloadByKindV1, unknown>
    ? true
    : ["event payload type map has a key that is not an EventKindV1"]
  : ["event payload type map is missing an EventKindV1"]
const _eventPayloadMapExhaustive: _EventPayloadMapIsExhaustive = true
void _eventPayloadMapExhaustive

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
  "selection.changed": selectionChangedPayloadV1Schema,
  "pins.changed": pinsChangedPayloadV1Schema,
  "git.statusChanged": gitStatusChangedPayloadV1Schema,
  "diagnostics.changed": diagnosticsChangedPayloadV1Schema,
} as const satisfies Record<EventKindV1, z.ZodType>
