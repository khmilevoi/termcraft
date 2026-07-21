import { z } from "zod"

import { pageSlugSchema } from "entities/page"

import { uuidv7Schema } from "./ids"
import { uint64StringSchema } from "./uint64"

/**
 * kernel-command-contract §11.1: "`UnavailableReason` is a discriminated union using
 * these stable codes plus bounded, code-specific details such as active `turnId`,
 * scope, page slug, plan id, or required revision. User-facing prose is presentation
 * data; callers branch on codes, never message text."
 *
 * The spec fixes the 31 codes (§11.1's table) and names the categories of bounded
 * detail, but not which code carries which detail, nor the exact contents of the
 * "stable priority table" §10.1 requires for the primary hint. Both mappings below are
 * this module's own encoding — the closest 1:1 fit to each code's §11.1 meaning — not a
 * spec-verbatim transcription.
 *
 * Every variant is `z.strictObject`, matching `shared-dto.ts`: an unknown key on a
 * reason (e.g. a stray display-message field) is a bug to surface, not data to strip.
 */

/** The plan families §11.1's `PLAN_NOT_FOUND`/`PLAN_STALE` rows name: "Page-removal, Restore, commit, or migration plan id". */
const PLAN_KINDS = ["pageRemove", "restore", "commit", "migration"] as const

/**
 * The single 31-code registry for §11.1's code space, in table order. `command-result.ts`
 * re-exports this as `COMMAND_REJECTION_CODES_V1` rather than transcribing it a second
 * time — §11.1 defines one code space, and two hand-maintained copies that must agree,
 * with nothing forcing them to, is a silent-divergence bug waiting to happen.
 */
export const REASON_CODES_V1 = [
  "UNSUPPORTED_PROTOCOL",
  "INVALID_ENVELOPE",
  "COMMAND_ID_REUSE_MISMATCH",
  "COMMAND_ID_EXPIRED",
  "COMMAND_DEDUPE_CAPACITY",
  "STALE_REVISION",
  "PROJECT_NOT_READY",
  "PROJECT_UNTRUSTED",
  "TURN_ALREADY_ACTIVE",
  "TURN_RUNNING",
  "TURN_NOT_ACTIVE",
  "TURN_ID_MISMATCH",
  "CANCEL_TOO_LATE",
  "HISTORICAL_PREVIEW_READ_ONLY",
  "GIT_UNAVAILABLE",
  "NOT_GIT_REPOSITORY",
  "GIT_SCOPE_CLEAN",
  "GIT_SEQUENCER_ACTIVE",
  "SOURCE_STAGED",
  "PLAN_NOT_FOUND",
  "PLAN_STALE",
  "CONFIRMATION_REQUIRED",
  "NO_PAGES",
  "OPERATION_BUSY",
  "HOST_BACKPRESSURED",
  "TOO_MANY_REQUESTS",
  "FRAME_TOKEN_INVALID",
  "FRAME_TOKEN_STALE",
  "GEOMETRY_TOKEN_INVALID",
  "GEOMETRY_TOKEN_STALE",
  "CAPABILITY_UNAVAILABLE",
] as const

type ReasonCode = (typeof REASON_CODES_V1)[number]

/** Builds the details-free variant shared by every code with no code-specific payload. */
function detailsFreeReason<C extends ReasonCode>(code: C) {
  return z.strictObject({ code: z.literal(code) })
}

// --- Codes carrying the "active turnId" detail (turn-lifecycle rows) ---
const turnAlreadyActiveReasonSchema = z.strictObject({
  code: z.literal("TURN_ALREADY_ACTIVE"),
  turnId: uuidv7Schema,
})
const turnRunningReasonSchema = z.strictObject({
  code: z.literal("TURN_RUNNING"),
  turnId: uuidv7Schema,
})
const turnIdMismatchReasonSchema = z.strictObject({
  code: z.literal("TURN_ID_MISMATCH"),
  turnId: uuidv7Schema,
})
const cancelTooLateReasonSchema = z.strictObject({
  code: z.literal("CANCEL_TOO_LATE"),
  turnId: uuidv7Schema,
})

