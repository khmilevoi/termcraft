import { ClaudeSdkError } from "agent/claude/errors";
import type { RunDriver } from "agent/run";
import type { AgentEvent } from "entities/turn";
import { trace } from "infrastructure/debug-log";

import type { ClaudeDriverParams } from "../types";
import { deriveUsage, normalizeMessage } from "./normalize";

function describeThrown(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function asError(cause: unknown): Error | undefined {
  return cause instanceof Error ? cause : undefined;
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
    let lastSessionId: string | null = null;

    const failStream = (reason: string, cause?: unknown): void => {
      const sdkError = new ClaudeSdkError({ code: "STREAM_FAILED", reason, cause: asError(cause) });
      // DIAGNOSTIC (infrastructure/debug-log): every stream-level failure funnels through here (a
      // thrown vendor generator, or the generator ending without a result message) -- the one place
      // that failure reaches, so the one place that needs to record it.
      trace("agent.claude.driver.streamFailed", {
        reason,
        sessionId: lastSessionId,
        error: { name: sdkError.name, message: sdkError.message },
      });
      const events: AgentEvent[] = [{ kind: "error", message: sdkError.message }];
      sink.complete(
        { kind: "backend-error", message: sdkError.message, sessionId: lastSessionId },
        events,
      );
    };

    try {
      const query = params.queryFn({ prompt: params.prompt, options: params.options });
      // DIAGNOSTIC (infrastructure/debug-log): the exact prompt string and model/effort handed to the
      // SDK for this attempt -- the send-time record this whole instrumentation task exists to add.
      trace("agent.claude.driver.start", {
        promptLength: params.prompt.length,
        prompt: params.prompt,
        model: params.options.model,
        effort: params.options.effort,
      });
      for await (const msg of query) {
        if (sink.isTerminal()) return; // cancel already won the race

        if ("session_id" in msg && typeof msg.session_id === "string")
          lastSessionId = msg.session_id;

        const events = normalizeMessage(msg);
        // DIAGNOSTIC (infrastructure/debug-log): every message the SDK stream yields, normalized into
        // the same AgentEvent shape the UI renders -- the only per-message record of what the agent
        // actually said or did during generation (reasoning text, tool calls, tool failures).
        trace("agent.claude.driver.message", {
          type: msg.type,
          subtype: "subtype" in msg ? msg.subtype : undefined,
          sessionId: lastSessionId,
          events,
        });

        if (msg.type !== "result") {
          for (const event of events) sink.emit(event);
          continue;
        }

        if (msg.subtype === "success") {
          // DIAGNOSTIC (infrastructure/debug-log): the attempt's final answer and token usage -- the
          // "response" half of the prompt/response pair this instrumentation exists to record.
          const usage = deriveUsage(msg);
          trace("agent.claude.driver.completed", {
            sessionId: msg.session_id,
            finalText: msg.result,
            usage,
          });
          sink.complete(
            {
              kind: "completed",
              finalText: msg.result,
              usage: deriveUsage(msg),
              sessionId: msg.session_id,
            },
            events,
          );
          return;
        }
        const errorEvent = events[0];
        const message =
          errorEvent?.kind === "error" ? errorEvent.message : `unexpected result ${msg.subtype}`;
        // DIAGNOSTIC (infrastructure/debug-log): a non-success result subtype from the SDK -- the agent
        // ran but ended in an error state (e.g. max-turns, refusal) rather than a stream crash.
        trace("agent.claude.driver.failed", {
          sessionId: msg.session_id,
          subtype: msg.subtype,
          message,
        });
        sink.complete({ kind: "backend-error", message, sessionId: msg.session_id }, events);
        return;
      }

      // The generator ended cleanly without ever yielding a `result` message.
      failStream("stream ended without a result message");
    } catch (cause) {
      // Boundary: `query` is an injected/vendor async generator we do not
      // control — a raw try/catch here (not `errore.try`, which is for sync
      // boundaries) is the errore-sanctioned way to convert an external throw
      // into a value at the lowest call-stack level.
      failStream(describeThrown(cause), cause);
    }
  };
}
