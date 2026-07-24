import { describe, expect, test } from "bun:test";

import { pinAnchor, selectionCorners } from "./overlay";

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
