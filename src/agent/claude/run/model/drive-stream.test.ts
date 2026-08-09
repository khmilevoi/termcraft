import { describe, expect, test } from "bun:test";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { NaturalOutcome, RunSink } from "agent/run";
import type { AgentEvent } from "entities/turn";

import { createClaudeDriver } from "./drive-stream";

/** Every test gets a real timeout guard so a hang fails loudly instead of stalling the suite. */
const GUARD_MS = 2000;

function fakeSink() {
  const emitted: AgentEvent[] = [];
  const completions: { outcome: NaturalOutcome; finalEvents: readonly AgentEvent[] }[] = [];
  let terminal = false;
  const sink: RunSink = {
    isTerminal: () => terminal,
    emit: (e: AgentEvent) => emitted.push(e),
    complete: (outcome: NaturalOutcome, finalEvents: readonly AgentEvent[] = []) =>
      completions.push({ outcome, finalEvents }),
  };
  return {
    emitted,
    completions,
    setTerminal: () => {
      terminal = true;
    },
    sink,
  };
}

function scriptedQuery(messages: readonly unknown[]) {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m;
    },
    interrupt: async () => {},
  });
}

/** A generator that yields `first`, blocks until `release()` is called, then yields `second`. */
function gatedQuery(
  first: unknown,
  second: unknown,
): { queryFn: () => unknown; release: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    queryFn: () => ({
      async *[Symbol.asyncIterator]() {
        yield first;
        await gate;
        yield second;
      },
      interrupt: async () => {},
    }),
    release,
  };
}

const assistant = {
  type: "assistant",
  session_id: "s1",
  uuid: "u1",
  parent_tool_use_id: null,
  message: {
    content: [
      { type: "text", text: "editing" },
      { type: "tool_use", id: "x", name: "Write", input: { file_path: "C:\\ws\\pages\\main.tsx" } },
    ],
  },
} as unknown as SDKMessage;

const success = {
  type: "result",
  subtype: "success",
  result: "done",
  session_id: "s1",
  uuid: "u2",
  usage: { input_tokens: 10, output_tokens: 2 },
  modelUsage: {},
  total_cost_usd: 0,
  permission_denials: [],
} as unknown as SDKMessage;

