import { afterEach, describe, expect, test } from "bun:test";

import { createFakeChatStore } from "core/ports/fakes";
import { uuidv7 } from "infrastructure/uuid";

import { createChatStoreAdapter } from "./chat-store";
import { cleanupScratchRoots, createRealProjectFixture } from "./test-support";

afterEach(cleanupScratchRoots);

describe("createChatStoreAdapter — contract test (fake vs. real)", () => {
  test("open() on an unknown chatId returns a FailureDtoV1 from both the fake and the real adapter", async () => {
    const fake = createFakeChatStore();
    const fakeResult = await fake.open("no-such-chat");
    expect("code" in fakeResult).toBe(true);

    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createChatStoreAdapter(deps);
      const realResult = await adapter.open("no-such-chat");
      expect("code" in realResult).toBe(true);
    } finally {
      await open.close();
    }
  });

  test("create() mints a fresh chat header that open()/readAppendBase() can then see", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createChatStoreAdapter(deps);
      const header = await adapter.create();
      if ("code" in header) throw new Error("fixture bug: create() failed");
      expect(typeof header.chatId).toBe("string");
      expect(() => new Date(header.createdAt).toISOString()).not.toThrow();

      const handle = await adapter.open(header.chatId);
      if ("code" in handle) throw new Error("fixture bug: open() failed");
      expect(handle.header).toEqual(header);

      const tail = await handle.loadTail();
      if ("code" in tail) throw new Error("fixture bug: loadTail() failed");
      expect(tail.records).toEqual([]);
      expect(tail.prevCursor).toBeNull();

      const base = await adapter.readAppendBase(header.chatId);
      if ("code" in base) throw new Error("fixture bug: readAppendBase() failed");
      expect(base.length).toBeGreaterThan(0); // at least the header line
      expect(base.prefixSha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await open.close();
    }
  });

  test("switchActive() on the freshly-created chat succeeds and is reflected in workspace state", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createChatStoreAdapter(deps);
      const header = await adapter.create();
      if ("code" in header) throw new Error("fixture bug: create() failed");

      const switched = await adapter.switchActive(header.chatId);
      expect(switched).toBeUndefined();

      const workspace = await open.workspaceState.read();
      if (workspace instanceof Error) throw new Error(`fixture bug: ${workspace.message}`);
      expect(workspace.state.activeChatId).toBe(header.chatId);
    } finally {
      await open.close();
    }
  });

  // DIVERGENCE (documented, not silent): the fake refuses `switchActive` for an unknown
  // chatId, but the real `TransactionEngine.setActiveChat` is a pure local-state patch with
  // no existence check (`store/model/factory.ts`'s `setActiveChat` never reads `chats`) — it
  // always succeeds for any syntactically valid (canonical UUIDv7) chatId, known or not.
  // Existence validation for `chat.switch` (kernel-command-contract §8.2) is therefore a
  // `core`-level concern (mirroring `page.reorder`'s permutation check living in
  // `core/project/model/page-mutations.ts`, not in the store adapter), out of this adapter's
  // scope. This test asserts the REAL adapter's actual behavior rather than the fake's
  // stronger contract; it uses a fresh, syntactically valid UUIDv7 that names no real chat,
  // since `workspace.local.toml`'s own schema requires `active_chat_id` to canonically parse
  // as one (`store/toml/model/workspace-toml.ts`) — an arbitrary non-UUID string would instead
  // fail that ROUND-TRIP read-back as `corrupt`, a different (also real) behavior, not this one.
  test("switchActive() on the real adapter succeeds even for an unknown (but well-formed) chatId", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createChatStoreAdapter(deps);
      const unknownChatId = uuidv7();
      const realResult = await adapter.switchActive(unknownChatId);
      expect(realResult).toBeUndefined();
      const workspace = await open.workspaceState.read();
      if (workspace instanceof Error) throw new Error(`fixture bug: ${workspace.message}`);
      expect(workspace.state.activeChatId).toBe(unknownChatId);
    } finally {
      await open.close();
    }
  });

  test("readAppendBase() on an unknown chatId returns a FailureDtoV1", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createChatStoreAdapter(deps);
      const result = await adapter.readAppendBase("no-such-chat");
      expect("code" in result).toBe(true);
    } finally {
      await open.close();
    }
  });

  test("list() sees a freshly create()d chat with a null firstUserText (fix-bundle spec §2.1, Gap E)", async () => {
    const fake = createFakeChatStore();
    const fakeHeader = await fake.create();
    if ("code" in fakeHeader) throw new Error("fixture bug: fake create() failed");
    const fakeList = await fake.list();
    if ("code" in fakeList) throw new Error("fixture bug: fake list() failed");
    expect(fakeList).toEqual([
      { chatId: fakeHeader.chatId, createdAt: fakeHeader.createdAt, firstUserText: null },
    ]);

    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createChatStoreAdapter(deps);
      // The real project already has ONE chat from `createProject` (`store/model/factory.ts`'s
      // implicit first-chat mint) — `create()` here adds a second, so `list()` must report both.
      const header = await adapter.create();
      if ("code" in header) throw new Error("fixture bug: create() failed");

      const listed = await adapter.list();
      if ("code" in listed) throw new Error("fixture bug: list() failed");
      expect(listed.length).toBe(2);
      const entry = listed.find((candidate) => candidate.chatId === header.chatId);
      expect(entry).toEqual({
        chatId: header.chatId,
        createdAt: header.createdAt,
        firstUserText: null,
      });
    } finally {
      await open.close();
    }
  });
});
