import { describe, expect, test } from "bun:test";

import { createManualClock, createSystemClock } from "./clock";

describe("ManualClock", () => {
  test("a due timer fires exactly once at its deadline", () => {
    const clock = createManualClock();
    let fired = 0;
    let firedAt = -1;
    clock.setTimer(3_000, () => {
      fired += 1;
      firedAt = clock.now();
    });
    clock.advance(2_999);
    expect(fired).toBe(0);
    clock.advance(1);
    expect(fired).toBe(1);
    expect(firedAt).toBe(3_000);
    clock.advance(10_000);
    expect(fired).toBe(1);
  });

  test("cancel before the deadline prevents the fire", () => {
    const clock = createManualClock();
    let fired = 0;
    const handle = clock.setTimer(2_000, () => (fired += 1));
    clock.advance(1_000);
    handle.cancel();
    clock.advance(5_000);
    expect(fired).toBe(0);
    expect(clock.pending()).toBe(0);
  });

  test("timers scheduled during advance fire in due order", () => {
    const clock = createManualClock();
    const order: number[] = [];
    clock.setTimer(250, () => {
      order.push(clock.now());
      clock.setTimer(500, () => {
        order.push(clock.now());
        clock.setTimer(1_000, () => order.push(clock.now()));
      });
    });
    clock.advance(2_000);
    expect(order).toEqual([250, 750, 1_750]);
    expect(clock.pending()).toBe(0);
  });
});

describe("createSystemClock", () => {
  test("now() is monotonic non-decreasing", () => {
    const clock = createSystemClock();
    const a = clock.now();
    const b = clock.now();
    expect(b).toBeGreaterThanOrEqual(a);
  });

  test("setTimer fires and cancel prevents it (real timers)", async () => {
    const clock = createSystemClock();
    let fired = 0;
    clock.setTimer(1, () => (fired += 1));
    const cancelled = clock.setTimer(1, () => (fired += 1));
    cancelled.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toBe(1);
  });
});