// --- The "scope" detail (commit scope, §10.1's `commit.plan` target vocabulary) ---
const gitScopeCleanReasonSchema = z.strictObject({
  code: z.literal("GIT_SCOPE_CLEAN"),
  scope: z.enum(["current-page", "infrastructure", "whole-project"]),
})

// --- The "page slug" detail ---
const sourceStagedReasonSchema = z.strictObject({
  code: z.literal("SOURCE_STAGED"),
  pageSlug: pageSlugSchema,
})

// --- The "plan id" detail, qualified by which plan family it names ---
const planNotFoundReasonSchema = z.strictObject({
  code: z.literal("PLAN_NOT_FOUND"),
  planKind: z.enum(PLAN_KINDS),
  planId: uuidv7Schema,
})
const planStaleReasonSchema = z.strictObject({
  code: z.literal("PLAN_STALE"),
  planKind: z.enum(PLAN_KINDS),
  planId: uuidv7Schema,
})

// --- The "required revision" detail ---
const staleRevisionReasonSchema = z.strictObject({
  code: z.literal("STALE_REVISION"),
  requiredRevision: uint64StringSchema,
})

// --- Every remaining code: no code-specific detail beyond the code itself ---
const unsupportedProtocolReasonSchema = detailsFreeReason("UNSUPPORTED_PROTOCOL")
const invalidEnvelopeReasonSchema = detailsFreeReason("INVALID_ENVELOPE")
const commandIdReuseMismatchReasonSchema = detailsFreeReason("COMMAND_ID_REUSE_MISMATCH")
const commandIdExpiredReasonSchema = detailsFreeReason("COMMAND_ID_EXPIRED")
const commandDedupeCapacityReasonSchema = detailsFreeReason("COMMAND_DEDUPE_CAPACITY")
const projectNotReadyReasonSchema = detailsFreeReason("PROJECT_NOT_READY")
const projectUntrustedReasonSchema = detailsFreeReason("PROJECT_UNTRUSTED")
const turnNotActiveReasonSchema = detailsFreeReason("TURN_NOT_ACTIVE")
const historicalPreviewReadOnlyReasonSchema = detailsFreeReason("HISTORICAL_PREVIEW_READ_ONLY")
const gitUnavailableReasonSchema = detailsFreeReason("GIT_UNAVAILABLE")
const notGitRepositoryReasonSchema = detailsFreeReason("NOT_GIT_REPOSITORY")
const gitSequencerActiveReasonSchema = detailsFreeReason("GIT_SEQUENCER_ACTIVE")
const confirmationRequiredReasonSchema = detailsFreeReason("CONFIRMATION_REQUIRED")
const noPagesReasonSchema = detailsFreeReason("NO_PAGES")
const operationBusyReasonSchema = detailsFreeReason("OPERATION_BUSY")
const hostBackpressuredReasonSchema = detailsFreeReason("HOST_BACKPRESSURED")
const tooManyRequestsReasonSchema = detailsFreeReason("TOO_MANY_REQUESTS")
const frameTokenInvalidReasonSchema = detailsFreeReason("FRAME_TOKEN_INVALID")
const frameTokenStaleReasonSchema = detailsFreeReason("FRAME_TOKEN_STALE")
const geometryTokenInvalidReasonSchema = detailsFreeReason("GEOMETRY_TOKEN_INVALID")
const geometryTokenStaleReasonSchema = detailsFreeReason("GEOMETRY_TOKEN_STALE")
const capabilityUnavailableReasonSchema = detailsFreeReason("CAPABILITY_UNAVAILABLE")

