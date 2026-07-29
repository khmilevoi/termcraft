import { afterEach, describe, expect, test } from "bun:test";

import type { TurnReadSetV1 } from "core/ports";
import { createFakeTurnTransactionService } from "core/ports/fakes";
import type { ChatAgentRecord, ChatSystemErrorRecord, ChatUserRecord } from "entities/chat";
import { uuidv7 } from "infrastructure/uuid";
import { readChatJsonl, sha256Hex } from "store/jsonl";
import { PROJECT_MANIFEST_FILENAME } from "store/toml";
import { chatJsonlPath } from "store/transaction";

import { cleanupScratchRoots, createRealProjectFixture } from "./test-support";
import { createTurnTransactionsAdapter } from "./turn-transactions";

afterEach(cleanupScratchRoots);

async function currentReadSet(
  open: Awaited<ReturnType<typeof createRealProjectFixture>>["open"],
  chatId: string,
): Promise<TurnReadSetV1> {
  const manifestBytes = open.safeFs.readFile(PROJECT_MANIFEST_FILENAME);
  if (manifestBytes instanceof Error) throw new Error(`fixture bug: ${manifestBytes.message}`);
  const chatPath = chatJsonlPath(chatId);
  const chatBytes = open.safeFs.readFile(chatPath);
  if (chatBytes instanceof Error) throw new Error(`fixture bug: ${chatBytes.message}`);
  const doc = readChatJsonl({ path: chatPath, chunks: [chatBytes] });
  if (doc instanceof Error) throw new Error(`fixture bug: ${doc.message}`);

  return {
    manifest: {
      state: "file",
      sha256: sha256Hex(manifestBytes),
      size: manifestBytes.byteLength,
    },
    designFiles: new Map(),
    chat: { length: doc.validPrefixBytes, prefixSha256: doc.prefixSha256 },
    pins: new Map(),
  };
}

