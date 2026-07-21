import { z } from "zod";

import { type UUIDv7, uuidv7Schema } from "./ids";
import { type UInt64String, uint64StringSchema } from "./uint64";
import {
  REASON_CODES_V1,
  type UnavailableReason,
  unavailableReasonV1Schema,
} from "./unavailable-reason";

/**
 * The closed v1 immediate-rejection code registry (kernel-command-contract §11.1).
 *
 * This is the SAME list `UnavailableReason` discriminates on — §11.1 defines one code
 * space and says "`UnavailableReason` is a discriminated union using these stable
 * codes". So it is re-exported from the single registry in `./unavailable-reason`
 * rather than transcribed a second time: two hand-maintained copies of one spec table
 * that must agree, with nothing forcing them to, is a silent-divergence bug waiting to
 * happen. There is no import cycle to avoid here — this file already depends on
 * `./unavailable-reason` for `RejectedCommandV1.reasons`, so the edge only runs one way.
 */
export const COMMAND_REJECTION_CODES_V1 = REASON_CODES_V1;

export type CommandRejectionCode = (typeof COMMAND_REJECTION_CODES_V1)[number];

/** The exact member count §11.1 fixes. A drifted union fails the closure test, not a review. */
export const COMMAND_REJECTION_CODE_COUNT = 31;

const COMMAND_REJECTION_CODE_SET: ReadonlySet<string> = new Set(COMMAND_REJECTION_CODES_V1);

/** True when `raw` names a v1 command-rejection code. */
export function isCommandRejectionCode(raw: string): raw is CommandRejectionCode {
  return COMMAND_REJECTION_CODE_SET.has(raw);
}

/** Zod schema over the closed union. */
export const commandRejectionCodeSchema = z.enum(COMMAND_REJECTION_CODES_V1);

/**
 * `CommandResultV1 = AcceptedCommandV1 | RejectedCommandV1` (kernel-command-contract §8.3),
 * transcribed verbatim. "Accepted means the immediate named transition occurred or an
 * explicitly idempotent no-op was recognized. For `started`, terminal success/failure
 * arrives as an event carrying the same `commandId` and `operationId`."
 *
 * `operationId` is the one field the spec itself marks `?` — it is absent for
 * `disposition: "completed" | "no-op"` and present once an async operation identity
 * exists for `disposition: "started"` — so it is `.optional()`, not `.nullable()`.
 */
export interface AcceptedCommandV1 {
  readonly protocolVersion: 1;
  readonly commandId: UUIDv7;
  readonly status: "accepted";
  readonly acceptedRevision: UInt64String;
  readonly resultingRevision: UInt64String;
  readonly disposition: "completed" | "started" | "no-op";
  readonly operationId?: UUIDv7;
}

export const acceptedCommandV1Schema = z.strictObject({
  protocolVersion: z.literal(1),
  commandId: uuidv7Schema,
  status: z.literal("accepted"),
  acceptedRevision: uint64StringSchema,
  resultingRevision: uint64StringSchema,
  disposition: z.enum(["completed", "started", "no-op"]),
  operationId: uuidv7Schema.optional(),
});

/**
 * The rejected half of `CommandResultV1` (§8.3). `reasons` is spec-typed as the
 * non-empty tuple `readonly [UnavailableReason, ...UnavailableReason[]]`, so a
 * `Rejected` result always names at least one cause — `z.array(...).min(1)` enforces
 * that non-emptiness, not just "an array of `UnavailableReason`".
 */
export interface RejectedCommandV1 {
  readonly protocolVersion: 1;
  readonly commandId: UUIDv7;
  readonly status: "rejected";
  readonly currentRevision: UInt64String;
  readonly code: CommandRejectionCode;
  readonly reasons: readonly [UnavailableReason, ...UnavailableReason[]];
}

export const rejectedCommandV1Schema = z.strictObject({
  protocolVersion: z.literal(1),
  commandId: uuidv7Schema,
  status: z.literal("rejected"),
  currentRevision: uint64StringSchema,
  code: commandRejectionCodeSchema,
  /**
   * §8.3 types this as `readonly [UnavailableReason, ...UnavailableReason[]]` — a
   * NON-EMPTY tuple, not merely a validated-at-runtime array. The distinction is
   * load-bearing at the type level: `primaryReason` reduces over this list without a
   * seed, so an empty array is a `TypeError` waiting to happen, and it is the tuple
   * type that makes that unrepresentable. `z.array(...).min(1)` enforces the rule at
   * runtime but still infers a plain array, which would leave a parsed result
   * unassignable to `RejectedCommandV1` and unusable with `primaryReason` without a
   * cast — and a cast would discard the very guarantee.
   */
  reasons: z.tuple([unavailableReasonV1Schema], unavailableReasonV1Schema).readonly(),
});

/**
 * Binds each schema to the interface §8.3 declares. If a schema and its interface ever
 * drift — a field renamed on one side, or `reasons` degraded back to a plain array —
 * this is a compile error rather than a runtime surprise at the first `parse`.
 */
const _acceptedMatchesSpec = acceptedCommandV1Schema satisfies z.ZodType<AcceptedCommandV1>;
const _rejectedMatchesSpec = rejectedCommandV1Schema satisfies z.ZodType<RejectedCommandV1>;
void _acceptedMatchesSpec;
void _rejectedMatchesSpec;

export type CommandResultV1 = AcceptedCommandV1 | RejectedCommandV1;

export const commandResultV1Schema = z.discriminatedUnion("status", [
  acceptedCommandV1Schema,
  rejectedCommandV1Schema,
]);
