import { describe, expect, test } from "bun:test";

import {
  HOST_CONTROL_QUEUE_CAPACITY,
  HOST_CONTROL_QUEUE_LOW_WATER_MARK,
  type PreviewBackpressureTransitionV1,
  createPreviewBackpressure,
} from "./backpressure";

/**
 * `PreviewBackpressure` (host-supervision-protocol §8): "Supervisor->host ordered control
 * queue | 256 envelopes ... Reject the new non-coalescible Kernel command with
 * `HOST_BACKPRESSURED` ... When the ordered outbound queue reaches 256, the Kernel emits a
 * typed `preview.backpressured` event ... Once the queue drains below the low-water mark
 * of 128, the Kernel emits `preview.writable`."
 *
 * Two DISTINCT concerns, deliberately decoupled: `reserve()`'s accept/refuse decision is a
 * hard cap at exactly 256 (`HOST_BACKPRESSURED`'s own §11.1 meaning: "cannot accept
 * another non-coalescible command" — a literal capacity check), while the
 * `backpressured`/`writable` events are a hysteresis pair (raise at 256, clear only below
 * 128) that exists purely to stop the UI's pause hint from flickering — the two must not be
 * conflated into one flag gating both.
 */

function collect(backpressure: ReturnType<typeof createPreviewBackpressure>): {
  readonly events: PreviewBackpressureTransitionV1[];
  readonly unsubscribe: () => void;
} {
  const events: PreviewBackpressureTransitionV1[] = [];
  const unsubscribe = backpressure.onTransition((event) => events.push(event));
  return { events, unsubscribe };
}

describe("createPreviewBackpressure", () => {
  test("starts empty and writable", () => {
    const backpressure = createPreviewBackpressure();
    expect(backpressure.queueSize()).toBe(0);
  });

  test("reserve() increments the queue size and succeeds below capacity", () => {
    const backpressure = createPreviewBackpressure();
    expect(backpressure.reserve()).toBeUndefined();
    expect(backpressure.queueSize()).toBe(1);
  });

  test("filling exactly to capacity fires exactly one backpressured event at the 256th reservation", () => {
    const backpressure = createPreviewBackpressure();
    const { events } = collect(backpressure);

    for (let i = 0; i < HOST_CONTROL_QUEUE_CAPACITY - 1; i += 1) {
      expect(backpressure.reserve()).toBeUndefined();
    }
    expect(events).toEqual([]); // not yet at capacity

    expect(backpressure.reserve()).toBeUndefined(); // the 256th reservation
    expect(backpressure.queueSize()).toBe(HOST_CONTROL_QUEUE_CAPACITY);
    expect(events).toEqual([{ kind: "backpressured", queueSize: HOST_CONTROL_QUEUE_CAPACITY }]);
  });

  test("reserve() at capacity refuses with HOST_BACKPRESSURED without changing queue size or re-firing the event", () => {
    const backpressure = createPreviewBackpressure();
    const { events } = collect(backpressure);
    for (let i = 0; i < HOST_CONTROL_QUEUE_CAPACITY; i += 1) backpressure.reserve();

    const refusal = backpressure.reserve();

    expect(refusal).toBe("HOST_BACKPRESSURED");
    expect(backpressure.queueSize()).toBe(HOST_CONTROL_QUEUE_CAPACITY);
    expect(events).toEqual([{ kind: "backpressured", queueSize: HOST_CONTROL_QUEUE_CAPACITY }]);
  });

  test("draining down to the low-water mark (128) does not yet fire writable", () => {
    const backpressure = createPreviewBackpressure();
    for (let i = 0; i < HOST_CONTROL_QUEUE_CAPACITY; i += 1) backpressure.reserve();
    const { events } = collect(backpressure);

    const releasesToLowWaterMark = HOST_CONTROL_QUEUE_CAPACITY - HOST_CONTROL_QUEUE_LOW_WATER_MARK;
    for (let i = 0; i < releasesToLowWaterMark; i += 1) backpressure.release();

    expect(backpressure.queueSize()).toBe(HOST_CONTROL_QUEUE_LOW_WATER_MARK);
    expect(events).toEqual([]);
  });

  test("draining one below the low-water mark fires exactly one writable event", () => {
    const backpressure = createPreviewBackpressure();
    for (let i = 0; i < HOST_CONTROL_QUEUE_CAPACITY; i += 1) backpressure.reserve();
    const { events } = collect(backpressure);

    const releasesBelowLowWaterMark =
      HOST_CONTROL_QUEUE_CAPACITY - HOST_CONTROL_QUEUE_LOW_WATER_MARK + 1;
    for (let i = 0; i < releasesBelowLowWaterMark; i += 1) backpressure.release();

    expect(backpressure.queueSize()).toBe(HOST_CONTROL_QUEUE_LOW_WATER_MARK - 1);
    expect(events).toEqual([
      { kind: "writable", queueSize: HOST_CONTROL_QUEUE_LOW_WATER_MARK - 1 },
    ]);
  });

  test("further releases below the low-water mark do not re-fire writable", () => {
    const backpressure = createPreviewBackpressure();
    for (let i = 0; i < HOST_CONTROL_QUEUE_CAPACITY; i += 1) backpressure.reserve();
    const releasesBelowLowWaterMark =
      HOST_CONTROL_QUEUE_CAPACITY - HOST_CONTROL_QUEUE_LOW_WATER_MARK + 1;
    for (let i = 0; i < releasesBelowLowWaterMark; i += 1) backpressure.release();
    const { events } = collect(backpressure);

    backpressure.release();
    backpressure.release();

    expect(events).toEqual([]);
  });

  test("HOST_BACKPRESSURED's hard cap is independent of the writable hysteresis: a partial drain (still >= 128) still accepts new reservations", () => {
    const backpressure = createPreviewBackpressure();
    for (let i = 0; i < HOST_CONTROL_QUEUE_CAPACITY; i += 1) backpressure.reserve();
    // Drain from 256 down to 200 — still above the 128 low-water mark, so the advisory
    // "writable" event has NOT fired, yet the hard cap is no longer at capacity.
    for (let i = 0; i < HOST_CONTROL_QUEUE_CAPACITY - 200; i += 1) backpressure.release();
    expect(backpressure.queueSize()).toBe(200);

    expect(backpressure.reserve()).toBeUndefined();
    expect(backpressure.queueSize()).toBe(201);
  });

  test("release() on an empty queue is a safe no-op: size never goes negative", () => {
    const backpressure = createPreviewBackpressure();
    backpressure.release();
    expect(backpressure.queueSize()).toBe(0);
  });

  test("onTransition's unsubscribe stops further delivery to that listener", () => {
    const backpressure = createPreviewBackpressure();
    const { events, unsubscribe } = collect(backpressure);
    for (let i = 0; i < HOST_CONTROL_QUEUE_CAPACITY - 1; i += 1) backpressure.reserve();

    unsubscribe();
    backpressure.reserve(); // would be the 256th reservation, and would fire backpressured

    expect(events).toEqual([]);
  });
});
