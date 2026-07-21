import * as errore from "errore";
import { z } from "zod";

import { pageSlugSchema } from "entities/page";
import { rfc3339UtcSchema } from "infrastructure/clock";
import { canonicalUuidv7Schema } from "infrastructure/uuid";

import type { ChatHeader, ChatRecord } from "../types";

/**
 * A schema or identity violation in a chat header/record (storage-identity §11.1/§11.2).
 * Decoders return this as a value — a corrupt record is data, not an exception. Unknown
 * extra fields are IGNORED (forward-compatible: every schema below is a plain
 * `z.object`, which strips unrecognized keys rather than rejecting them), matching
 * "readers do not assign meaning to key order" (§11.1).
 */
export class ChatDecodeError extends errore.createTaggedError({
  name: "ChatDecodeError",
  message: "chat decode failed [$code]: $reason",
}) {}

function fail(code: string, reason: string): ChatDecodeError {
  return new ChatDecodeError({ code, reason });
}

/** Maps the first Zod issue to a `ChatDecodeError` (decoders fail on the first violation, like the hand-rolled checks they replace). */
function toDecodeError(error: z.ZodError): ChatDecodeError {
  const issue = error.issues[0];
  const code = issue !== undefined && issue.path.length > 0 ? issue.path.join(".") : "SHAPE";
  return fail(code, issue?.message ?? "invalid input");
}

const chatHeaderSchema = z.object({
  kind: z.literal("chat"),
  formatVersion: z.literal(1),
  projectId: canonicalUuidv7Schema,
  chatId: canonicalUuidv7Schema,
  createdAt: rfc3339UtcSchema,
});

const chatSelectionSchema = z.object({
  pageSlug: pageSlugSchema,
  element: z.string().min(1),
});

const chatWarningSnapshotSchema = z.object({
  kind: z.string().min(1),
  message: z.string().min(1),
});

const chatUserRecordSchema = z.object({
  kind: z.literal("user"),
  recordId: canonicalUuidv7Schema,
  turnId: canonicalUuidv7Schema,
  text: z.string().min(1),
  selection: chatSelectionSchema.optional(),
  pins: z.array(canonicalUuidv7Schema).optional(),
  ts: rfc3339UtcSchema,
});

const chatAgentRecordSchema = z.object({
  kind: z.literal("agent"),
  recordId: canonicalUuidv7Schema,
  turnId: canonicalUuidv7Schema,
  text: z.string().min(1),
  changedPages: z.array(pageSlugSchema),
  warnings: z.array(chatWarningSnapshotSchema),
  ts: rfc3339UtcSchema,
});

const chatSystemErrorRecordSchema = z.object({
  kind: z.literal("system:error"),
  recordId: canonicalUuidv7Schema,
  turnId: canonicalUuidv7Schema.optional(),
  actionId: canonicalUuidv7Schema.optional(),
  outcome: z.enum(["error", "stale", "interrupted"]),
  reason: z.string().min(1).optional(),
  text: z.string().min(1),
  ts: rfc3339UtcSchema,
});

const chatSystemCancelledRecordSchema = z.object({
  kind: z.literal("system:cancelled"),
  recordId: canonicalUuidv7Schema,
  turnId: canonicalUuidv7Schema.optional(),
  actionId: canonicalUuidv7Schema.optional(),
  text: z.string().min(1),
  ts: rfc3339UtcSchema,
});

const chatSystemRestoreRecordSchema = z.object({
  kind: z.literal("system:restore"),
  recordId: canonicalUuidv7Schema,
  restoreActionId: canonicalUuidv7Schema,
  pageSlug: pageSlugSchema,
  sourceCommit: z.string().min(1),
  ts: rfc3339UtcSchema,
});

/**
 * `turnId`/`actionId` are mutually exclusive on `system:error`/`system:cancelled`
 * (storage-identity §11.2: a system record relates to exactly one of a turn or a
 * standalone action). Checked on the parsed union, not on an individual member —
 * `discriminatedUnion` only accepts plain-object members.
 */
const chatRecordSchema = z
  .discriminatedUnion("kind", [
    chatUserRecordSchema,
    chatAgentRecordSchema,
    chatSystemErrorRecordSchema,
    chatSystemCancelledRecordSchema,
    chatSystemRestoreRecordSchema,
  ])
  .superRefine((val, ctx) => {
    if (val.kind !== "system:error" && val.kind !== "system:cancelled") return;
    const hasTurn = val.turnId !== undefined;
    const hasAction = val.actionId !== undefined;
    if (hasTurn === hasAction) {
      ctx.addIssue({ code: "custom", message: "exactly one of `turnId`/`actionId` is required" });
    }
  });

/**
 * Decode a chat JSONL header line (storage-identity §11.2): `kind = "chat"`,
 * `formatVersion = 1`, and canonical `projectId`/`chatId`/`createdAt` identities.
 */
export function decodeChatHeader(value: unknown): ChatHeader | ChatDecodeError {
  const result = chatHeaderSchema.safeParse(value);
  if (!result.success) return toDecodeError(result.error);
  return result.data;
}

/**
 * Decode one chat record line by its `kind` (storage-identity §11.2), validating the
 * schema and every identity/timestamp. An unknown `kind` or any invalid field is a
 * `ChatDecodeError`; extra fields are ignored (forward-compatible). The streaming
 * reader/1-MiB-bound and file-order rules live in `store/jsonl`, not here.
 */
export function decodeChatRecord(value: unknown): ChatRecord | ChatDecodeError {
  const result = chatRecordSchema.safeParse(value);
  if (!result.success) return toDecodeError(result.error);
  return result.data;
}
