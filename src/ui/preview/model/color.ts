import { RGBA } from "@opentui/core";

import type { ColorV1 } from "core/ports";

/**
 * Converts a wire `ColorV1` (a preview frame cell's fg/bg) into an OpenTUI colour input for
 * a `<text fg|bg>` prop. True colour passes through as its `#rrggbb` string; an indexed
 * colour becomes an `RGBA` via the palette (`RGBA.fromIndex`); `"default"` becomes `undefined`
 * so the cell inherits the terminal default. Round-trips back through the headless renderer's
 * `rgbaToColor` to the same `ColorV1` (rgb -> rgb, indexed -> indexed, default -> default).
 */
export function colorV1ToInput(color: ColorV1): string | RGBA | undefined {
  if (color === "default") return undefined;
  if ("rgb" in color) return color.rgb;
  return RGBA.fromIndex(color.indexed);
}
