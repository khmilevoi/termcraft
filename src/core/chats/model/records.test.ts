import { describe, expect, test } from "bun:test";

import type { ChatHandleV1, ChatHeaderV1, ChatLoadResultV1, ChatPageCursorV1 } from "core/ports";
import { chatRecordDtoV1Schema } from "core/protocol";
import type { FailureDtoV1 } from "core/protocol";
import type {
  ChatAgentRecord,
  ChatSystemCancelledRecord,
  ChatSystemErrorRecord,
  ChatSystemRestoreRecord,
  ChatUserRecord,
} from "entities/chat";
import { parsePageSlug } from "entities/page";
import { uuidv7 } from "infrastructure/uuid";

import {
  buildChatRecordsOlderPayload,
  buildChatRecordsPayload,
  chatRecordToDtoV1,
  chatRecordsOlderFailurePayload,
  resolveChatDisplayName,
} from "./records";

/**
 * `chatRecordToDtoV1`/`buildChatRecordsPayload` (WP-10 Task 5) — the entities -> wire
 * mapping `chat.switch`/`chat.create`/`project.open` all share to build a `chat.records`
 * payload from `ChatReader.loadTail`'s own `ChatLoadResultV1`. `buildChatRecordsOlderPayload`/
 * `chatRecordsOlderFailurePayload` (chat-scroll spec §6.2) build the sibling
 * `chat.records.older` payload from the same `ChatLoadResultV1` shape.
 */

const TS = "2026-07-24T00:00:00.000Z";

