import { describe, expect, test } from "bun:test";

import type { TurnFence } from "entities/turn";

import type { AgentTask } from "../agent-backend";
import { createFakeAgentBackend } from "./agent-backend";

const fence: TurnFence = { turnId: "t1", attempt: 1, leaseNonce: "n1" };

const task: AgentTask = {
  fence,
  workspacePath: "C:/fake-turn-workspace/t1",
  systemPrompt: "system",
  userMessage: "hi",
  model: "claude",
  effort: "medium",
  session: { kind: "fresh", seed: [] },
};

describe("createFakeAgentBackend", () => {
  test("startTurn() returns a run bound to the exact fence, with no events until emitted", async () => {
    const backend = createFakeAgentBackend();
    const run = backend.startTurn(task);
    expect(run.fence).toEqual(fence);
    backend.completeRun(fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "sess-1",
    });
    const outcome = await run.outcome;
    expect(outcome).toEqual({
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "sess-1",
    });
  });

  test("emitEvent() delivers live events through the run's async iterable before completion", async () => {
    const backend = createFakeAgentBackend();
    const run = backend.startTurn(task);
    backend.emitEvent(fence, { kind: "reasoning", text: "thinking" });
    backend.completeRun(fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "sess-1",
    });

    const seen: string[] = [];
    for await (const fencedEvent of run.events) {
      seen.push(fencedEvent.event.kind);
    }
    expect(seen).toEqual(["reasoning"]);
  });

  test("cancel() resolves only after the run's outcome settles", async () => {
    const backend = createFakeAgentBackend();
    const run = backend.startTurn(task);
    let cancelResolved = false;
    const cancelPromise = backend.cancel(run).then(() => {
      cancelResolved = true;
    });
    await Promise.resolve();
    expect(cancelResolved).toBe(false);
    backend.completeRun(fence, { kind: "cancelled", exitConfirmed: true });
    await cancelPromise;
    expect(cancelResolved).toBe(true);
  });

  test("healthCheck() defaults to ready, and queueHealth() scripts one degraded probe", async () => {
    const backend = createFakeAgentBackend();
    expect((await backend.healthCheck()).health).toEqual({ status: "ready" });
    backend.queueHealth({
      backendId: "fake-backend",
      health: { status: "not-installed" },
      account: null,
    });
    expect((await backend.healthCheck()).health).toEqual({ status: "not-installed" });
    expect((await backend.healthCheck()).health).toEqual({ status: "ready" });
  });

  test("sessionScope() is a pure deterministic function of its input", () => {
    const backend = createFakeAgentBackend();
    const a = backend.sessionScope({
      account: "acct-1",
      model: "claude",
      workspaceIdentity: "ws-1",
    });
    const b = backend.sessionScope({
      account: "acct-1",
      model: "claude",
      workspaceIdentity: "ws-1",
    });
    const c = backend.sessionScope({
      account: "acct-2",
      model: "claude",
      workspaceIdentity: "ws-1",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("records startTurn/cancel/healthCheck/sessionScope calls in order", async () => {
    const backend = createFakeAgentBackend();
    const run = backend.startTurn(task);
    backend.completeRun(fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "sess-1",
    });
    await backend.cancel(run);
    await backend.healthCheck();
    backend.sessionScope({ account: null, model: "claude", workspaceIdentity: "ws-1" });
    expect(backend.calls.map((c) => c.method)).toEqual([
      "startTurn",
      "cancel",
      "healthCheck",
      "sessionScope",
    ]);
  });
});
