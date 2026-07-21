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
});
