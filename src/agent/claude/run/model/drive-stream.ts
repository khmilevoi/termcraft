import type { AgentEvent } from "entities/turn"
import type { RunDriver } from "agent/run"
import { ClaudeSdkError } from "agent/claude/model/errors"
import type { ClaudeDriverParams } from "../types"
import { deriveUsage, normalizeMessage } from "./normalize"

function describeThrown(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function asError(cause: unknown): Error | undefined {
  return cause instanceof Error ? cause : undefined
}

/**
 * The Claude `RunDriver`: read the SDK stream, normalize each message into
 * `AgentEvent`s, and claim a natural outcome on the first `result` message.
 *
 * The engine owns the latch, the queue and the exit-confirmation ladder — this
 * function owns only the vendor vocabulary: `SDKMessage` shapes, `session_id`
 * tracking, and `ClaudeSdkError`.
 */
export function createClaudeDriver(params: ClaudeDriverParams): RunDriver {
  return async (sink) => {
    let lastSessionId: string | null = null

    const failStream = (reason: string, cause?: unknown): void => {
      const sdkError = new ClaudeSdkError({ code: "STREAM_FAILED", reason, cause: asError(cause) })
      const events: AgentEvent[] = [{ kind: "error", message: sdkError.message }]
      sink.complete({ kind: "backend-error", message: sdkError.message, sessionId: lastSessionId }, events)
    }

    try {
      const query = params.queryFn({ prompt: params.prompt, options: params.options })
      for await (const msg of query) {
        if (sink.isTerminal()) return // cancel already won the race

        if ("session_id" in msg && typeof msg.session_id === "string") lastSessionId = msg.session_id

        if (msg.type !== "result") {
          for (const event of normalizeMessage(msg)) sink.emit(event)
          continue
        }

        const events = normalizeMessage(msg)
        if (msg.subtype === "success") {
          sink.complete(
            { kind: "completed", finalText: msg.result, usage: deriveUsage(msg), sessionId: msg.session_id },
            events,
          )
          return
        }
        const errorEvent = events[0]
        const message = errorEvent?.kind === "error" ? errorEvent.message : `unexpected result ${msg.subtype}`
        sink.complete({ kind: "backend-error", message, sessionId: msg.session_id }, events)
        return
      }

      // The generator ended cleanly without ever yielding a `result` message.
      failStream("stream ended without a result message")
    } catch (cause) {
      // Boundary: `query` is an injected/vendor async generator we do not
      // control — a raw try/catch here (not `errore.try`, which is for sync
      // boundaries) is the errore-sanctioned way to convert an external throw
      // into a value at the lowest call-stack level.
      failStream(describeThrown(cause), cause)
    }
  }
}
