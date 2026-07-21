import { describe, expect, test } from "bun:test";

import type { ControlEnvelope, JsonValue } from "../../protocol";
import {
  COALESCIBLE_KINDS,
  OUTBOUND_LOW_WATER,
  OUTBOUND_QUEUE_CAPACITY,
  createControlQueue,
} from "./control-queue";
import { SupervisorError } from "./errors";

const ID = { sessionId: "s-1", nonce: "a".repeat(32) };
let mid = 0;
function env(kind: string, extra: Record<string, JsonValue> = {}): ControlEnvelope {
  mid += 1;
  return {
    protocolVersion: 1,
    kind,
    sessionId: ID.sessionId,
    nonce: ID.nonce,
    messageId: String(mid),
    body: extra,
  };
}
const discrete = (kind: string, extra?: Record<string, JsonValue>) => ({
  kind,
  envelope: env(kind, extra),
});
const coalescible = (kind: string, extra?: Record<string, JsonValue>) => ({
  kind,
  envelope: env(kind, extra),
});

describe("createControlQueue — capacity + HOST_BACKPRESSURED (§8)", () => {
  test("discrete commands keep FIFO order on drain", () => {
    const queue = createControlQueue();
    queue.enqueue(discrete("ping", { n: 1 }));
    queue.enqueue(discrete("ping", { n: 2 }));
    queue.enqueue(discrete("ping", { n: 3 }));
    expect(queue.size()).toBe(3);
    expect(queue.dequeue()?.envelope.body.n).toBe(1);
    expect(queue.dequeue()?.envelope.body.n).toBe(2);
    expect(queue.dequeue()?.envelope.body.n).toBe(3);
    expect(queue.dequeue()).toBeNull();
  });

  test("filling to 256 then one more discrete command is rejected with HOST_BACKPRESSURED, nothing dropped/reordered", () => {
    const queue = createControlQueue();
    for (let i = 0; i < OUTBOUND_QUEUE_CAPACITY; i += 1) {
      expect(queue.enqueue(discrete("ping", { n: i }))).toBe("accepted");
    }
    expect(queue.size()).toBe(OUTBOUND_QUEUE_CAPACITY);
    expect(queue.isBackpressured()).toBe(true);
    const overflow = queue.enqueue(discrete("ping", { n: 999 }));
    expect(overflow).toBeInstanceOf(SupervisorError);
    if (overflow instanceof SupervisorError) expect(overflow.code).toBe("HOST_BACKPRESSURED");
    expect(queue.size()).toBe(OUTBOUND_QUEUE_CAPACITY); // unchanged
    // first accepted entry is still first
    expect(queue.dequeue()?.envelope.body.n).toBe(0);
  });
});