/**
 * Binds every code in {@link REASON_CODES_V1} to its variant schema, typed as
 * `Record<ReasonCode, ...>` via `satisfies`. Dropping — or misspelling — a variant here
 * (as the review's mutation did to `noPagesReasonSchema`) is now a tsc error ("Property
 * 'NO_PAGES' is missing"), not a thinner union a runtime-only test would have to notice
 * on its own. Runtime completeness is still checked (see `unavailable-reason.test.ts`),
 * but this map is the primary guarantee.
 */
const REASON_SCHEMA_BY_CODE = {
  UNSUPPORTED_PROTOCOL: unsupportedProtocolReasonSchema,
  INVALID_ENVELOPE: invalidEnvelopeReasonSchema,
  COMMAND_ID_REUSE_MISMATCH: commandIdReuseMismatchReasonSchema,
  COMMAND_ID_EXPIRED: commandIdExpiredReasonSchema,
  COMMAND_DEDUPE_CAPACITY: commandDedupeCapacityReasonSchema,
  STALE_REVISION: staleRevisionReasonSchema,
  PROJECT_NOT_READY: projectNotReadyReasonSchema,
  PROJECT_UNTRUSTED: projectUntrustedReasonSchema,
  TURN_ALREADY_ACTIVE: turnAlreadyActiveReasonSchema,
  TURN_RUNNING: turnRunningReasonSchema,
  TURN_NOT_ACTIVE: turnNotActiveReasonSchema,
  TURN_ID_MISMATCH: turnIdMismatchReasonSchema,
  CANCEL_TOO_LATE: cancelTooLateReasonSchema,
  HISTORICAL_PREVIEW_READ_ONLY: historicalPreviewReadOnlyReasonSchema,
  GIT_UNAVAILABLE: gitUnavailableReasonSchema,
  NOT_GIT_REPOSITORY: notGitRepositoryReasonSchema,
  GIT_SCOPE_CLEAN: gitScopeCleanReasonSchema,
  GIT_SEQUENCER_ACTIVE: gitSequencerActiveReasonSchema,
  SOURCE_STAGED: sourceStagedReasonSchema,
  PLAN_NOT_FOUND: planNotFoundReasonSchema,
  PLAN_STALE: planStaleReasonSchema,
  CONFIRMATION_REQUIRED: confirmationRequiredReasonSchema,
  NO_PAGES: noPagesReasonSchema,
  OPERATION_BUSY: operationBusyReasonSchema,
  HOST_BACKPRESSURED: hostBackpressuredReasonSchema,
  TOO_MANY_REQUESTS: tooManyRequestsReasonSchema,
  FRAME_TOKEN_INVALID: frameTokenInvalidReasonSchema,
  FRAME_TOKEN_STALE: frameTokenStaleReasonSchema,
  GEOMETRY_TOKEN_INVALID: geometryTokenInvalidReasonSchema,
  GEOMETRY_TOKEN_STALE: geometryTokenStaleReasonSchema,
  CAPABILITY_UNAVAILABLE: capabilityUnavailableReasonSchema,
} satisfies Record<ReasonCode, z.ZodType>

/**
 * `UnavailableReason` (§11.1/§10.1), in §11.1 table order. Built by mapping
 * {@link REASON_CODES_V1} through {@link REASON_SCHEMA_BY_CODE} rather than listing the
 * 31 variants a second time as an array literal, so table order and the compile-checked
 * map can never disagree with each other.
 */
export const unavailableReasonV1Schema = z.discriminatedUnion(
  "code",
  REASON_CODES_V1.map((code) => REASON_SCHEMA_BY_CODE[code]) as [
    (typeof REASON_SCHEMA_BY_CODE)[ReasonCode],
    ...(typeof REASON_SCHEMA_BY_CODE)[ReasonCode][],
  ],
)

export type UnavailableReason = z.infer<typeof unavailableReasonV1Schema>

/**
 * The stable priority table §10.1 requires: "The first unavailable reason is selected
 * by a stable priority table for the primary hint; all reasons remain available for
 * diagnostics and accessibility." The spec does not fix the order, so this is this
 * module's own tiering, most-fundamentally-blocking first — a reason that means "your
 * request can't even be evaluated" (protocol/dedupe/revision) outranks one that means
 * "the specific thing you asked for isn't currently possible" (a token or backpressure
 * limit), so the UI's single-line hint always leads with the most actionable blocker.
 */
