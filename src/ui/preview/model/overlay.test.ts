import { describe, expect, test } from "bun:test";

import { pinAnchor, pinInputAnchor, selectionCorners } from "./overlay";

const rect = { x: 10, y: 4, width: 20, height: 10 };

describe("pinAnchor", () => {
  test("maps the fractional anchor onto a cell inside the rect", () => {
    expect(pinAnchor(0, 0, rect)).toEqual({ x: 10, y: 4 });
    expect(pinAnchor(1, 1, rect)).toEqual({ x: 29, y: 13 });
    expect(pinAnchor(0.5, 0.5, rect)).toEqual({ x: 10 + 10, y: 4 + 5 });
  });

  test("clamps out-of-range fractions into the rect", () => {
    expect(pinAnchor(2, 2, rect)).toEqual({ x: 29, y: 13 });
    expect(pinAnchor(-1, -1, rect)).toEqual({ x: 10, y: 4 });
  });
});

describe("pinInputAnchor", () => {
  const bounds = { x: 0, y: 0, width: 80, height: 24 };
  const box = { width: 40, height: 4 };

  test("opens the box two columns right of the badge, on the badge's own row (design wsPinInput)", () => {
    expect(pinInputAnchor({ badge: { x: 10, y: 6 }, box, bounds })).toEqual({ x: 12, y: 6 });
  });

  test("slides the box back inside the bounds instead of letting it overflow them", () => {
    // A badge near the right/bottom edge: the box keeps its size and moves, never clips.
    expect(pinInputAnchor({ badge: { x: 78, y: 23 }, box, bounds })).toEqual({ x: 40, y: 20 });
  });

  test("gives up the offset before it gives up the origin when the box cannot fit at all", () => {
    expect(
      pinInputAnchor({ badge: { x: 5, y: 2 }, box, bounds: { x: 0, y: 0, width: 20, height: 2 } }),
    ).toEqual({ x: 0, y: 0 });
  });

  test("is relative to the bounds' own origin, not to the screen", () => {
    expect(
      pinInputAnchor({ badge: { x: 1, y: 1 }, box, bounds: { x: 5, y: 3, width: 80, height: 24 } }),
    ).toEqual({ x: 5, y: 3 });
  });
});

describe("selectionCorners", () => {
  test("places the four corners one cell outside the rect", () => {
    expect(selectionCorners(rect)).toEqual({
      topLeft: { x: 9, y: 3 },
      topRight: { x: 30, y: 3 },
      bottomLeft: { x: 9, y: 14 },
      bottomRight: { x: 30, y: 14 },
    });
  });
});
