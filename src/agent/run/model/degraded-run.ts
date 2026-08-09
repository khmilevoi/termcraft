import type { AgentRun, AgentRunOutcome, FencedEvent } from "agent/types";
import type { TurnFence } from "entities/turn";

/**
 * An `AsyncIterable` that yields `event` exactly once, then completes.
 * Matches `createEventQueue`'s single-reader contract
 * (`run/model/event-queue.ts`) so both `AgentRun` producers in the shared
 * tier behave the same way to a consumer that has no way to know which one
 * it got: only one reader is ever handed out — a second, concurrent
 * `[Symbol.asyncIterator]()` call fails loudly instead of silently handing
 * out an independent replay of the event — and `return()` is implemented so
 * a `for await...break` completes the iterator protocol cleanly.
 */
function singleEventIterable(event: FencedEvent): AsyncIterable<FencedEvent> {
  let readerTaken = false;
  return {
    [Symbol.asyncIterator]() {
      if (readerTaken) {
        // A second concurrent reader fails loudly instead of silently
        // replaying `event` — matching `createEventQueue`'s contract.
        return {
          next: () =>
            Promise.reject(
              new Error("agent/run: AgentRun.events supports only one reader at a time"),
            ),
        };
      }
      readerTaken = true;
      let delivered = false;
      return {
        next: async (): Promise<IteratorResult<FencedEvent>> => {
          if (delivered) return { value: undefined, done: true };
          delivered = true;
          return { value: event, done: false };
        },
        return: async (): Promise<IteratorResult<FencedEvent>> => {
          delivered = true;
          return { value: undefined, done: true };
        },
      };
    },
  };
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
  // Never classified: the run degraded before it ever reached the vendor stream, so there is
  // no vendor-specific error shape for a classifier to have read.
  const outcome: AgentRunOutcome = { kind: "backend-error", message, sessionId: null, cause: null };
  return {
    fence,
    events: singleEventIterable({ fence, event: { kind: "error", message } }),
    outcome: Promise.resolve(outcome),
  };
}
