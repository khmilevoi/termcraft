import type { AgentRun, AgentRunOutcome, FencedEvent } from "agent/types"
import type { TurnFence } from "entities/turn"

/** An `AsyncIterable` that yields `event` exactly once, then completes. */
function singleEventIterable(event: FencedEvent): AsyncIterable<FencedEvent> {
  return {
    [Symbol.asyncIterator]() {
      let delivered = false
      return {
        next: async (): Promise<IteratorResult<FencedEvent>> => {
          if (delivered) return { value: undefined, done: true }
          delivered = true
          return { value: event, done: false }
        },
      }
    },
  }
}

/**
 * A run degraded before it ever started — typically because `startTurn` could
 * not obtain an owned process tree (§6.5). Without a tree there is nothing for
 * the exit-confirmation ladder to poll and nothing for confinement to stand
 * behind, so failing the attempt outright is safer than running it unconfined.
 * Reported in the shape a real attempt uses on failure: one `error` event on
 * the fence, then a matching `backend-error` outcome.
 */
export function createDegradedRun(fence: TurnFence, message: string): AgentRun {
  const outcome: AgentRunOutcome = { kind: "backend-error", message, sessionId: null }
  return {
    fence,
    events: singleEventIterable({ fence, event: { kind: "error", message } }),
    outcome: Promise.resolve(outcome),
  }
}
