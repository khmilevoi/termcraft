import type { ChatLoadResultV1 } from "core/ports";
import type { ChatRecordDtoV1, EventPayloadByKindV1, UUIDv7 } from "core/protocol";
import type { ChatRecord } from "entities/chat";

/**
 * The entities -> wire mapping WP-10 Task 5 threads through `chat.switch`/`chat.create`
 * (`core/kernel/model/handlers/chat.ts`) and Task 6 through `project.open`
 * (`core/kernel/model/handlers/project.ts`): `ChatReader.loadTail`'s own `ChatLoadResultV1`
 * (`core/ports/chat-store.ts:45-48`) becomes the `chat.records` event payload
 * (`ChatRecordsPayloadV1`, `core/protocol/model/event-payload.ts`).
 *
 * `chatRecordToDtoV1` mirrors `ChatRecordDtoV1`'s own doc comment (`core/protocol/model/
 * chat-record.ts`): every `undefined`-typed optional on `entities/chat`'s `ChatRecord`
 * becomes an explicit `null` (or `[]` for the two array-shaped optionals) here — §8.1
 * forbids `undefined` on a DTO. `entities/chat/model/decode.ts`'s own `superRefine`
 * already enforces the `turnId`/`actionId` mutual exclusivity (storage-identity §11.2)
 * before a record ever reaches this boundary, so it is not re-checked a second time here.
 *
 * Plain `if` early returns, not a `switch` — matches this codebase's own established
 * per-kind idiom for `ChatRecord` (`store/jsonl/model/chat-index.ts`'s `extractTurnId`/
 * `extractChangedPages`). `record` narrows to the closed union's last remaining member
 * (`system:restore`) after the four checks — a sixth kind added later without a matching
 * branch here would fail to compile on the final branch's own field access, not silently
 * fall through.
 */

/** `EventPayloadByKindV1["chat.records"]` by another name — the module's own single import path for it, matching `core/chats/types.ts`'s identical `ChatSummaryV1` precedent. */
type ChatRecordsPayloadV1 = EventPayloadByKindV1["chat.records"];

export function chatRecordToDtoV1(record: ChatRecord): ChatRecordDtoV1 {
  if (record.kind === "user") {
    return {
      kind: "user",
      recordId: record.recordId,
      turnId: record.turnId,
      text: record.text,
      selection: record.selection ?? null,
      pins: record.pins ?? [],
      ts: record.ts,
    };
  }

  if (record.kind === "agent") {
    return {
      kind: "agent",
      recordId: record.recordId,
      turnId: record.turnId,
      text: record.text,
      changedPages: record.changedPages,
      warnings: record.warnings,
      ts: record.ts,
    };
  }

  if (record.kind === "system:error") {
    return {
      kind: "system:error",
      recordId: record.recordId,
      turnId: record.turnId ?? null,
      actionId: record.actionId ?? null,
      outcome: record.outcome,
      reason: record.reason ?? null,
      text: record.text,
      ts: record.ts,
    };
  }

  if (record.kind === "system:cancelled") {
    return {
      kind: "system:cancelled",
      recordId: record.recordId,
      turnId: record.turnId ?? null,
      actionId: record.actionId ?? null,
      text: record.text,
      ts: record.ts,
    };
  }

  return {
    kind: "system:restore",
    recordId: record.recordId,
    restoreActionId: record.restoreActionId,
    pageSlug: record.pageSlug,
    sourceCommit: record.sourceCommit,
    ts: record.ts,
  };
}

/**
 * Builds `chat.records`'s payload from one `ChatReader.loadTail`/`loadBefore` result
 * (`ChatLoadResultV1`, `core/ports/chat-store.ts:45-48`) — `records` mapped through
 * {@link chatRecordToDtoV1}, `prevCursor` passed through verbatim (`ChatPageCursorV1` and
 * `ChatPageCursorDtoV1` are the same `{generation, beforeOffset}` shape, redrawn per
 * code-structure Decision C1).
 */
export function buildChatRecordsPayload(
  chatId: UUIDv7,
  loadResult: ChatLoadResultV1,
): ChatRecordsPayloadV1 {
  return {
    chatId,
    records: loadResult.records.map(chatRecordToDtoV1),
    prevCursor: loadResult.prevCursor,
  };
}