describe("createTurnTransactionsAdapter — contract test (fake vs. real)", () => {
  test("admit() appends exactly the user record, committed before any agent process starts", async () => {
    const fake = createFakeTurnTransactionService();
    const userRecord: ChatUserRecord = {
      kind: "user",
      recordId: uuidv7(),
      turnId: uuidv7(),
      text: "hello",
      ts: "2026-07-24T00:00:00.000Z",
    };
    const fakeCommit = await fake.admit({
      turnId: userRecord.turnId,
      targetChatId: "chat-1",
      userRecord,
      createdAt: "2026-07-24T00:00:00.000Z",
    });
    expect("code" in fakeCommit).toBe(false);

    const { open, deps } = await createRealProjectFixture();
    try {
      const chatId = await firstChatId(open);
      const adapter = createTurnTransactionsAdapter(deps);
      const commit = await adapter.admit({
        turnId: userRecord.turnId,
        targetChatId: chatId,
        userRecord,
        createdAt: "2026-07-24T00:00:00.000Z",
      });
      if ("code" in commit) throw new Error("fixture bug: admit() failed");
      expect(typeof commit.transactionId).toBe("string");

      const handle = await open.chats.open(chatId);
      if (handle instanceof Error) throw new Error(`fixture bug: ${handle.message}`);
      const tail = await handle.loadTail();
      if (tail instanceof Error) throw new Error(`fixture bug: ${tail.message}`);
      expect(tail.records).toEqual([userRecord]);
    } finally {
      await open.close();
    }
  });

  test("finalize() commits an agent record when the read-set CAS matches current state", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const chatId = await firstChatId(open);
      const adapter = createTurnTransactionsAdapter(deps);
      const turnId = uuidv7();
      const userRecord: ChatUserRecord = {
        kind: "user",
        recordId: uuidv7(),
        turnId,
        text: "hello",
        ts: "2026-07-24T00:00:00.000Z",
      };
      const admitted = await adapter.admit({
        turnId,
        targetChatId: chatId,
        userRecord,
        createdAt: "2026-07-24T00:00:00.000Z",
      });
      if ("code" in admitted) throw new Error("fixture bug: admit() failed");

      const readSet = await currentReadSet(open, chatId);
      const agentRecord: ChatAgentRecord = {
        kind: "agent",
        recordId: uuidv7(),
        turnId,
        text: "done",
        changedPages: [],
        warnings: [],
        ts: "2026-07-24T00:00:01.000Z",
      };
      const finalized = await adapter.finalize({
        turnId,
        targetChatId: chatId,
        changedFiles: [],
        changedPageSlugs: [],
        agentRecord,
        resolvedPins: [],
        readSet,
        createdAt: "2026-07-24T00:00:01.000Z",
      });
      if ("code" in finalized)
        throw new Error(`fixture bug: finalize() failed: ${finalized.safeMessage}`);

      const handle = await open.chats.open(chatId);
      if (handle instanceof Error) throw new Error(`fixture bug: ${handle.message}`);
      const tail = await handle.loadTail();
      if (tail instanceof Error) throw new Error(`fixture bug: ${tail.message}`);
      expect(tail.records).toEqual([userRecord, agentRecord]);
    } finally {
      await open.close();
    }
  });

  test("finalize() returns APPLY_STALE with details.part 'chat' when the chat drifted since the read-set was captured", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const chatId = await firstChatId(open);
      const adapter = createTurnTransactionsAdapter(deps);
      const turnId = uuidv7();
      const userRecord: ChatUserRecord = {
        kind: "user",
        recordId: uuidv7(),
        turnId,
        text: "hello",
        ts: "2026-07-24T00:00:00.000Z",
      };
      const admitted = await adapter.admit({
        turnId,
        targetChatId: chatId,
        userRecord,
        createdAt: "2026-07-24T00:00:00.000Z",
      });
      if ("code" in admitted) throw new Error("fixture bug: admit() failed");

      // Captured BEFORE a second, unrelated admit — now stale by the time finalize runs.
      const staleReadSet = await currentReadSet(open, chatId);

      const secondTurnId = uuidv7();
      const secondAdmit = await adapter.admit({
        turnId: secondTurnId,
        targetChatId: chatId,
        userRecord: { ...userRecord, recordId: uuidv7(), turnId: secondTurnId, text: "again" },
        createdAt: "2026-07-24T00:00:02.000Z",
      });
      if ("code" in secondAdmit) throw new Error("fixture bug: second admit() failed");

      const agentRecord: ChatAgentRecord = {
        kind: "agent",
        recordId: uuidv7(),
        turnId,
        text: "done",
        changedPages: [],
        warnings: [],
        ts: "2026-07-24T00:00:03.000Z",
      };
      const finalized = await adapter.finalize({
        turnId,
        targetChatId: chatId,
        changedFiles: [],
        changedPageSlugs: [],
        agentRecord,
        resolvedPins: [],
        readSet: staleReadSet,
        createdAt: "2026-07-24T00:00:03.000Z",
      });
      if (!("code" in finalized)) throw new Error("fixture bug: expected a stale failure");
      expect(finalized.code).toBe("APPLY_STALE");
      expect(finalized.details.part).toBe("chat");
    } finally {
      await open.close();
    }
  });

  test("terminalize() appends exactly one terminal record for an admitted turn", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const chatId = await firstChatId(open);
      const adapter = createTurnTransactionsAdapter(deps);
      const turnId = uuidv7();
      const userRecord: ChatUserRecord = {
        kind: "user",
        recordId: uuidv7(),
        turnId,
        text: "hello",
        ts: "2026-07-24T00:00:00.000Z",
      };
      const admitted = await adapter.admit({
        turnId,
        targetChatId: chatId,
        userRecord,
        createdAt: "2026-07-24T00:00:00.000Z",
      });
      if ("code" in admitted) throw new Error("fixture bug: admit() failed");

      const record: ChatSystemErrorRecord = {
        kind: "system:error",
        recordId: uuidv7(),
        turnId,
        outcome: "interrupted",
        text: "termcraft restarted before this turn finished.",
        ts: "2026-07-24T00:00:01.000Z",
      };
      const terminalized = await adapter.terminalize({
        turnId,
        targetChatId: chatId,
        record,
        createdAt: "2026-07-24T00:00:01.000Z",
      });
      if ("code" in terminalized) throw new Error("fixture bug: terminalize() failed");

      const handle = await open.chats.open(chatId);
      if (handle instanceof Error) throw new Error(`fixture bug: ${handle.message}`);
      const tail = await handle.loadTail();
      if (tail instanceof Error) throw new Error(`fixture bug: ${tail.message}`);
      expect(tail.records).toEqual([userRecord, record]);
    } finally {
      await open.close();
    }
  });
});

/** Every real project ships with exactly one chat header, minted by `createProject`. */
async function firstChatId(
  open: Awaited<ReturnType<typeof createRealProjectFixture>>["open"],
): Promise<string> {
  const names = open.safeFs.list("chats");
  if (names instanceof Error) throw new Error(`fixture bug: ${names.message}`);
  const first = names[0];
  if (first === undefined) throw new Error("fixture bug: no chat file");
  return first.replace(/\.jsonl$/, "");
}
