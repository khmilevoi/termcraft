import { wrap } from "@reatom/core";

import type { ChatHandleV1, ChatLoadResultV1 } from "core/ports";
import type { ChatRecordDtoV1, EventPayloadByKindV1, FailureDtoV1, UUIDv7 } from "core/protocol";
import type { ChatRecord } from "entities/chat";

import { deriveChatDisplayName } from "./display-name";

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

/**
 * The chat's display name (design §3.9, {@link deriveChatDisplayName}) must come from the
 * chat's TRUE first `user` record — never from the (possibly later, byte/limit-bounded) tail
 * page's own first user record, which is the WRONG record for any chat longer than one tail
 * page (review finding IMPORTANT, WP-10 fix wave: deriving from `loadTail()` alone silently
 * names the wrong record once a chat outgrows one page).
 *
 * `ChatReader`/`ChatHandleV1` (`core/ports/chat-store.ts`) exposes no direct "read from the
 * start" method, but `loadBefore`'s own cursor already expresses one honestly: `store/jsonl`'s
 * real projection (`store/jsonl/model/chat-index.ts`'s `toPrevCursor`) returns `prevCursor:
 * null` ONLY once a page's own selection genuinely `reachedBeginning` (byte offset zero) — so
 * walking `loadBefore` backward from the already-loaded tail until `prevCursor` is `null`
 * reaches a page that starts at the chat's true beginning, and THAT page's own first `user`
 * record is the chat's true first one. No port extension was needed here (unlike Gap 4's
 * `readAppendBase` addition) — the cursor surface the port already has is sufficient, just not
 * yet walked all the way back.
 *
 * A single-page chat (the already-loaded tail's own `prevCursor` is ALREADY `null`)
 * short-circuits with zero extra `loadBefore` calls — the common case (a fresh or short chat)
 * pays nothing extra for this correctness fix. A `loadBefore` failure while walking back is
 * reported exactly like a `ChatReader.open`/`loadTail` failure already is by this function's
 * two callers (`core/kernel/model/handlers/chat.ts`'s `loadActiveChatTail`, `.../project.ts`'s
 * `restoreActiveChatTail`) — the same tail-read operation, just one port call deeper.
 *
 * Every `loadBefore` call is `await wrap(...)`-ed (Reatom rule RTM-A04) — crossing this
 * function's own `await` is a fresh async boundary regardless of what its caller does
 * (`handlers/page-pin.ts`'s own header states the identical rule for a composed call).
 */
export async function resolveChatDisplayName(
  handle: ChatHandleV1,
  tail: ChatLoadResultV1,
): Promise<FailureDtoV1 | string | null> {
  let earliestPage = tail;
  while (earliestPage.prevCursor !== null) {
    const page = await wrap(handle.loadBefore(earliestPage.prevCursor));
    if ("code" in page) return page;
    earliestPage = page;
  }
  return deriveChatDisplayName(earliestPage.records.map(chatRecordToDtoV1));
}
