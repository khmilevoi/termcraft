import { describe, expect, test } from "bun:test";

import type { FailureDtoV1 } from "core/protocol";
import type { ChatUserRecord } from "entities/chat";

import { createFakeChatStore } from "./chat-store";

const FAILURE: FailureDtoV1 = {
  code: "PERSISTENCE_FAILED",
  retryable: false,
  safeMessage: "chat log unreadable",
  details: {},
};

function userRecord(recordId: string): ChatUserRecord {
  return { kind: "user", recordId, turnId: "turn-1", text: "hi", ts: "2024-01-01T00:00:00.000Z" };
}

describe("createFakeChatStore", () => {
  test("create() mints a fresh chat with a deterministic id and clock-sourced createdAt", async () => {
    const fixed = new Date("2026-01-02T03:04:05.000Z");
    const store = createFakeChatStore({ clock: { now: () => fixed } });
    const header = await store.create();
    if ("code" in header) throw new Error("unexpected failure");
    expect(header.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(header.chatId).toBeTruthy();
  });

  test("open() finds a created chat and loadTail() returns its records", async () => {
    const store = createFakeChatStore();
    const header = await store.create();
    if ("code" in header) throw new Error("unexpected failure");
    store.seedRecords(header.chatId, [userRecord("r1"), userRecord("r2")]);
    const handle = await store.open(header.chatId);
    if ("code" in handle) throw new Error("unexpected failure");
    const tail = await handle.loadTail();
    if ("code" in tail) throw new Error("unexpected failure");
    expect(tail.records.map((r) => r.recordId)).toEqual(["r1", "r2"]);
  });

  test("open() on an unknown chat id returns an intrinsic not-found failure", async () => {
    const store = createFakeChatStore();
    const result = await store.open("missing-chat");
    expect("code" in result).toBe(true);
  });

  test("switchActive() on an unknown chat id returns an intrinsic not-found failure", async () => {
    const store = createFakeChatStore();
    const result = await store.switchActive("missing-chat");
    expect(result).not.toBeUndefined();
  });

  test("switchActive() on a known chat succeeds", async () => {
    const store = createFakeChatStore();
    const header = await store.create();
    if ("code" in header) throw new Error("unexpected failure");
    const result = await store.switchActive(header.chatId);
    expect(result).toBeUndefined();
  });

  test("failNext() overrides the next call to a named method with the queued failure", async () => {
    const store = createFakeChatStore();
    store.failNext("create", FAILURE);
    const first = await store.create();
    expect(first).toEqual(FAILURE);
    const second = await store.create();
    expect("code" in second).toBe(false);
  });

  test("records calls across the reader and mutations facets in order", async () => {
    const store = createFakeChatStore();
    const header = await store.create();
    if ("code" in header) throw new Error("unexpected failure");
    await store.open(header.chatId);
    await store.switchActive(header.chatId);
    expect(store.calls.map((c) => c.method)).toEqual(["create", "open", "switchActive"]);
  });

  // Gap 4 closure (kernel-assembly Task 9): `turn.start` needs the chat's send-time
  // append-base (`{length, prefixSha256}`) — a raw byte-level fact `open()`/`ChatHandleV1`
  // never expose (they decode records, never raw bytes). See `chat-store.ts`'s own doc
  // comment on `readAppendBase` for the full citation.
  describe("readAppendBase()", () => {
    test("on an unknown chat id returns an intrinsic not-found failure", async () => {
      const store = createFakeChatStore();
      const result = await store.readAppendBase("missing-chat");
      expect("code" in result).toBe(true);
    });

    test("on a chat with no records returns a stable, deterministic base", async () => {
      const store = createFakeChatStore();
      const header = await store.create();
      if ("code" in header) throw new Error("unexpected failure");
      const first = await store.readAppendBase(header.chatId);
      const second = await store.readAppendBase(header.chatId);
      if ("code" in first) throw new Error("unexpected failure");
      if ("code" in second) throw new Error("unexpected failure");
      // Deterministic: reading twice with nothing appended in between yields the SAME
      // length/hash — never a value that changes just because it was read again.
      expect(first).toEqual(second);
      expect(first.prefixSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    test("changes once a record is appended — never a fabricated, unchanging baseline", async () => {
      const store = createFakeChatStore();
      const header = await store.create();
      if ("code" in header) throw new Error("unexpected failure");
      const before = await store.readAppendBase(header.chatId);
      if ("code" in before) throw new Error("unexpected failure");

      store.seedRecords(header.chatId, [userRecord("r1")]);
      const after = await store.readAppendBase(header.chatId);
      if ("code" in after) throw new Error("unexpected failure");

      expect(after.length).not.toBe(before.length);
      expect(after.prefixSha256).not.toBe(before.prefixSha256);
    });

    test("failNext() overrides the next call with the queued failure", async () => {
      const store = createFakeChatStore();
      const header = await store.create();
      if ("code" in header) throw new Error("unexpected failure");
      store.failNext("readAppendBase", FAILURE);
      const first = await store.readAppendBase(header.chatId);
      expect(first).toEqual(FAILURE);
      const second = await store.readAppendBase(header.chatId);
      expect("code" in second).toBe(false);
    });
  });
});
