import { expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { deriveUsage, normalizeMessage } from "./normalize"

function assistant(content: unknown[]): SDKMessage {
  return {
    type: "assistant",
    session_id: "s1",
    uuid: "u1",
    parent_tool_use_id: null,
    message: { content },
  } as unknown as SDKMessage
}

function success(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    result: "Updated the CPU gauge.",
    session_id: "s1",
    uuid: "u2",
    usage: { input_tokens: 1200, output_tokens: 340 },
    modelUsage: { "claude-opus-4-8": { inputTokens: 1200, outputTokens: 340, contextWindow: 200000 } },
    total_cost_usd: 0.02,
    permission_denials: [],
    ...overrides,
  } as unknown as SDKMessage
}

test("an assistant message with thinking, text, and tool_use yields reasoning, reasoning, tool", () => {
  const msg = assistant([
    { type: "thinking", thinking: "I will edit the gauge", signature: "sig" },
    { type: "text", text: "Editing now" },
    { type: "tool_use", id: "t1", name: "Write", input: { file_path: "pages/main.tsx", content: "x" } },
  ])
  expect(normalizeMessage(msg)).toEqual([
    { kind: "reasoning", text: "I will edit the gauge" },
    { kind: "reasoning", text: "Editing now" },
    { kind: "tool", op: "edit", target: "pages/main.tsx" },
  ])
})

test("a success result yields final then usage", () => {
  expect(normalizeMessage(success())).toEqual([
    { kind: "final", text: "Updated the CPU gauge." },
    { kind: "usage", tokens: { inputTokens: 1200, outputTokens: 340, contextPercent: 1 } },
  ])
})

test("an error result yields a single error event carrying the first reported error", () => {
  const msg = {
    type: "result",
    subtype: "error_during_execution",
    session_id: "s1",
    uuid: "u3",
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    errors: ["authentication_failed"],
    permission_denials: [],
  } as unknown as SDKMessage
  expect(normalizeMessage(msg)).toEqual([{ kind: "error", message: "authentication_failed" }])
})

test("an unmapped system init message is dropped silently", () => {
  const msg = { type: "system", subtype: "init", session_id: "s1", uuid: "u4" } as unknown as SDKMessage
  expect(normalizeMessage(msg)).toEqual([])
})

test("an assistant message with an empty content array yields no events", () => {
  expect(normalizeMessage(assistant([]))).toEqual([])
})

test("assistant content blocks with no mapping are skipped without dropping their siblings", () => {
  const msg = assistant([
    { type: "image", source: { data: "..." } },
    { type: "text", text: "kept" },
    { type: "tool_result", tool_use_id: "t1", content: "ok" },
  ])
  expect(normalizeMessage(msg)).toEqual([{ kind: "reasoning", text: "kept" }])
})

test("a text block whose text is not a string is skipped rather than emitted as undefined", () => {
  expect(normalizeMessage(assistant([{ type: "text", text: null }]))).toEqual([])
})

test("a success result with no modelUsage still emits usage, with a null contextPercent", () => {
  expect(normalizeMessage(success({ modelUsage: {} }))).toEqual([
    { kind: "final", text: "Updated the CPU gauge." },
    { kind: "usage", tokens: { inputTokens: 1200, outputTokens: 340, contextPercent: null } },
  ])
})

test("a success result with no usage at all emits only final", () => {
  expect(normalizeMessage(success({ usage: undefined }))).toEqual([
    { kind: "final", text: "Updated the CPU gauge." },
  ])
})

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
  } as unknown as SDKMessage
  expect(normalizeMessage(msg)).toEqual([{ kind: "error", message: "result error_max_turns" }])
})

test("a result subtype this adapter does not enumerate is still reported as an error, not a crash", () => {
  const msg = {
    type: "result",
    subtype: "error_some_future_subtype",
    session_id: "s1",
    uuid: "u6",
    permission_denials: [],
  } as unknown as SDKMessage
  expect(normalizeMessage(msg)).toEqual([{ kind: "error", message: "result error_some_future_subtype" }])
})

test("an SDK message type this adapter does not know is dropped, not crashed on", () => {
  const msg = { type: "stream_event", event: { type: "content_block_delta" }, uuid: "u7" } as unknown as SDKMessage
  expect(normalizeMessage(msg)).toEqual([])
})

test("deriveUsage rounds the context share and tolerates a zero-width window", () => {
  const rounded = deriveUsage(
    success({
      usage: { input_tokens: 1, output_tokens: 0 },
      modelUsage: { m: { contextWindow: 3 } },
    }) as never,
  )
  // 1/3 = 33.3% -> 33
  expect(rounded).toEqual({ inputTokens: 1, outputTokens: 0, contextPercent: 33 })

  const zeroWindow = deriveUsage(success({ modelUsage: { m: { contextWindow: 0 } } }) as never)
  expect(zeroWindow?.contextPercent).toBeNull()
})

test("deriveUsage treats missing token counts as zero rather than NaN", () => {
  const usage = deriveUsage(success({ usage: {}, modelUsage: {} }) as never)
  expect(usage).toEqual({ inputTokens: 0, outputTokens: 0, contextPercent: null })
})