describe("createClaudeDriver", () => {
  test("claims a completed outcome on a success result", async () => {
    const { sink, completions } = fakeSink();
    const driver = createClaudeDriver({
      queryFn: scriptedQuery([
        {
          type: "result",
          subtype: "success",
          result: "hello",
          session_id: "s9",
          usage: {},
          modelUsage: {},
        },
      ]) as never,
      prompt: "p",
      options: {} as never,
      sessionKind: "fresh",
    });
    await driver(sink);
    expect(completions).toHaveLength(1);
    expect(completions[0]?.outcome).toMatchObject({
      kind: "completed",
      finalText: "hello",
      sessionId: "s9",
    });
  });

  test("reports a stream that ends without a result as a backend-error", async () => {
    const { sink, completions } = fakeSink();
    const driver = createClaudeDriver({
      queryFn: scriptedQuery([]) as never,
      prompt: "p",
      options: {} as never,
      sessionKind: "fresh",
    });
    await driver(sink);
    expect(completions[0]?.outcome.kind).toBe("backend-error");
    expect(completions[0]?.finalEvents[0]).toMatchObject({ kind: "error" });
  });

  test("converts a throwing stream into a backend-error carrying the last session id", async () => {
    const { sink, completions } = fakeSink();
    const queryFn = () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: "s3" };
        throw new Error("stream died");
      },
      interrupt: async () => {},
    });
    const driver = createClaudeDriver({
      queryFn: queryFn as never,
      prompt: "p",
      options: {} as never,
      sessionKind: "fresh",
    });
    await driver(sink);
    expect(completions[0]?.outcome).toMatchObject({ kind: "backend-error", sessionId: "s3" });
    if (completions[0]?.outcome.kind === "backend-error") {
      expect(completions[0].outcome.message).toContain("stream died");
    }
  });

  test("stops reading as soon as the sink reports terminal", async () => {
    const { sink, emitted, setTerminal } = fakeSink();
    setTerminal();
    const driver = createClaudeDriver({
      queryFn: scriptedQuery([
        {
          type: "assistant",
          session_id: "s1",
          message: { content: [{ type: "text", text: "hi" }] },
        },
      ]) as never,
      prompt: "p",
      options: {} as never,
      sessionKind: "fresh",
    });
    await driver(sink);
    expect(emitted).toEqual([]);
  });

  // --- SDK message mapping ---------------------------------------------------

  test(
    "an assistant message maps to reasoning+tool via the real tool-op mapping, then a success result claims a completed outcome with derived usage",
    async () => {
      const { sink, emitted, completions } = fakeSink();
      const driver = createClaudeDriver({
        queryFn: scriptedQuery([assistant, success]) as never,
        prompt: "p",
        options: {} as never,
        sessionKind: "fresh",
      });
      await driver(sink);

      expect(emitted.map((e) => e.kind)).toEqual(["reasoning", "tool"]);
      expect(completions).toHaveLength(1);
      // DEVIATION from the plan's literal test body: the plan scripted a
      // success result with usage:{input_tokens:10,output_tokens:2},
      // modelUsage:{} (so deriveUsage returns a non-null TokenUsage —
      // confirmed against normalize.ts/normalize.test.ts) yet asserted
      // `usage: null` on the outcome while asserting a `usage` event WAS
      // emitted from that same message — a genuine contradiction. Decision
      // (per task instructions): outcome.usage carries the SAME derived
      // TokenUsage the usage event carries; it is null only when deriveUsage
      // genuinely returns null.
      expect(completions[0]?.outcome).toEqual({
        kind: "completed",
        finalText: "done",
        usage: { inputTokens: 10, outputTokens: 2, contextPercent: null },
        sessionId: "s1",
      });
      expect(completions[0]?.finalEvents.map((e) => e.kind)).toEqual(["final", "usage"]);
    },
    GUARD_MS,
  );

  test(
    "the driver returns immediately after claiming a completed outcome and never processes a message that arrives after it (late-event drop)",
    async () => {
      const late = { ...assistant, uuid: "u3" } as unknown as SDKMessage;
      const { sink, emitted, completions } = fakeSink();
      const driver = createClaudeDriver({
        queryFn: scriptedQuery([success, late]) as never,
        prompt: "p",
        options: {} as never,
        sessionKind: "fresh",
      });
      await driver(sink);
      // DEVIATION from the plan's literal test body: the plan asserted
      // `["final"]`, silently assuming this fixture's `usage` derives to
      // null. It does not (same fixture as the test above) — normalizeMessage
      // emits final+usage together for one "result" message. Corrected to
      // match the actual normalizeMessage output.
      expect(completions).toHaveLength(1);
      expect(completions[0]?.finalEvents.map((e) => e.kind)).toEqual(["final", "usage"]);
      // The `late` duplicate message is never reached: the driver `return`s
      // right after `sink.complete()` for the success result.
      expect(emitted).toEqual([]);
    },
    GUARD_MS,
  );

  test(
    "an SDK generator throw after emitting prior reasoning/tool events becomes a backend-error carrying the last seen session id",
    async () => {
      const { sink, emitted, completions } = fakeSink();
      const queryFn = () => ({
        async *[Symbol.asyncIterator]() {
          yield assistant;
          throw new Error("stream exploded");
        },
        interrupt: async () => {},
      });
      const driver = createClaudeDriver({
        queryFn: queryFn as never,
        prompt: "p",
        options: {} as never,
        sessionKind: "fresh",
      });
      await driver(sink);

      expect(emitted.map((e) => e.kind)).toEqual(["reasoning", "tool"]);
      expect(completions).toHaveLength(1);
      expect(completions[0]?.outcome.kind).toBe("backend-error");
      if (completions[0]?.outcome.kind === "backend-error") {
        expect(completions[0].outcome.message).toContain("stream exploded");
        // sessionId falls back to the last session_id seen before the throw
        // (from the `assistant` message) since no `result` message ever arrived.
        expect(completions[0].outcome.sessionId).toBe("s1");
      }
      expect(completions[0]?.finalEvents[0]).toMatchObject({ kind: "error" });
    },
    GUARD_MS,
  );

  test(
    "a stream that yields prior events but ends without ever yielding a result message still resolves a backend-error",
    async () => {
      const { sink, emitted, completions } = fakeSink();
      const driver = createClaudeDriver({
        queryFn: scriptedQuery([assistant]) as never,
        prompt: "p",
        options: {} as never,
        sessionKind: "fresh",
      });
      await driver(sink);
      expect(emitted.map((e) => e.kind)).toEqual(["reasoning", "tool"]);
      expect(completions[0]?.outcome.kind).toBe("backend-error");
    },
    GUARD_MS,
  );

  test(
    "cancel winning mid-stream (isTerminal flips between messages) drops the still-pending message",
    async () => {
      const { sink, emitted, completions, setTerminal } = fakeSink();
      const { queryFn, release } = gatedQuery(assistant, success);
      const driver = createClaudeDriver({
        queryFn: queryFn as never,
        prompt: "p",
        options: {} as never,
        sessionKind: "fresh",
      });

      const done = driver(sink);
      // Let the driver read+emit the first (assistant) message and block on the gate.
      await Bun.sleep(0);
      expect(emitted.map((e) => e.kind)).toEqual(["reasoning", "tool"]);

      setTerminal(); // cancel wins the race while the stream is gated
      release(); // let the generator continue -- its `success` message must be dropped

      await done;
      expect(emitted.map((e) => e.kind)).toEqual(["reasoning", "tool"]);
      expect(completions).toEqual([]);
    },
    GUARD_MS,
  );

  // --- resume-rejection classification (design-agent-feedback-loop repair, Task 9) ------------
  //
  // These pin the classifier's WIRING through the real driver, not just the classifier function
  // in isolation (`classify-backend-error.test.ts` covers the conjunction itself) — confirming
  // the driver reads `msg`'s structural fields directly off the `result` message it already has
  // in scope, with no retention across the generator's later throw. See `drive-stream.ts`'s own
  // comment at the classification call site for why no such retention is needed.

  /** Shaped exactly like spike 12's measured observations A/D (`SPIKE.md`). */
  function rejectedResumeResult(overrides: Record<string, unknown> = {}) {
    return {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 0,
      duration_api_ms: 0,
      total_cost_usd: 0,
      modelUsage: {},
      usage: {},
      permission_denials: [],
      errors: ["No conversation found with session ID: b40c398a-…"],
      session_id: "s1",
      uuid: "u1",
      ...overrides,
    };
  }

  test("a resume run whose result message matches spike 12's rejected-resume shape classifies as resume-rejected", async () => {
    const { sink, completions } = fakeSink();
    const driver = createClaudeDriver({
      queryFn: scriptedQuery([rejectedResumeResult()]) as never,
      prompt: "p",
      options: {} as never,
      sessionKind: "resume",
    });
    await driver(sink);
    expect(completions[0]?.outcome).toMatchObject({ kind: "backend-error", cause: "resume-rejected" });
  });

  test("the SAME result shape on a fresh-session run never classifies — condition 1 is checked first", async () => {
    const { sink, completions } = fakeSink();
    const driver = createClaudeDriver({
      queryFn: scriptedQuery([rejectedResumeResult()]) as never,
      prompt: "p",
      options: {} as never,
      sessionKind: "fresh",
    });
    await driver(sink);
    expect(completions[0]?.outcome).toMatchObject({ kind: "backend-error", cause: null });
  });

  test("an ordinary (non-rejected-resume) backend error on a resume run still classifies as null", async () => {
    const { sink, completions } = fakeSink();
    const driver = createClaudeDriver({
      queryFn: scriptedQuery([rejectedResumeResult({ errors: ["rate limit exceeded"] })]) as never,
      prompt: "p",
      options: {} as never,
      sessionKind: "resume",
    });
    await driver(sink);
    expect(completions[0]?.outcome).toMatchObject({ kind: "backend-error", cause: null });
  });
});
