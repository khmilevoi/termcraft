import type { SDKMessage, SDKResultError, SDKResultMessage, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk"
import type { AgentEvent, TokenUsage } from "entities/turn"
import { mapToolUse } from "agent/claude/model/tool-op"

/**
 * Compute the 0–100 context-window share, or null when no model reported a
 * usable window (master §6.1). Accepts either result subtype: the installed
 * SDK gives `SDKResultError` the same non-optional `usage`/`modelUsage`
 * fields as `SDKResultSuccess`, so a turn that errors out still reports how
 * much context it burned (§6.1, §3.9's context indicator). The SDK types both
 * fields as non-optional, but this normalizer is fed by a vendor stream — a
 * message that omits them is treated as "unreported" rather than allowed to
 * throw.
 */
export function deriveUsage(result: SDKResultMessage): TokenUsage | null {
  const usage = result.usage as { input_tokens?: number; output_tokens?: number } | undefined
  if (usage === undefined) return null

  const inputTokens = usage.input_tokens ?? 0
  const outputTokens = usage.output_tokens ?? 0
  const contextPercent = (() => {
    const models = Object.values(result.modelUsage ?? {})
    const window = models[0]?.contextWindow
    if (typeof window !== "number" || window <= 0) return null
    return Math.round(((inputTokens + outputTokens) / window) * 100)
  })()

  return { inputTokens, outputTokens, contextPercent }
}

/**
 * The vendor's assistant content-block union, derived from `SDKMessage` rather
 * than imported: the SDK re-exports the Beta message types structurally but not
 * `BetaContentBlock` by name.
 */
type ContentBlock = Extract<SDKMessage, { type: "assistant" }>["message"]["content"][number]

/**
 * Map one assistant content block to an event, or null when the block carries
 * nothing renderable. The `typeof` guards look redundant against the vendor
 * types, but this data crosses a process boundary untyped at runtime — a
 * malformed block must be skipped, not emitted as `undefined` text.
 */
function normalizeBlock(block: ContentBlock): AgentEvent | null {
  if (block.type === "thinking" && typeof block.thinking === "string") {
    return { kind: "reasoning", text: block.thinking }
  }
  if (block.type === "text" && typeof block.text === "string") {
    return { kind: "reasoning", text: block.text }
  }
  if (block.type === "tool_use" && typeof block.name === "string") {
    const { op, target } = mapToolUse(block.name, (block.input ?? {}) as Record<string, unknown>)
    return { kind: "tool", op, target }
  }
  return null
}

/** A success result yields the final text plus, when derivable, a usage event. */
function normalizeSuccess(result: SDKResultSuccess): AgentEvent[] {
  const usage = deriveUsage(result)
  const events: AgentEvent[] = [{ kind: "final", text: result.result }]
  if (usage !== null) events.push({ kind: "usage", tokens: usage })
  return events
}

/**
 * An error result yields the error event first, then — when derivable — a
 * usage event (master §6.1). This is the failure mode where the context
 * indicator matters most: an attempt that ends `error_max_turns` after
 * burning most of the context window must still report usage, not just drop
 * it because the turn didn't succeed. Error stays first so the event-order
 * contract downstream (kernel/UI) does not shift by result subtype.
 */
function normalizeError(result: SDKResultError): AgentEvent[] {
  const errors = result.errors ?? []
  const usage = deriveUsage(result)
  const events: AgentEvent[] = [{ kind: "error", message: errors[0] ?? `result ${result.subtype}` }]
  if (usage !== null) events.push({ kind: "usage", tokens: usage })
  return events
}

/**
 * Normalize one vendor `SDKMessage` into zero or more `AgentEvent`s (master
 * §6.1). Thinking blocks and interim assistant text become `reasoning`;
 * `tool_use` becomes `tool`; a success result becomes `final` + `usage`; an
 * error result becomes `error` + `usage` (when derivable). Any message with no
 * mapping yields `[]` — the SDK's message union is large and grows between
 * versions, so being forward-compatible by default is deliberate, not an
 * oversight (entities/turn: "vendor events with no mapping are dropped
 * silently").
 */
export function normalizeMessage(msg: SDKMessage): AgentEvent[] {
  if (msg.type === "assistant") {
    const blocks = msg.message?.content ?? []
    const events: AgentEvent[] = []
    for (const block of blocks) {
      const event = normalizeBlock(block)
      if (event !== null) events.push(event)
    }
    return events
  }

  if (msg.type === "result") {
    if (msg.subtype === "success") return normalizeSuccess(msg)
    return normalizeError(msg)
  }

  return []
}
