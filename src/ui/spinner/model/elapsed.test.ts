import { describe, expect, test } from "bun:test";

import { formatElapsed } from "./elapsed";

describe("formatElapsed", () => {
  test("renders sub-minute durations as plain seconds", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(18_000)).toBe("18s");
    expect(formatElapsed(59_000)).toBe("59s");
  });

  test("renders sub-hour durations as minutes and zero-padded seconds (the design's own `2m 40s` shape)", () => {
    expect(formatElapsed(60_000)).toBe("1m 00s");
    expect(formatElapsed(160_000)).toBe("2m 40s");
    expect(formatElapsed(3_599_000)).toBe("59m 59s");
  });

  test("renders hour-plus durations as hours and zero-padded minutes", () => {
    expect(formatElapsed(3_600_000)).toBe("1h 00m");
    expect(formatElapsed(3_600_000 + 4 * 60_000)).toBe("1h 04m");
  });

  test("floors partial seconds rather than rounding", () => {
    expect(formatElapsed(1_999)).toBe("1s");
  });

  test("never goes negative — a clock that moved backwards renders 0s", () => {
    expect(formatElapsed(-500)).toBe("0s");
  });
});