describe("createControlQueue — coalescing within barrier segments (§8/§14.2)", () => {
  test("two same-kind coalescibles with no discrete barrier collapse into one, superseding the older", () => {
    const queue = createControlQueue();
    const first = queue.coalesce(coalescible("resize", { w: 80 }));
    expect(first).not.toBeInstanceOf(SupervisorError);
    if (first instanceof SupervisorError) throw first;
    expect(first.status).toBe("added");
    const second = queue.coalesce(coalescible("resize", { w: 120 }));
    if (second instanceof SupervisorError) throw second;
    expect(second.status).toBe("coalesced");
    expect(second.superseded?.body.w).toBe(80);
    expect(queue.size()).toBe(1); // one entry only
    expect(queue.dequeue()?.envelope.body.w).toBe(120); // newest value survives
  });

  test("a discrete command between two coalescibles is a barrier — they do NOT coalesce", () => {
    const queue = createControlQueue();
    queue.coalesce(coalescible("resize", { w: 80 }));
    queue.enqueue(discrete("ping")); // barrier — ends the segment
    const after = queue.coalesce(coalescible("resize", { w: 120 }));
    if (after instanceof SupervisorError) throw after;
    expect(after.status).toBe("added"); // new segment ⇒ new entry, not a coalesce
    expect(queue.size()).toBe(3);
    expect(queue.dequeue()?.envelope.body.w).toBe(80);
    expect(queue.dequeue()?.kind).toBe("ping");
    expect(queue.dequeue()?.envelope.body.w).toBe(120);
  });

  test("coalescing replaces the pending value even when the queue is full", () => {
    const queue = createControlQueue();
    // fill with a coalescible resize first so a pending resize exists, then discretes to capacity
    queue.coalesce(coalescible("resize", { w: 1 }));
    for (let i = 0; i < OUTBOUND_QUEUE_CAPACITY - 1; i += 1) queue.enqueue(discrete("ping"));
    expect(queue.size()).toBe(OUTBOUND_QUEUE_CAPACITY);
    // resize's pending slot was cleared by the discrete barrier, so a new coalesce cannot add — full
    const blocked = queue.coalesce(coalescible("resize", { w: 2 }));
    expect(blocked).toBeInstanceOf(SupervisorError);
    if (blocked instanceof SupervisorError) expect(blocked.code).toBe("HOST_BACKPRESSURED");
  });

  test("a same-segment coalesce succeeds even at capacity (replaces, does not add)", () => {
    const queue = createControlQueue();
    for (let i = 0; i < OUTBOUND_QUEUE_CAPACITY - 1; i += 1) queue.enqueue(discrete("ping"));
    // one coalescible as the LAST entry, reaching capacity, still in the tail segment
    queue.coalesce(coalescible("hover", { x: 1 }));
    expect(queue.size()).toBe(OUTBOUND_QUEUE_CAPACITY);
    expect(queue.isBackpressured()).toBe(true);
    const replaced = queue.coalesce(coalescible("hover", { x: 2 }));
    if (replaced instanceof SupervisorError) throw replaced;
    expect(replaced.status).toBe("coalesced");
    expect(replaced.superseded?.body.x).toBe(1);
    expect(queue.size()).toBe(OUTBOUND_QUEUE_CAPACITY); // still full, no new entry
  });

  test("resize/mousemove/hover are the coalescible kinds", () => {
    expect(COALESCIBLE_KINDS.has("resize")).toBe(true);
    expect(COALESCIBLE_KINDS.has("mousemove")).toBe(true);
    expect(COALESCIBLE_KINDS.has("hover")).toBe(true);
    expect(COALESCIBLE_KINDS.has("ping")).toBe(false);
  });
});

describe("createControlQueue — reserved shutdown slot + preview.writable (§8)", () => {
  test("enqueueShutdown is accepted even when the queue is full and is dequeued with priority", () => {
    const queue = createControlQueue();
    for (let i = 0; i < OUTBOUND_QUEUE_CAPACITY; i += 1) queue.enqueue(discrete("ping", { n: i }));
    queue.enqueueShutdown({ kind: "shutdown", envelope: env("shutdown") });
    expect(queue.hasShutdown()).toBe(true);
    expect(queue.dequeue()?.kind).toBe("shutdown"); // priority over the 256 discretes
    expect(queue.hasShutdown()).toBe(false);
    expect(queue.dequeue()?.envelope.body.n).toBe(0); // then FIFO resumes
  });

  test("onWritable fires once when draining crosses from ≥256 down below the 128 low-water mark", () => {
    const queue = createControlQueue();
    let writable = 0;
    queue.onWritable(() => (writable += 1));
    for (let i = 0; i < OUTBOUND_QUEUE_CAPACITY; i += 1) queue.enqueue(discrete("ping"));
    expect(queue.isBackpressured()).toBe(true);
    // drain down to exactly the low-water mark — not yet below
    while (queue.size() > OUTBOUND_LOW_WATER) queue.dequeue();
    expect(writable).toBe(0);
    queue.dequeue(); // now below 128
    expect(writable).toBe(1);
    expect(queue.isBackpressured()).toBe(false);
    // draining further does not re-fire
    while (queue.size() > 0) queue.dequeue();
    expect(writable).toBe(1);
  });

  test("onWritable does NOT fire on a drain that never reached capacity", () => {
    const queue = createControlQueue();
    let writable = 0;
    queue.onWritable(() => (writable += 1));
    for (let i = 0; i < OUTBOUND_LOW_WATER + 10; i += 1) queue.enqueue(discrete("ping"));
    while (queue.size() > 0) queue.dequeue();
    expect(writable).toBe(0); // never backpressured ⇒ no writable edge
  });
});
