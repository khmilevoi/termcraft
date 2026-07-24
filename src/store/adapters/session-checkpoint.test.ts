import { afterEach, describe, expect, test } from "bun:test";

import { createFakeSessionCheckpointService } from "core/ports/fakes";
import type { ChatUserRecord } from "entities/chat";
import { uuidv7 } from "infrastructure/uuid";

import { createSessionCheckpointAdapter } from "./session-checkpoint";
import { cleanupScratchRoots, createRealProjectFixture } from "./test-support";
import { createTurnTransactionsAdapter } from "./turn-transactions";

afterEach(cleanupScratchRoots);

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

describe("createSessionCheckpointAdapter — contract test (fake vs. real)", () => {
  test("evaluateResume() is 'fresh' when no checkpoint has ever been recorded", async () => {
    const fake = createFakeSessionCheckpointService();
    expect(await fake.evaluateResume({ chatId: "chat-1", sessionScopeId: "scope-1" })).toEqual({
      kind: "fresh",
    });

    const { open, deps } = await createRealProjectFixture();
    try {
      const chatId = await firstChatId(open);
      const adapter = createSessionCheckpointAdapter(deps);
      const verdict = await adapter.evaluateResume({ chatId, sessionScopeId: "scope-1" });
      expect(verdict).toEqual({ kind: "fresh" });
    } finally {
      await open.close();
    }
  });

  test("selectSeed() is [] for a chat with no records yet", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const chatId = await firstChatId(open);
      const adapter = createSessionCheckpointAdapter(deps);
      const seed = await adapter.selectSeed(chatId);
      expect(seed).toEqual([]);
    } finally {
      await open.close();
    }
  });

  test("advanceCheckpoint() then evaluateResume() resumes with the correct sessionId and no prompt delta for an unchanged chat", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const chatId = await firstChatId(open);
      const adapter = createSessionCheckpointAdapter(deps);
      const turns = createTurnTransactionsAdapter(deps);

      const turnId = uuidv7();
      const userRecord: ChatUserRecord = {
        kind: "user",
        recordId: uuidv7(),
        turnId,
        text: "hello",
        ts: "2026-07-24T00:00:00.000Z",
      };
      const admitted = await turns.admit({
        turnId,
        targetChatId: chatId,
        userRecord,
        createdAt: "2026-07-24T00:00:00.000Z",
      });
      if ("code" in admitted) throw new Error("fixture bug: admit() failed");

      const sessionId = uuidv7();
      const advanced = await adapter.advanceCheckpoint({
        chatId,
        sessionScopeId: "scope-1",
        sessionId,
      });
      expect(advanced).toBeUndefined();

      const verdict = await adapter.evaluateResume({ chatId, sessionScopeId: "scope-1" });
      expect(verdict).toEqual({ kind: "resume", sessionId, promptDelta: null });

      // A different scope never matches this checkpoint.
      const otherScope = await adapter.evaluateResume({ chatId, sessionScopeId: "scope-2" });
      expect(otherScope).toEqual({ kind: "fresh" });
    } finally {
      await open.close();
    }
  });

  test("evaluateResume() resumes with a rendered prompt delta once new records land after the checkpoint", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const chatId = await firstChatId(open);
      const adapter = createSessionCheckpointAdapter(deps);
      const turns = createTurnTransactionsAdapter(deps);

      const firstTurnId = uuidv7();
      const firstUser: ChatUserRecord = {
        kind: "user",
        recordId: uuidv7(),
        turnId: firstTurnId,
        text: "hello",
        ts: "2026-07-24T00:00:00.000Z",
      };
      const firstAdmit = await turns.admit({
        turnId: firstTurnId,
        targetChatId: chatId,
        userRecord: firstUser,
        createdAt: "2026-07-24T00:00:00.000Z",
      });
      if ("code" in firstAdmit) throw new Error("fixture bug: first admit() failed");

      const sessionId = uuidv7();
      const advanced = await adapter.advanceCheckpoint({
        chatId,
        sessionScopeId: "scope-1",
        sessionId,
      });
      expect(advanced).toBeUndefined();

      const secondTurnId = uuidv7();
      const secondUser: ChatUserRecord = {
        kind: "user",
        recordId: uuidv7(),
        turnId: secondTurnId,
        text: "again",
        ts: "2026-07-24T00:00:01.000Z",
      };
      const secondAdmit = await turns.admit({
        turnId: secondTurnId,
        targetChatId: chatId,
        userRecord: secondUser,
        createdAt: "2026-07-24T00:00:01.000Z",
      });
      if ("code" in secondAdmit) throw new Error("fixture bug: second admit() failed");

      const verdict = await adapter.evaluateResume({ chatId, sessionScopeId: "scope-1" });
      if ("code" in verdict) throw new Error("fixture bug: evaluateResume() failed");
      if (verdict.kind !== "resume") throw new Error("fixture bug: expected a resume verdict");
      expect(verdict.sessionId).toBe(sessionId);
      expect(verdict.promptDelta).toBe("User: again");
    } finally {
      await open.close();
    }
  });
});