export const UNAVAILABLE_REASON_PRIORITY_V1 = [
  // Tier 1 — the command itself could not be evaluated.
  "UNSUPPORTED_PROTOCOL",
  "INVALID_ENVELOPE",
  "COMMAND_ID_REUSE_MISMATCH",
  "COMMAND_ID_EXPIRED",
  "COMMAND_DEDUPE_CAPACITY",
  "STALE_REVISION",
  // Tier 2 — the project itself is not in a usable state.
  "PROJECT_NOT_READY",
  "PROJECT_UNTRUSTED",
  // Tier 3 — turn lifecycle.
  "TURN_ALREADY_ACTIVE",
  "TURN_RUNNING",
  "TURN_NOT_ACTIVE",
  "TURN_ID_MISMATCH",
  "CANCEL_TOO_LATE",
  // Tier 4 — preview/source read-only or staged.
  "HISTORICAL_PREVIEW_READ_ONLY",
  "SOURCE_STAGED",
  // Tier 5 — Git environment.
  "GIT_UNAVAILABLE",
  "NOT_GIT_REPOSITORY",
  "GIT_SCOPE_CLEAN",
  "GIT_SEQUENCER_ACTIVE",
  // Tier 6 — plan lifecycle.
  "PLAN_NOT_FOUND",
  "PLAN_STALE",
  // Tier 7 — confirmation/content preconditions.
  "CONFIRMATION_REQUIRED",
  "NO_PAGES",
  // Tier 8 — concurrency/backpressure.
  "OPERATION_BUSY",
  "HOST_BACKPRESSURED",
  "TOO_MANY_REQUESTS",
  // Tier 9 — token validity.
  "FRAME_TOKEN_INVALID",
  "FRAME_TOKEN_STALE",
  "GEOMETRY_TOKEN_INVALID",
  "GEOMETRY_TOKEN_STALE",
  // Tier 10 — typed fallback.
  "CAPABILITY_UNAVAILABLE",
] as const satisfies readonly ReasonCode[]

const PRIORITY_RANK: ReadonlyMap<ReasonCode, number> = new Map(
  UNAVAILABLE_REASON_PRIORITY_V1.map((code, index) => [code, index]),
)

/**
 * `PRIORITY_RANK` is built from `UNAVAILABLE_REASON_PRIORITY_V1`, which `satisfies
 * readonly ReasonCode[]` over all 31 codes — every `UnavailableReason.code` a caller can
 * legally construct already has a rank, so `.get` returning `undefined` is unreachable
 * today. It stays reachable in principle (a future code added to `REASON_CODES_V1`
 * without a matching priority-table row, or a value that reached here after bypassing the
 * type system). Per the errore rule against silently suppressing failures, an unranked
 * code does NOT vanish quietly to "worst priority" — it is logged first, then still
 * falls back to worst priority so the function stays total and keeps returning a usable
 * reason.
 */
function rankOf(code: ReasonCode): number {
  const rank = PRIORITY_RANK.get(code)
  if (rank !== undefined) return rank
  console.warn(`primaryReason: no priority rank for reason code "${code}" — defaulting to lowest priority`)
  return Number.POSITIVE_INFINITY
}

/**
 * Selects the primary hint from a non-empty reason list by {@link UNAVAILABLE_REASON_PRIORITY_V1}.
 * Pure and order-independent: the same reason set always yields the same primary reason
 * no matter what order the guard produced them in.
 */
export function primaryReason(
  reasons: readonly [UnavailableReason, ...UnavailableReason[]],
): UnavailableReason {
  return reasons.reduce((best, candidate) =>
    rankOf(candidate.code) < rankOf(best.code) ? candidate : best,
  )
}
