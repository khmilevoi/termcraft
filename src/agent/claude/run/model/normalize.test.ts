import { expect, test } from "bun:test";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { deriveUsage, normalizeMessage } from "./normalize";

function assistant(content: unknown[]): SDKMessage {
  return {
    type: "assistant",
    session_id: "s1",
    uuid: "u1",
    parent_tool_use_id: null,
    message: { content },
  } as unknown as SDKMessage;
}

function success(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    result: "Updated the CPU gauge.",
    session_id: "s1",
    uuid: "u2",
    usage: { input_tokens: 1200, output_tokens: 340 },
    modelUsage: {
      "claude-opus-4-8": { inputTokens: 1200, outputTokens: 340, contextWindow: 200000 },
    },
    total_cost_usd: 0.02,
    permission_denials: [],
    ...overrides,
  } as unknown as SDKMessage;
}

test("an assistant message with thinking, text, and tool_use yields reasoning, reasoning, tool", () => {
  const msg = assistant([
    { type: "thinking", thinking: "I will edit the gauge", signature: "sig" },
    { type: "text", text: "Editing now" },
    {
      type: "tool_use",
      id: "t1",
      name: "Write",
      input: { file_path: "pages/main.tsx", content: "x" },
    },
  ]);
  expect(normalizeMessage(msg)).toEqual([
    { kind: "reasoning", text: "I will edit the gauge" },
    { kind: "reasoning", text: "Editing now" },
    { kind: "tool", id: "t1", op: "edit", target: "pages/main.tsx" },
  ]);
});

test("a tool_use block missing its own id is skipped rather than emitted with an undefined id", () => {
  const msg = assistant([{ type: "tool_use", name: "Write", input: {} }]);
  expect(normalizeMessage(msg)).toEqual([]);
});

test("a success result yields final then usage", () => {
  expect(normalizeMessage(success())).toEqual([
    { kind: "final", text: "Updated the CPU gauge." },
    { kind: "usage", tokens: { inputTokens: 1200, outputTokens: 340, contextPercent: 1 } },
  ]);
});

test("an error result yields the error event first, carrying the first reported error, then usage", () => {
  const msg = {
    type: "result",
    subtype: "error_during_execution",
    session_id: "s1",
    uuid: "u3",
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    errors: ["authentication_failed"],
    permission_denials: [],
  } as unknown as SDKMessage;
  const events = normalizeMessage(msg);
  expect(events).toEqual([
    { kind: "error", message: "authentication_failed" },
    { kind: "usage", tokens: { inputTokens: 0, outputTokens: 0, contextPercent: null } },
  ]);
  // Explicit order contract: error must arrive before usage, matching the
  // success branch's final-then-usage ordering.
  expect(events[0]?.kind).toBe("error");
  expect(events[1]?.kind).toBe("usage");
});

function user(content: unknown[] | string): SDKMessage {
  return {
    type: "user",
    session_id: "s1",
    uuid: "u8",
    parent_tool_use_id: null,
    message: { role: "user", content },
  } as unknown as SDKMessage;
}

test("a user message's tool_result block with is_error true yields tool-failed, carrying tool_use_id as id", () => {
  const msg = user([{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }]);
  expect(normalizeMessage(msg)).toEqual([{ kind: "tool-failed", id: "t1" }]);
});

test("a user message's tool_result block with is_error false (an ordinary success) yields nothing — only failures are mirrored", () => {
  const msg = user([{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }]);
  expect(normalizeMessage(msg)).toEqual([]);
});

test("a user message's tool_result block with is_error omitted yields nothing", () => {
  const msg = user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]);
  expect(normalizeMessage(msg)).toEqual([]);
});

test("a user message with multiple tool_result blocks keeps only the failed one, and drops a malformed sibling without dropping it", () => {
  const msg = user([
    { type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false },
    { type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true },
    { type: "tool_result", content: "no id", is_error: true }, // malformed: no tool_use_id
  ]);
  expect(normalizeMessage(msg)).toEqual([{ kind: "tool-failed", id: "t2" }]);
});

test("a user message whose content is a plain string (no blocks) yields no events", () => {
  expect(normalizeMessage(user("just text"))).toEqual([]);
});

test("a user message with an empty content array yields no events", () => {
  expect(normalizeMessage(user([]))).toEqual([]);
});

