import { describe, expect, test } from "bun:test";

import type { FailureDtoV1 } from "core/protocol";

import { createFakeSessionCheckpointService } from "./session-checkpoint";

const FAILURE: FailureDtoV1 = {
  code: "PERSISTENCE_FAILED",
  retryable: false,
  safeMessage: "checkpoint unreadable",
  details: {},
};

describe("createFakeSessionCheckpointService", () => {
  test("evaluateResume() is 'fresh' for a chat/scope with no prior checkpoint", async () => {
    const service = createFakeSessionCheckpointService();
    const result = await service.evaluateResume({ chatId: "chat-1", sessionScopeId: "scope-1" });
    expect(result).toEqual({ kind: "fresh" });
  });

  test("advanceCheckpoint() then evaluateResume() resolves to 'resume' with that sessionId", async () => {
    const service = createFakeSessionCheckpointService();
    await service.advanceCheckpoint({
      chatId: "chat-1",
      sessionScopeId: "scope-1",
      sessionId: "sess-1",
    });
    const result = await service.evaluateResume({ chatId: "chat-1", sessionScopeId: "scope-1" });
    expect(result).toEqual({ kind: "resume", sessionId: "sess-1", promptDelta: null });
  });

  test("a different sessionScopeId is a distinct checkpoint slot — resolves 'fresh'", async () => {
    const service = createFakeSessionCheckpointService();
    await service.advanceCheckpoint({
      chatId: "chat-1",
      sessionScopeId: "scope-1",
      sessionId: "sess-1",
    });
    const result = await service.evaluateResume({ chatId: "chat-1", sessionScopeId: "scope-2" });
    expect(result).toEqual({ kind: "fresh" });
  });

  test("selectSeed() defaults to an empty seed when none was configured", async () => {
    const service = createFakeSessionCheckpointService();
    const result = await service.selectSeed("chat-1");
    expect(result).toEqual([]);
  });

  test("selectSeed() returns the seed configured at construction", async () => {
    const service = createFakeSessionCheckpointService({
      seeds: new Map([["chat-1", [{ role: "user", text: "hi" }]]]),
    });
    const result = await service.selectSeed("chat-1");
    expect(result).toEqual([{ role: "user", text: "hi" }]);
  });

  test("failNext() queues one failure for evaluateResume()", async () => {
    const service = createFakeSessionCheckpointService();
    service.failNext("evaluateResume", FAILURE);
    const first = await service.evaluateResume({ chatId: "chat-1", sessionScopeId: "scope-1" });
    expect(first).toEqual(FAILURE);
    const second = await service.evaluateResume({ chatId: "chat-1", sessionScopeId: "scope-1" });
    expect(second).toEqual({ kind: "fresh" });
  });

  test("records calls in order", async () => {
    const service = createFakeSessionCheckpointService();
    await service.evaluateResume({ chatId: "chat-1", sessionScopeId: "scope-1" });
    await service.selectSeed("chat-1");
    await service.advanceCheckpoint({
      chatId: "chat-1",
      sessionScopeId: "scope-1",
      sessionId: "sess-1",
    });
    expect(service.calls.map((c) => c.method)).toEqual([
      "evaluateResume",
      "selectSeed",
      "advanceCheckpoint",
    ]);
  });
});
