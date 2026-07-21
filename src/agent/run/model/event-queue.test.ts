import { describe, expect, spyOn, test } from "bun:test";

import type { TurnFence } from "entities/turn";

import { createEventQueue } from "./event-queue";

const fence: TurnFence = { turnId: "t1", attempt: 0, leaseNonce: "n0" };

describe("createEventQueue", () => {
  test("buffers pushed events until a reader arrives, then delivers them in order", async () => {
    const queue = createEventQueue(fence);
    queue.push({ kind: "reasoning", text: "a" });
    queue.push({ kind: "reasoning", text: "b" });
    queue.finish();

    const seen = [];
    for await (const item of queue.iterable) seen.push(item);
    expect(seen).toEqual([
      { fence, event: { kind: "reasoning", text: "a" } },
      { fence, event: { kind: "reasoning", text: "b" } },
    ]);
  });

  test("a reader waiting on next() resolves as soon as a push arrives", async () => {
    const queue = createEventQueue(fence);
    const iterator = queue.iterable[Symbol.asyncIterator]();
    const pending = iterator.next();
    queue.push({ kind: "final", text: "done" });
    const result = await pending;
    expect(result.done).toBe(false);
    expect(result.value).toEqual({ fence, event: { kind: "final", text: "done" } });
  });

  test("finish() ends iteration for a reader waiting on an empty queue", async () => {
    const queue = createEventQueue(fence);
    const iterator = queue.iterable[Symbol.asyncIterator]();
    const pending = iterator.next();
    queue.finish();
    const result = await pending;
    expect(result.done).toBe(true);
  });

  test("finish() ends iteration only after already-buffered events are drained", async () => {
    const queue = createEventQueue(fence);
    queue.push({ kind: "reasoning", text: "a" });
    queue.finish();

    const iterator = queue.iterable[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ fence, event: { kind: "reasoning", text: "a" } });

    const second = await iterator.next();
    expect(second.done).toBe(true);
  });

  // --- iterator.return()/abandon ----------------------------------------

  test("returning the iterator (a for-await break) is supported, and further pushes after it are dropped and logged", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const queue = createEventQueue(fence);
      queue.push({ kind: "reasoning", text: "a" });
      const iterator = queue.iterable[Symbol.asyncIterator]();

      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(typeof iterator.return).toBe("function");

      await iterator.return?.();

      // A push after abandonment must not throw or hang -- it is silently
      // dropped (and logged once).
      queue.push({ kind: "reasoning", text: "b (dropped)" });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // --- second-iterator rejection ------------------------------------------

  test("a second concurrent iteration fails loudly instead of silently deadlocking the first", async () => {
    const queue = createEventQueue(fence);
    queue.push({ kind: "reasoning", text: "a" }); // so the first reader's next() can resolve
    const first = queue.iterable[Symbol.asyncIterator]();
    await first.next(); // claim the sole reader slot without finishing iteration

    const second = queue.iterable[Symbol.asyncIterator]();
    await expect(second.next()).rejects.toThrow();
  });
});