test("an unmapped system init message is dropped silently", () => {
  const msg = {
    type: "system",
    subtype: "init",
    session_id: "s1",
    uuid: "u4",
  } as unknown as SDKMessage;
  expect(normalizeMessage(msg)).toEqual([]);
});

test("an assistant message with an empty content array yields no events", () => {
  expect(normalizeMessage(assistant([]))).toEqual([]);
});

test("assistant content blocks with no mapping are skipped without dropping their siblings", () => {
  const msg = assistant([
    { type: "image", source: { data: "..." } },
    { type: "text", text: "kept" },
    { type: "tool_result", tool_use_id: "t1", content: "ok" },
  ]);
  expect(normalizeMessage(msg)).toEqual([{ kind: "reasoning", text: "kept" }]);
});

test("a text block whose text is not a string is skipped rather than emitted as undefined", () => {
  expect(normalizeMessage(assistant([{ type: "text", text: null }]))).toEqual([]);
});

test("a success result with no modelUsage still emits usage, with a null contextPercent", () => {
  expect(normalizeMessage(success({ modelUsage: {} }))).toEqual([
    { kind: "final", text: "Updated the CPU gauge." },
    { kind: "usage", tokens: { inputTokens: 1200, outputTokens: 340, contextPercent: null } },
  ]);
});

test("a success result with no usage at all emits only final", () => {
  expect(normalizeMessage(success({ usage: undefined }))).toEqual([
    { kind: "final", text: "Updated the CPU gauge." },
  ]);
});

test("an error result with an empty errors array falls back to naming the subtype", () => {
  const msg = {
    type: "result",
    subtype: "error_max_turns",
    session_id: "s1",
    uuid: "u5",
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    errors: [],
    permission_denials: [],
  } as unknown as SDKMessage;
  expect(normalizeMessage(msg)).toEqual([
    { kind: "error", message: "result error_max_turns" },
    { kind: "usage", tokens: { inputTokens: 0, outputTokens: 0, contextPercent: null } },
  ]);
});

test("an error result that burned most of the context window still reports usage, error first (master §6.1)", () => {
  // An attempt burns 180k of a 200k window and ends error_max_turns. The
  // context indicator must not silently under-report just because the
  // attempt failed.
  const msg = {
    type: "result",
    subtype: "error_max_turns",
    session_id: "s1",
    uuid: "u9",
    usage: { input_tokens: 170000, output_tokens: 10000 },
    modelUsage: {
      "claude-opus-4-8": { inputTokens: 170000, outputTokens: 10000, contextWindow: 200000 },
    },
    errors: [],
    permission_denials: [],
  } as unknown as SDKMessage;
  expect(normalizeMessage(msg)).toEqual([
    { kind: "error", message: "result error_max_turns" },
    { kind: "usage", tokens: { inputTokens: 170000, outputTokens: 10000, contextPercent: 90 } },
  ]);
});

test("a result subtype this adapter does not enumerate is still reported as an error, not a crash", () => {
  const msg = {
    type: "result",
    subtype: "error_some_future_subtype",
    session_id: "s1",
    uuid: "u6",
    permission_denials: [],
  } as unknown as SDKMessage;
  expect(normalizeMessage(msg)).toEqual([
    { kind: "error", message: "result error_some_future_subtype" },
  ]);
});

test("an SDK message type this adapter does not know is dropped, not crashed on", () => {
  const msg = {
    type: "stream_event",
    event: { type: "content_block_delta" },
    uuid: "u7",
  } as unknown as SDKMessage;
  expect(normalizeMessage(msg)).toEqual([]);
});

test("deriveUsage rounds the context share and tolerates a zero-width window", () => {
  const rounded = deriveUsage(
    success({
      usage: { input_tokens: 1, output_tokens: 0 },
      modelUsage: { m: { contextWindow: 3 } },
    }) as never,
  );
  // 1/3 = 33.3% -> 33
  expect(rounded).toEqual({ inputTokens: 1, outputTokens: 0, contextPercent: 33 });

  const zeroWindow = deriveUsage(success({ modelUsage: { m: { contextWindow: 0 } } }) as never);
  expect(zeroWindow?.contextPercent).toBeNull();
});

test("deriveUsage treats missing token counts as zero rather than NaN", () => {
  const usage = deriveUsage(success({ usage: {}, modelUsage: {} }) as never);
  expect(usage).toEqual({ inputTokens: 0, outputTokens: 0, contextPercent: null });
});
