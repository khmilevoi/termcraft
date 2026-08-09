import { z } from "zod";

import { pageSlugSchema } from "entities/page";
import { rfc3339UtcSchema } from "infrastructure/clock";

import { type UUIDv7, uuidv7Schema } from "./ids";

/**
 * The wire mirror of `entities/chat`'s `ChatRecord` union (`entities/chat/types.ts:92-97`).
 * `entities/chat` is domain vocabulary decoded from disk with `undefined`-typed optionals
 * (`turnId?`, `actionId?`, `selection?`, `pins?`) and a forward-compatible decoder — the
 * opposite of this package's own rules (§8.1: no `undefined` on a DTO; §9: unknown keys are
 * invalid). So `core/protocol` declares its own closed strict mirror rather than reusing
 * `ChatRecord` directly, the same "narrow, core-owned redraw" precedent `ChatPageCursorV1`
 * already follows for `store/jsonl`'s `PageCursor` (`core/ports/chat-store.ts:39-43`,
 * code-structure Decision C1).
 *
 * Every `undefined`-typed optional on the entities side becomes an explicit `| null` here:
 * - `ChatUserRecord.selection?`/`.pins?` -> `selection: {...} | null`, `pins: readonly UUIDv7[]`
 *   (an empty array stands in for "no pins", matching the array's own natural absence value).
 * - `ChatSystemErrorRecord`/`ChatSystemCancelledRecord`'s `turnId?`/`actionId?` -> both
 *   `UUIDv7 | null`. Storage-identity §11.2 makes the two mutually exclusive (exactly one of
 *   a turn failure or a standalone action failure) — `entities/chat/model/decode.ts`'s own
 *   `chatRecordSchema` already enforces that invariant with a `superRefine` before a record
 *   ever reaches this boundary, so it is not re-checked a second time here; this DTO only
 *   states the two fields are independently nullable, matching every other DTO in this file
 *   that carries two related nullable identities (e.g. `RestoreTerminalPayloadV1.restoreActionId`).
 * - `ChatSystemErrorRecord.reason?` -> `reason: string | null`.
 *
 * `ChatUserRecord.text`/`ChatAgentRecord.text`/`ChatSystemErrorRecord.text`/
 * `ChatSystemCancelledRecord.text` are free display content, not identity strings, so they
 * are plain `z.string()` with no `.min(1)` — the same choice this file's sibling
 * `event-payload.ts` makes for other free-text fields (e.g. `TurnWarningV1.safeMessage`,
 * `turnProgressContentV1Schema`'s `final`/`reasoning` text). Deriving a chat's display name
 * from a record's `text` (design §3.9) is a SEPARATE concern (`core/chats/model/
 * display-name.ts`) — this schema does not special-case a record's first line in any way.
 */

// ---------------------------------------------------------------------------
// user
// ---------------------------------------------------------------------------

export interface ChatUserRecordDtoV1 {
  readonly kind: "user";
  readonly recordId: UUIDv7;
  readonly turnId: UUIDv7;
  readonly text: string;
  readonly selection: Readonly<{ pageSlug: string; element: string }> | null;
  readonly pins: readonly UUIDv7[];
  readonly ts: string;
}

export const chatUserRecordDtoV1Schema = z.strictObject({
  kind: z.literal("user"),
  recordId: uuidv7Schema,
  turnId: uuidv7Schema,
  text: z.string(),
  selection: z.strictObject({ pageSlug: pageSlugSchema, element: z.string().min(1) }).nullable(),
  pins: z.array(uuidv7Schema).readonly(),
  ts: rfc3339UtcSchema,
});

// ---------------------------------------------------------------------------
// agent
// ---------------------------------------------------------------------------

/**
 * Mirrors `entities/chat`'s `ChatWarningSnapshot` (`types.ts`): an immutable historical
 * Gate-warning snapshot, decoupled from `gate/`'s own live warning type.
 *
 * `file`/`line` ADDED (Task 11, design-agent-feedback-loop repair, 2026-08-09), mirroring
 * `ChatWarningSnapshot.file`/`.line` — TREE-relative, matching `GateWarningV1.file`. `| null`,
 * never `?`, matching this file's own "every `undefined`-typed optional on the entities side
 * becomes an explicit `null` here" rule stated above: `core/chats/model/records.ts`'s
 * `chatRecordToDtoV1` maps `w.file ?? null`/`w.line ?? null` for every warning, never omits the
 * key.
 */
export interface ChatWarningSnapshotDtoV1 {
  readonly kind: string;
  readonly message: string;
  readonly file: string | null;
  readonly line: number | null;
}

