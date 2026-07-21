import * as errore from "errore";
import { z } from "zod";

import { type CanonicalHashError, canonicalHash } from "./canonical-hash";
import { type CommandKindV1, commandKindV1Schema, isCommandKindV1 } from "./command-kind";
import { type CommandPayloadByKindV1, commandPayloadSchemas } from "./command-payload";
import { type Sha256Hex, type UUIDv7, uuidv7Schema } from "./ids";
import { type UInt64String, uint64StringSchema } from "./uint64";

/**
 * The command envelope (kernel-command-contract §8.1):
 *
 * ```ts
 * type CommandEnvelopeV1<K extends CommandKindV1 = CommandKindV1> = Readonly<{
 *   protocolVersion: 1
 *   commandId: UUIDv7
 *   expectedRevision: UInt64String
 *   kind: K
 *   payload: CommandPayloadByKindV1[K]
 * }>
 * ```
 */
export type CommandEnvelopeV1<K extends CommandKindV1 = CommandKindV1> = {
  readonly protocolVersion: 1;
  readonly commandId: UUIDv7;
  readonly expectedRevision: UInt64String;
  readonly kind: K;
  readonly payload: CommandPayloadByKindV1[K];
};

/**
 * A decode failure, carrying the §11.1 code the mailbox must return.
 *
 * The two codes are deliberately distinguished rather than collapsed into one: §11.1
 * defines `UNSUPPORTED_PROTOCOL` as "`protocolVersion` is not supported" and
 * `INVALID_ENVELOPE` as "DTO schema, UUIDv7, unsigned decimal, kind, or payload
 * validation failed". A caller can act on the first (negotiate a version) and cannot act
 * on the second, so flattening them would cost the UI its only signal for which is which.
 */
export class CommandDecodeError extends errore.createTaggedError({
  name: "CommandDecodeError",
  message: "command envelope rejected [$code]: $reason",
}) {}

/**
 * The envelope shape WITHOUT its payload. The payload cannot be validated in the same
 * pass because its schema is selected by `kind`, which this pass is what establishes.
 */
const envelopeFrameSchema = z.strictObject({
  protocolVersion: z.literal(1),
  commandId: uuidv7Schema,
  expectedRevision: uint64StringSchema,
  kind: commandKindV1Schema,
  payload: z.unknown(),
});

function invalid(reason: string): CommandDecodeError {
  return new CommandDecodeError({ code: "INVALID_ENVELOPE", reason });
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "invalid envelope";
  const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
  return `${path}: ${issue.message}`;
}

/**
 * Validates an untrusted value as a command envelope and its kind-specific payload.
 *
 * Protocol version is checked BEFORE the rest of the shape. §12.1 orders dispatch as
 * "validates the closed DTO and protocol" first, and a future v2 envelope will legitimately
 * carry fields this v1 schema rejects — reporting those as `INVALID_ENVELOPE` would tell
 * the caller its message was malformed when in fact only the version was unsupported.
 */
export function decodeCommandEnvelope(raw: unknown): CommandDecodeError | CommandEnvelopeV1 {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return invalid("envelope must be a JSON object");
  }

  // Version is read straight off the raw object, BEFORE the frame schema runs. Reading it
  // from `frame.data` instead cannot work: the frame schema pins `protocolVersion` to
  // `z.literal(1)`, so a v2 envelope fails that parse and returns INVALID_ENVELOPE, leaving
  // the version branch below permanently dead. That is the exact confusion §11.1 separates
  // the two codes to avoid — a v2 caller would be told its envelope was malformed.
  const version = (raw as Record<string, unknown>).protocolVersion;
  if (version !== 1) {
    return new CommandDecodeError({
      code: "UNSUPPORTED_PROTOCOL",
      reason: `protocolVersion ${String(version)} is not supported`,
    });
  }

  const frame = envelopeFrameSchema.safeParse(raw);
  if (!frame.success) return invalid(firstIssue(frame.error));

  const kind = frame.data.kind;
  if (!isCommandKindV1(kind)) return invalid(`unknown command kind "${String(kind)}"`);

  const payloadSchema = commandPayloadSchemas[kind];
  if (payloadSchema === undefined) {
    // Unreachable while the payload map stays exhaustive over the kind union — the map's
    // own `satisfies` check enforces that at compile time. Kept as a value-level guard so
    // a kind that somehow reached here fails loudly instead of dispatching with an
    // unvalidated payload.
    return invalid(`no payload schema for kind "${kind}"`);
  }

  const payload = payloadSchema.safeParse(frame.data.payload);
  if (!payload.success) return invalid(`payload for ${kind} — ${firstIssue(payload.error)}`);

  return {
    protocolVersion: 1,
    commandId: frame.data.commandId,
    expectedRevision: frame.data.expectedRevision,
    kind,
    payload: payload.data,
  } as CommandEnvelopeV1;
}

/**
 * The canonical hash of a complete envelope, used by the §8.5 dedupe ledger to decide
 * whether a repeated `commandId` carries the same intent (return the stored result) or a
 * different one (`COMMAND_ID_REUSE_MISMATCH`).
 *
 * Deliberately computed over the RAW envelope rather than the decoded one: §8.5 keys
 * dedupe on "a canonical hash of the complete envelope", and a decoded value has already
 * had unknown keys rejected and defaults applied, so hashing it could make two materially
 * different submissions look identical.
 */
export function envelopeFingerprint(raw: unknown): CanonicalHashError | Sha256Hex {
  return canonicalHash(raw);
}
