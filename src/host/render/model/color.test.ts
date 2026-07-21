import { describe, expect, test } from "bun:test";

import { RGBA } from "@opentui/core";

import { rgbaToColor } from "./color";

describe("rgbaToColor", () => {
  test('maps a default-intent color to "default"', () => {
    expect(rgbaToColor(RGBA.defaultForeground())).toBe("default");
  });

  test('maps a transparent (alpha 0) color to "default"', () => {
    expect(rgbaToColor(RGBA.fromInts(0, 0, 0, 0))).toBe("default");
  });

  test("maps an indexed color to { indexed: slot }", () => {
    expect(rgbaToColor(RGBA.fromIndex(9))).toEqual({ indexed: 9 });
  });

  test("maps an rgb color to lowercase #rrggbb", () => {
    expect(rgbaToColor(RGBA.fromInts(255, 136, 0))).toEqual({ rgb: "#ff8800" });
  });

  test("pads single-digit channels", () => {
    expect(rgbaToColor(RGBA.fromInts(1, 2, 3))).toEqual({ rgb: "#010203" });
  });
});