const chatWarningSnapshotDtoV1Schema = z.strictObject({
  kind: z.string().min(1),
  message: z.string(),
  file: z.string().min(1).nullable(),
  line: z.number().int().positive().nullable(),
});

export interface ChatAgentRecordDtoV1 {
  readonly kind: "agent";
  readonly recordId: UUIDv7;
  readonly turnId: UUIDv7;
  readonly text: string;
  readonly changedPages: readonly string[];
  readonly warnings: readonly ChatWarningSnapshotDtoV1[];
  readonly ts: string;
}

export const chatAgentRecordDtoV1Schema = z.strictObject({
  kind: z.literal("agent"),
  recordId: uuidv7Schema,
  turnId: uuidv7Schema,
  text: z.string(),
  changedPages: z.array(pageSlugSchema).readonly(),
  warnings: z.array(chatWarningSnapshotDtoV1Schema).readonly(),
  ts: rfc3339UtcSchema,
});

// ---------------------------------------------------------------------------
// system:error / system:cancelled / system:restore
// ---------------------------------------------------------------------------

/** `ChatSystemErrorRecord.outcome`, transcribed verbatim (`entities/chat/types.ts:60`). */
const CHAT_SYSTEM_ERROR_OUTCOMES_V1 = ["error", "stale", "interrupted"] as const;
export type ChatSystemErrorOutcomeV1 = (typeof CHAT_SYSTEM_ERROR_OUTCOMES_V1)[number];

export interface ChatSystemErrorRecordDtoV1 {
  readonly kind: "system:error";
  readonly recordId: UUIDv7;
  readonly turnId: UUIDv7 | null;
  readonly actionId: UUIDv7 | null;
  readonly outcome: ChatSystemErrorOutcomeV1;
  readonly reason: string | null;
  readonly text: string;
  readonly ts: string;
}

export const chatSystemErrorRecordDtoV1Schema = z.strictObject({
  kind: z.literal("system:error"),
  recordId: uuidv7Schema,
  turnId: uuidv7Schema.nullable(),
  actionId: uuidv7Schema.nullable(),
  outcome: z.enum(CHAT_SYSTEM_ERROR_OUTCOMES_V1),
  reason: z.string().min(1).nullable(),
  text: z.string(),
  ts: rfc3339UtcSchema,
});

export interface ChatSystemCancelledRecordDtoV1 {
  readonly kind: "system:cancelled";
  readonly recordId: UUIDv7;
  readonly turnId: UUIDv7 | null;
  readonly actionId: UUIDv7 | null;
  readonly text: string;
  readonly ts: string;
}

export const chatSystemCancelledRecordDtoV1Schema = z.strictObject({
  kind: z.literal("system:cancelled"),
  recordId: uuidv7Schema,
  turnId: uuidv7Schema.nullable(),
  actionId: uuidv7Schema.nullable(),
  text: z.string(),
  ts: rfc3339UtcSchema,
});

/**
 * DEFINED for reader completeness and forward-compat, matching `entities/chat`'s own
 * `ChatSystemRestoreRecord` header comment: Restore is out of MVP scope, so no writer
 * produces this record yet, but the wire mirror still closes the union.
 */
export interface ChatSystemRestoreRecordDtoV1 {
  readonly kind: "system:restore";
  readonly recordId: UUIDv7;
  readonly restoreActionId: UUIDv7;
  readonly pageSlug: string;
  readonly sourceCommit: string;
  readonly ts: string;
}

export const chatSystemRestoreRecordDtoV1Schema = z.strictObject({
  kind: z.literal("system:restore"),
  recordId: uuidv7Schema,
  restoreActionId: uuidv7Schema,
  pageSlug: pageSlugSchema,
  sourceCommit: z.string().min(1),
  ts: rfc3339UtcSchema,
});

// ---------------------------------------------------------------------------
// The closed ChatRecordDtoV1 union
// ---------------------------------------------------------------------------

/** The five-member closed union, mirroring `entities/chat`'s own `ChatRecord` (`types.ts:92-97`) member-for-member and in the same order. */
export type ChatRecordDtoV1 =
  | ChatUserRecordDtoV1
  | ChatAgentRecordDtoV1
  | ChatSystemErrorRecordDtoV1
  | ChatSystemCancelledRecordDtoV1
  | ChatSystemRestoreRecordDtoV1;

export const chatRecordDtoV1Schema = z.discriminatedUnion("kind", [
  chatUserRecordDtoV1Schema,
  chatAgentRecordDtoV1Schema,
  chatSystemErrorRecordDtoV1Schema,
  chatSystemCancelledRecordDtoV1Schema,
  chatSystemRestoreRecordDtoV1Schema,
]);
