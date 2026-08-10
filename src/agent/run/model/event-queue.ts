import type { FencedEvent } from "agent/types";
import type { AgentEvent, TurnFence } from "entities/turn";
import { log } from "infrastructure/debug-log";

/** A minimal single-reader async queue bridging a run's driver to `AgentRun.events`. */
export interface EventQueue {
  push(event: AgentEvent): void;
  finish(): void;
  readonly iterable: AsyncIterable<FencedEvent>;
}

/**
 * Push/finish never depend on a reader — a run's driver calls them
 * unconditionally, so `outcome` settles even when nobody ever iterates
 * `events` (turn-durability §6.4).
 *
 * Two invariants hold:
 *  - `[Symbol.asyncIterator]()` hands out the ONE real reader (matching this
 *    function's "single-reader" contract above); a second, concurrent call
 *    would otherwise share the same `waitingReader` slot, clobber the first
 *    reader's pending `next()`, and deadlock it forever with no signal. A
 *    second iterator instead fails loudly on its first `next()`.
 *  - The real reader's iterator implements `return()`, so a consumer that
 *    `break`s out of `for await (const e of run.events)` (the JS spec calls
 *    `return()` on abrupt loop completion) tells the producer nobody is
 *    listening anymore. From then on `push` drops events instead of
 *    retaining them in `buffered` for the rest of the turn — durability only
 *    requires that `push` never BLOCK (see the comment above), not that it
 *    retain output forever once the one reader is provably gone.
 */
export function createEventQueue(fence: TurnFence): EventQueue {
  const buffered: FencedEvent[] = [];
  let waitingReader: ((result: IteratorResult<FencedEvent>) => void) | null = null;
  let done = false;
  let abandoned = false;
  let abandonedDropLogged = false;
  let readerTaken = false;

  function push(event: AgentEvent): void {
    if (abandoned) {
      if (!abandonedDropLogged) {
        abandonedDropLogged = true;
        log.warn("agent/run: events consumer is gone (break/return); dropping further events");
      }
      return;
    }
    const item: FencedEvent = { fence, event };
    if (waitingReader !== null) {
      const resolve = waitingReader;
      waitingReader = null;
      resolve({ value: item, done: false });
      return;
    }
    buffered.push(item);
  }

  function finish(): void {
    done = true;
    if (waitingReader !== null) {
      const resolve = waitingReader;
      waitingReader = null;
      resolve({ value: undefined, done: true });
    }
  }

  function next(): Promise<IteratorResult<FencedEvent>> {
    const buffered0 = buffered.shift();
    if (buffered0 !== undefined) return Promise.resolve({ value: buffered0, done: false });
    if (done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      waitingReader = resolve;
    });
  }

  function returnReader(): Promise<IteratorResult<FencedEvent>> {
    abandoned = true;
    buffered.length = 0; // nothing will ever read this again — release it now
    waitingReader = null;
    return Promise.resolve({ value: undefined, done: true });
  }

  return {
    push,
    finish,
    iterable: {
      [Symbol.asyncIterator]() {
        if (readerTaken) {
          // A second concurrent reader fails loudly instead of sharing
          // `waitingReader` with the first and deadlocking it.
          return {
            next: () =>
              Promise.reject(
                new Error("agent/run: AgentRun.events supports only one reader at a time"),
              ),
          };
        }
        readerTaken = true;
        return { next, return: returnReader };
      },
    },
  };
}
