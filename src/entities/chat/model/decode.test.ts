import { describe, expect, test } from "bun:test";

import { uuidv7 } from "infrastructure/uuid";

import { ChatDecodeError, decodeChatHeader, decodeChatRecord } from "./decode";

const TS = "2026-07-19T12:00:00.000Z";

function ok<T>(result: T | ChatDecodeError): T {
  if (result instanceof ChatDecodeError) throw new Error(`expected success, got ${result.message}`);
  return result;
}

describe("decodeChatHeader", () => {
  test("decodes a valid header", () => {
    const header = ok(
      decodeChatHeader({
        kind: "chat",
        formatVersion: 1,
        projectId: uuidv7(),
        chatId: uuidv7(),
        createdAt: TS,
      }),
    );
    expect(header.kind).toBe("chat");
    expect(header.formatVersion).toBe(1);
  });

  test("rejects wrong kind, version, ids, and timestamp", () => {
    expect(
      decodeChatHeader({
        kind: "pins",
        formatVersion: 1,
        projectId: uuidv7(),
        chatId: uuidv7(),
        createdAt: TS,
      }),
    ).toBeInstanceOf(ChatDecodeError);
    expect(
      decodeChatHeader({
        kind: "chat",
        formatVersion: 2,
        projectId: uuidv7(),
        chatId: uuidv7(),
        createdAt: TS,
      }),
    ).toBeInstanceOf(ChatDecodeError);
    expect(
      decodeChatHeader({
        kind: "chat",
        formatVersion: 1,
        projectId: "not-a-uuid",
        chatId: uuidv7(),
        createdAt: TS,
      }),
    ).toBeInstanceOf(ChatDecodeError);
    expect(
      decodeChatHeader({
        kind: "chat",
        formatVersion: 1,
        projectId: uuidv7(),
        chatId: uuidv7(),
        createdAt: "2026-07-19",
      }),
    ).toBeInstanceOf(ChatDecodeError);
    expect(decodeChatHeader("nope")).toBeInstanceOf(ChatDecodeError);
  });
});

