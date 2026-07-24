import { describe, expect, test } from "bun:test";

import type { ChatLoadResultV1 } from "core/ports";
import { chatRecordDtoV1Schema } from "core/protocol";
import type {
  ChatAgentRecord,
  ChatSystemCancelledRecord,
  ChatSystemErrorRecord,
  ChatSystemRestoreRecord,
  ChatUserRecord,
} from "entities/chat";
import { parsePageSlug } from "entities/page";
import { uuidv7 } from "infrastructure/uuid";

import { buildChatRecordsPayload, chatRecordToDtoV1 } from "./records";

/**
 * `chatRecordToDtoV1`/`buildChatRecordsPayload` (WP-10 Task 5) — the entities -> wire
 * mapping `chat.switch`/`chat.create`/`project.open` all share to build a `chat.records`
 * payload from `ChatReader.loadTail`'s own `ChatLoadResultV1`.
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

  test("maps an agent record's changedPages/warnings verbatim", () => {
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
      warnings: [{ kind: "gate:orphan-import", message: "unused import" }],
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
    };

    const payload = buildChatRecordsPayload(chatId, loadResult);

    expect(payload.chatId).toBe(chatId);
    expect(payload.prevCursor).toBeNull();
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
    };

    const payload = buildChatRecordsPayload(chatId, loadResult);

    expect(payload.records).toEqual([]);
    expect(payload.prevCursor).toEqual({ generation: 0, beforeOffset: 128 });
  });
});