function slug(value: string) {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

describe("chatRecordToDtoV1", () => {
  test("maps a user record, substituting null/[] for absent optionals", () => {
    const recordId = uuidv7();
    const turnId = uuidv7();
    const record: ChatUserRecord = {
      kind: "user",
      recordId,
      turnId,
      text: "hello",
      ts: TS,
    };

    const dto = chatRecordToDtoV1(record);

    expect(dto).toEqual({
      kind: "user",
      recordId,
      turnId,
      text: "hello",
      selection: null,
      pins: [],
      ts: TS,
    });
    expect(chatRecordDtoV1Schema.safeParse(dto).success).toBe(true);
  });

  test("maps a user record's explicit selection and pins verbatim", () => {
    const recordId = uuidv7();
    const turnId = uuidv7();
    const pinId = uuidv7();
    const record: ChatUserRecord = {
      kind: "user",
      recordId,
      turnId,
      text: "with selection",
      selection: { pageSlug: slug("home"), element: "#hero" },
      pins: [pinId],
      ts: TS,
    };

    const dto = chatRecordToDtoV1(record);

    expect(dto).toEqual({
      kind: "user",
      recordId,
      turnId,
      text: "with selection",
      selection: { pageSlug: "home", element: "#hero" },
      pins: [pinId],
      ts: TS,
    });
    expect(chatRecordDtoV1Schema.safeParse(dto).success).toBe(true);
  });

  test("maps an agent record's changedPages/warnings verbatim, filling absent file/line with null", () => {
    const recordId = uuidv7();
    const turnId = uuidv7();
    const record: ChatAgentRecord = {
      kind: "agent",
      recordId,
      turnId,
      text: "**bold** result",
      changedPages: [slug("home")],
      warnings: [{ kind: "gate:orphan-import", message: "unused import" }],
      ts: TS,
    };

    const dto = chatRecordToDtoV1(record);

    expect(dto).toEqual({
      kind: "agent",
      recordId,
      turnId,
      text: "**bold** result",
      changedPages: ["home"],
      // No `file`/`line` on the domain record — the DTO's own "never omission" rule (Task 11)
      // fills both with `null`, not `undefined`.
      warnings: [{ kind: "gate:orphan-import", message: "unused import", file: null, line: null }],
      ts: TS,
    });
    expect(chatRecordDtoV1Schema.safeParse(dto).success).toBe(true);
  });

  test("maps an agent record's warning file/line through to the DTO verbatim (Task 11)", () => {
    const recordId = uuidv7();
    const turnId = uuidv7();
    const record: ChatAgentRecord = {
      kind: "agent",
      recordId,
      turnId,
      text: "done",
      changedPages: [slug("home")],
      warnings: [
        {
          kind: "nondeterministic-time",
          message: "`Date.now()` reads wall-clock time",
          file: "pages/stopwatch.tsx",
          line: 55,
        },
      ],
      ts: TS,
    };

    const dto = chatRecordToDtoV1(record);

    expect(dto).toEqual({
      kind: "agent",
      recordId,
      turnId,
      text: "done",
      changedPages: ["home"],
      warnings: [
        {
          kind: "nondeterministic-time",
          message: "`Date.now()` reads wall-clock time",
          file: "pages/stopwatch.tsx",
          line: 55,
        },
      ],
      ts: TS,
    });
    expect(chatRecordDtoV1Schema.safeParse(dto).success).toBe(true);
  });

  test("maps a system:error record's absent turnId/actionId/reason to null", () => {
    const recordId = uuidv7();
    const record: ChatSystemErrorRecord = {
      kind: "system:error",
      recordId,
      outcome: "interrupted",
      text: "process restarted before intent",
      ts: TS,
    };

    const dto = chatRecordToDtoV1(record);

    expect(dto).toEqual({
      kind: "system:error",
      recordId,
      turnId: null,
      actionId: null,
      outcome: "interrupted",
      reason: null,
      text: "process restarted before intent",
      ts: TS,
    });
    expect(chatRecordDtoV1Schema.safeParse(dto).success).toBe(true);
  });

  test("maps a system:error record's present turnId/reason (turnId/actionId are mutually exclusive upstream)", () => {
    const recordId = uuidv7();
    const turnId = uuidv7();
    const record: ChatSystemErrorRecord = {
      kind: "system:error",
      recordId,
      turnId,
      outcome: "stale",
      reason: "process_restart_before_intent",
      text: "turn failed",
      ts: TS,
    };

    const dto = chatRecordToDtoV1(record);

    expect(dto).toEqual({
      kind: "system:error",
      recordId,
      turnId,
      actionId: null,
      outcome: "stale",
      reason: "process_restart_before_intent",
      text: "turn failed",
      ts: TS,
    });
    expect(chatRecordDtoV1Schema.safeParse(dto).success).toBe(true);
  });

  test("maps a system:cancelled record's absent turnId/actionId to null", () => {
    const recordId = uuidv7();
    const actionId = uuidv7();
    const record: ChatSystemCancelledRecord = {
      kind: "system:cancelled",
      recordId,
      actionId,
      text: "cancelled by user",
      ts: TS,
    };

    const dto = chatRecordToDtoV1(record);

    expect(dto).toEqual({
      kind: "system:cancelled",
      recordId,
      turnId: null,
      actionId,
      text: "cancelled by user",
      ts: TS,
    });
    expect(chatRecordDtoV1Schema.safeParse(dto).success).toBe(true);
  });

  test("maps a system:restore record's fields verbatim (defined for reader completeness, no MVP writer)", () => {
    const recordId = uuidv7();
    const restoreActionId = uuidv7();
    const record: ChatSystemRestoreRecord = {
      kind: "system:restore",
      recordId,
      restoreActionId,
      pageSlug: slug("home"),
      sourceCommit: "a".repeat(40),
      ts: TS,
    };

    const dto = chatRecordToDtoV1(record);

    expect(dto).toEqual({
      kind: "system:restore",
      recordId,
      restoreActionId,
      pageSlug: "home",
      sourceCommit: "a".repeat(40),
      ts: TS,
    });
    expect(chatRecordDtoV1Schema.safeParse(dto).success).toBe(true);
  });
});

describe("buildChatRecordsPayload", () => {
  test("maps records in order and passes a null prevCursor through", () => {
    const chatId = uuidv7();
    const userTurnId = uuidv7();
    const userRecordId = uuidv7();
    const agentRecordId = uuidv7();
    const loadResult: ChatLoadResultV1 = {
      records: [
        { kind: "user", recordId: userRecordId, turnId: userTurnId, text: "hi", ts: TS },
        {
          kind: "agent",
          recordId: agentRecordId,
          turnId: userTurnId,
          text: "hello back",
          changedPages: [],
          warnings: [],
          ts: TS,
        },
      ],
      prevCursor: null,
      totalRecordCount: 2,
    };

    const payload = buildChatRecordsPayload(chatId, loadResult);

    expect(payload.chatId).toBe(chatId);
    expect(payload.prevCursor).toBeNull();
    expect(payload.totalRecordCount).toBe(2);
    expect(payload.records).toEqual([
      {
        kind: "user",
        recordId: userRecordId,
        turnId: userTurnId,
        text: "hi",
        selection: null,
        pins: [],
        ts: TS,
      },
      {
        kind: "agent",
        recordId: agentRecordId,
        turnId: userTurnId,
        text: "hello back",
        changedPages: [],
        warnings: [],
        ts: TS,
      },
    ]);
  });

  test("passes a non-null prevCursor through verbatim", () => {
    const chatId = uuidv7();
    const loadResult: ChatLoadResultV1 = {
      records: [],
      prevCursor: { generation: 0, beforeOffset: 128 },
      totalRecordCount: 40,
    };

    const payload = buildChatRecordsPayload(chatId, loadResult);

    expect(payload.records).toEqual([]);
    expect(payload.prevCursor).toEqual({ generation: 0, beforeOffset: 128 });
  });

  test("passes totalRecordCount through, independent of the loaded page's own record count (chat-scroll spec §6.3)", () => {
    const chatId = uuidv7();
    const loadResult: ChatLoadResultV1 = {
      records: [],
      prevCursor: { generation: 0, beforeOffset: 128 },
      totalRecordCount: 40,
    };

    const payload = buildChatRecordsPayload(chatId, loadResult);

    expect(payload.totalRecordCount).toBe(40);
  });
});

describe("buildChatRecordsOlderPayload (chat.records.older, chat-scroll spec §6.2)", () => {
  test("maps a successful older page the same way buildChatRecordsPayload does, with a null failure", () => {
    const chatId = uuidv7();
    const userRecordId = uuidv7();
    const userTurnId = uuidv7();
    const loadResult: ChatLoadResultV1 = {
      records: [
        { kind: "user", recordId: userRecordId, turnId: userTurnId, text: "older message", ts: TS },
      ],
      prevCursor: { generation: 2, beforeOffset: 256 },
      totalRecordCount: 40,
    };

    const payload = buildChatRecordsOlderPayload(chatId, loadResult);

    expect(payload).toEqual({
      chatId,
      records: [
        {
          kind: "user",
          recordId: userRecordId,
          turnId: userTurnId,
          text: "older message",
          selection: null,
          pins: [],
          ts: TS,
        },
      ],
      prevCursor: { generation: 2, beforeOffset: 256 },
      totalRecordCount: 40,
      failure: null,
    });
  });

  test("passes a null prevCursor through — the page reached the chat's true beginning", () => {
    const chatId = uuidv7();
    const loadResult: ChatLoadResultV1 = { records: [], prevCursor: null, totalRecordCount: 1 };

    const payload = buildChatRecordsOlderPayload(chatId, loadResult);

    expect(payload.prevCursor).toBeNull();
    expect(payload.failure).toBeNull();
  });
});

describe("chatRecordsOlderFailurePayload (chat-scroll spec §7 — failure leaves cursor/window empty)", () => {
  test("carries the failure and empties every other field, never adopting placeholder cursor/count values", () => {
    const chatId = uuidv7();
    const failure: FailureDtoV1 = {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: "chat page could not be read",
      details: {},
    };

    const payload = chatRecordsOlderFailurePayload(chatId, failure);

    expect(payload).toEqual({
      chatId,
      records: [],
      prevCursor: null,
      totalRecordCount: 0,
      failure,
    });
  });
});

describe("resolveChatDisplayName (review finding IMPORTANT — the true first page, not the tail)", () => {
  const HEADER: ChatHeaderV1 = { chatId: "fake-chat-1", createdAt: TS };

  /** A `ChatHandleV1` double whose `loadBefore` answers from a fixed `{cursor -> page}` map, keyed by `beforeOffset`, and records every call it received. */
  function makeHandle(
    pagesByBeforeOffset: ReadonlyMap<number, FailureDtoV1 | ChatLoadResultV1>,
  ): ChatHandleV1 & { readonly loadBeforeCalls: readonly ChatPageCursorV1[] } {
    const loadBeforeCalls: ChatPageCursorV1[] = [];
    return {
      header: HEADER,
      loadBeforeCalls,
      async loadTail() {
        throw new Error("not used by resolveChatDisplayName — the tail is passed in directly");
      },
      async loadBefore(cursor: ChatPageCursorV1) {
        loadBeforeCalls.push(cursor);
        const page = pagesByBeforeOffset.get(cursor.beforeOffset);
        if (page === undefined)
          throw new Error(`no fixture page for beforeOffset ${cursor.beforeOffset}`);
        return page;
      },
    };
  }

  test("short-circuits with zero loadBefore calls when the tail's own prevCursor is already null", async () => {
    const handle = makeHandle(new Map());
    const tail: ChatLoadResultV1 = {
      records: [
        { kind: "user", recordId: uuidv7(), turnId: uuidv7(), text: "single-page chat", ts: TS },
      ],
      prevCursor: null,
      totalRecordCount: 1,
    };

    const result = await resolveChatDisplayName(handle, tail);

    expect(result).toBe("single-page chat");
    expect(handle.loadBeforeCalls).toEqual([]);
  });

  test("walks back through loadBefore to the chat's TRUE first page when the tail page does not contain the first user record", async () => {
    const trueFirstUserTurnId = uuidv7();
    const firstPage: ChatLoadResultV1 = {
      records: [
        {
          kind: "user",
          recordId: uuidv7(),
          turnId: trueFirstUserTurnId,
          text: "the actual first message",
          ts: TS,
        },
      ],
      prevCursor: null,
      totalRecordCount: 2,
    };
    // The tail page is bounded and only carries a LATER user record — the exact
    // "tail longer than one page" scenario the review finding names.
    const tail: ChatLoadResultV1 = {
      records: [
        {
          kind: "user",
          recordId: uuidv7(),
          turnId: uuidv7(),
          text: "a much later message",
          ts: TS,
        },
      ],
      prevCursor: { generation: 1, beforeOffset: 512 },
      totalRecordCount: 2,
    };
    const handle = makeHandle(new Map([[512, firstPage]]));

    const result = await resolveChatDisplayName(handle, tail);

    expect(result).toBe("the actual first message");
    expect(handle.loadBeforeCalls).toEqual([{ generation: 1, beforeOffset: 512 }]);
  });

  test("walks back through MULTIPLE pages until prevCursor is null", async () => {
    const tail: ChatLoadResultV1 = {
      records: [],
      prevCursor: { generation: 1, beforeOffset: 900 },
      totalRecordCount: 3,
    };
    const middlePage: ChatLoadResultV1 = {
      records: [],
      prevCursor: { generation: 1, beforeOffset: 400 },
      totalRecordCount: 3,
    };
    const firstPage: ChatLoadResultV1 = {
      records: [
        { kind: "user", recordId: uuidv7(), turnId: uuidv7(), text: "genesis message", ts: TS },
      ],
      prevCursor: null,
      totalRecordCount: 3,
    };
    const handle = makeHandle(
      new Map<number, FailureDtoV1 | ChatLoadResultV1>([
        [900, middlePage],
        [400, firstPage],
      ]),
    );

    const result = await resolveChatDisplayName(handle, tail);

    expect(result).toBe("genesis message");
    expect(handle.loadBeforeCalls).toEqual([
      { generation: 1, beforeOffset: 900 },
      { generation: 1, beforeOffset: 400 },
    ]);
  });

  test("returns null when the true first page has no user record", async () => {
    const tail: ChatLoadResultV1 = {
      records: [],
      prevCursor: { generation: 1, beforeOffset: 64 },
      totalRecordCount: 1,
    };
    const firstPage: ChatLoadResultV1 = {
      records: [
        {
          kind: "system:cancelled",
          recordId: uuidv7(),
          actionId: uuidv7(),
          text: "cancelled before any user record",
          ts: TS,
        },
      ],
      prevCursor: null,
      totalRecordCount: 1,
    };
    const handle = makeHandle(new Map([[64, firstPage]]));

    const result = await resolveChatDisplayName(handle, tail);

    expect(result).toBeNull();
  });

  test("propagates a loadBefore failure encountered while walking back", async () => {
    const failure: FailureDtoV1 = {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: "page directory corrupt",
      details: {},
    };
    const tail: ChatLoadResultV1 = {
      records: [],
      prevCursor: { generation: 1, beforeOffset: 32 },
      totalRecordCount: 1,
    };
    const handle = makeHandle(new Map([[32, failure]]));

    const result = await resolveChatDisplayName(handle, tail);

    expect(result).toEqual(failure);
  });
});