describe("decodeChatRecord", () => {
  test("decodes a user record with selection and pins", () => {
    const rec = ok(
      decodeChatRecord({
        kind: "user",
        recordId: uuidv7(),
        turnId: uuidv7(),
        text: "hello",
        selection: { pageSlug: "home", element: "btn-1" },
        pins: [uuidv7(), uuidv7()],
        ts: TS,
      }),
    );
    expect(rec.kind).toBe("user");
    if (rec.kind === "user") {
      expect(rec.selection?.pageSlug).toBe("home" as never);
      expect(rec.pins?.length).toBe(2);
    }
  });

  test("decodes a user record without optional fields", () => {
    const rec = ok(
      decodeChatRecord({ kind: "user", recordId: uuidv7(), turnId: uuidv7(), text: "hi", ts: TS }),
    );
    if (rec.kind === "user") {
      expect(rec.selection).toBeUndefined();
      expect(rec.pins).toBeUndefined();
    }
  });

  test("decodes an agent record with changedPages and warnings", () => {
    const rec = ok(
      decodeChatRecord({
        kind: "agent",
        recordId: uuidv7(),
        turnId: uuidv7(),
        text: "done",
        changedPages: ["home", "settings"],
        warnings: [{ kind: "unguarded-timer", message: "setTimeout without guard" }],
        ts: TS,
      }),
    );
    if (rec.kind === "agent") {
      expect(rec.changedPages.length).toBe(2);
      expect(rec.warnings[0]?.kind).toBe("unguarded-timer");
    }
  });

  test("decodes a warning carrying file/line (Task 11 widening) — TREE-relative, matching GateWarningV1.file", () => {
    const rec = ok(
      decodeChatRecord({
        kind: "agent",
        recordId: uuidv7(),
        turnId: uuidv7(),
        text: "done",
        changedPages: [],
        warnings: [
          {
            kind: "nondeterministic-time",
            message: "`Date.now()` reads wall-clock time",
            file: "pages/stopwatch.tsx",
            line: 55,
          },
        ],
        ts: TS,
      }),
    );
    if (rec.kind === "agent") {
      expect(rec.warnings[0]?.file).toBe("pages/stopwatch.tsx");
      expect(rec.warnings[0]?.line).toBe(55);
    }
  });

  test("decodes an empty-diff agent record", () => {
    const rec = ok(
      decodeChatRecord({
        kind: "agent",
        recordId: uuidv7(),
        turnId: uuidv7(),
        text: "no change",
        changedPages: [],
        warnings: [],
        ts: TS,
      }),
    );
    if (rec.kind === "agent") expect(rec.changedPages).toEqual([]);
  });

  test("decodes system:error with turnId and an outcome", () => {
    const rec = ok(
      decodeChatRecord({
        kind: "system:error",
        recordId: uuidv7(),
        turnId: uuidv7(),
        outcome: "stale",
        text: "source changed",
        ts: TS,
      }),
    );
    if (rec.kind === "system:error") expect(rec.outcome).toBe("stale");
  });

  test("decodes system:error with actionId (no turnId)", () => {
    const rec = ok(
      decodeChatRecord({
        kind: "system:error",
        recordId: uuidv7(),
        actionId: uuidv7(),
        outcome: "error",
        text: "boom",
        reason: "process_restart",
        ts: TS,
      }),
    );
    if (rec.kind === "system:error") expect(rec.actionId).toBeDefined();
  });

  test("decodes system:cancelled", () => {
    const rec = ok(
      decodeChatRecord({
        kind: "system:cancelled",
        recordId: uuidv7(),
        turnId: uuidv7(),
        text: "cancelled",
        ts: TS,
      }),
    );
    expect(rec.kind).toBe("system:cancelled");
  });

  test("decodes system:restore (reader completeness)", () => {
    const rec = ok(
      decodeChatRecord({
        kind: "system:restore",
        recordId: uuidv7(),
        restoreActionId: uuidv7(),
        pageSlug: "home",
        sourceCommit: "abc123",
        ts: TS,
      }),
    );
    expect(rec.kind).toBe("system:restore");
  });

  test("rejects an unknown kind", () => {
    expect(decodeChatRecord({ kind: "banana", recordId: uuidv7(), ts: TS })).toBeInstanceOf(
      ChatDecodeError,
    );
  });

  test("rejects a bad recordId or timestamp", () => {
    expect(
      decodeChatRecord({ kind: "user", recordId: "x", turnId: uuidv7(), text: "hi", ts: TS }),
    ).toBeInstanceOf(ChatDecodeError);
    expect(
      decodeChatRecord({
        kind: "user",
        recordId: uuidv7(),
        turnId: uuidv7(),
        text: "hi",
        ts: "yesterday",
      }),
    ).toBeInstanceOf(ChatDecodeError);
  });

  test("rejects a missing required field", () => {
    expect(
      decodeChatRecord({ kind: "user", recordId: uuidv7(), turnId: uuidv7(), ts: TS }),
    ).toBeInstanceOf(ChatDecodeError); // no text
    expect(
      decodeChatRecord({
        kind: "agent",
        recordId: uuidv7(),
        turnId: uuidv7(),
        text: "x",
        warnings: [],
        ts: TS,
      }),
    ).toBeInstanceOf(ChatDecodeError); // no changedPages
  });

  test("rejects system:error with both turnId AND actionId", () => {
    expect(
      decodeChatRecord({
        kind: "system:error",
        recordId: uuidv7(),
        turnId: uuidv7(),
        actionId: uuidv7(),
        outcome: "error",
        text: "x",
        ts: TS,
      }),
    ).toBeInstanceOf(ChatDecodeError);
  });

  test("rejects system:cancelled with neither turnId nor actionId", () => {
    expect(
      decodeChatRecord({ kind: "system:cancelled", recordId: uuidv7(), text: "x", ts: TS }),
    ).toBeInstanceOf(ChatDecodeError);
  });

  test("rejects an invalid pageSlug in selection or changedPages", () => {
    expect(
      decodeChatRecord({
        kind: "user",
        recordId: uuidv7(),
        turnId: uuidv7(),
        text: "x",
        selection: { pageSlug: "BAD", element: "e" },
        ts: TS,
      }),
    ).toBeInstanceOf(ChatDecodeError);
    expect(
      decodeChatRecord({
        kind: "agent",
        recordId: uuidv7(),
        turnId: uuidv7(),
        text: "x",
        changedPages: ["BAD"],
        warnings: [],
        ts: TS,
      }),
    ).toBeInstanceOf(ChatDecodeError);
  });

  test("rejects a non-UUIDv7 pin reference", () => {
    expect(
      decodeChatRecord({
        kind: "user",
        recordId: uuidv7(),
        turnId: uuidv7(),
        text: "x",
        pins: ["not-a-uuid"],
        ts: TS,
      }),
    ).toBeInstanceOf(ChatDecodeError);
  });

  test("rejects an invalid system:error outcome", () => {
    expect(
      decodeChatRecord({
        kind: "system:error",
        recordId: uuidv7(),
        turnId: uuidv7(),
        outcome: "weird",
        text: "x",
        ts: TS,
      }),
    ).toBeInstanceOf(ChatDecodeError);
  });

  test("ignores unknown extra fields (forward-compatible)", () => {
    const rec = ok(
      decodeChatRecord({
        kind: "user",
        recordId: uuidv7(),
        turnId: uuidv7(),
        text: "hi",
        ts: TS,
        futureField: 42,
      }),
    );
    expect(rec.kind).toBe("user");
  });
});
