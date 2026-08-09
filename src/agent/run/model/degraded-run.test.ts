import { expect, test } from "bun:test";

import type { FencedEvent } from "agent/types";

import { createDegradedRun } from "./degraded-run";

const fence = { turnId: "t", attempt: 0, leaseNonce: "n" };

test("createDegradedRun reports a single error event and a matching backend-error outcome", async () => {
  const run = createDegradedRun(fence, "Process-tree failure: no Job Object support");
  const events: FencedEvent[] = [];
  for await (const ev of run.events) events.push(ev);
  expect(events).toEqual([
    { fence, event: { kind: "error", message: "Process-tree failure: no Job Object support" } },
  ]);
  expect(await run.outcome).toEqual({
    kind: "backend-error",
    message: "Process-tree failure: no Job Object support",
    sessionId: null,
    cause: null,
  });
}, 2000);

test("the degraded run's fence matches the fence it was created with", () => {
  const run = createDegradedRun(fence, "boom");
  expect(run.fence).toBe(fence);
});

// --- events matches createEventQueue's single-reader contract (Fix 4) -------

test("a second concurrent iterator fails loudly instead of silently replaying the event", () => {
  const run = createDegradedRun(fence, "boom");
  const first = run.events[Symbol.asyncIterator]();
  const second = run.events[Symbol.asyncIterator]();
  expect(first).not.toBe(second);
  expect(second.next()).rejects.toThrow(
    "agent/run: AgentRun.events supports only one reader at a time",
  );
});

test("return() completes the iterator protocol cleanly, matching a for-await break", async () => {
  const run = createDegradedRun(fence, "boom");
  const iterator = run.events[Symbol.asyncIterator]();
  expect(typeof iterator.return).toBe("function");
  const result = await iterator.return?.();
  expect(result).toEqual({ value: undefined, done: true });
  // A subsequent next() also reports done -- return() is terminal.
  expect(await iterator.next()).toEqual({ value: undefined, done: true });
});
