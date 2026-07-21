import { describe, expect, test } from "bun:test";

import type { Clock } from "../types";
import { systemClock } from "./system-clock";

describe("systemClock", () => {
  test("returns the current time as a Date", () => {
    const before = Date.now();
    const observed = systemClock.now().getTime();
    const after = Date.now();
    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });

  test("a fake Clock is substitutable", () => {
    const fixed = new Date("2026-07-17T12:00:00.000Z");
    const fake: Clock = { now: () => fixed };
    expect(fake.now().toISOString()).toBe("2026-07-17T12:00:00.000Z");
  });
});
