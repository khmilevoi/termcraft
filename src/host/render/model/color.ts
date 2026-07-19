import { RGBA } from "@opentui/core"

import type { Color } from "../../protocol"

const hexByte = (value: number) => value.toString(16).padStart(2, "0")

/**
 * Map an OpenTUI `RGBA` to the protocol `Color`. Drives off `intent`, with the
 * observed unset-cell case (transparent `a === 0`) folded into "default"
 * (Spike B: unset cells arrive as intent "rgb" with alpha 0). Indexed colors
 * keep their palette `slot`; true colors emit lowercase `#rrggbb`.
 */
export function rgbaToColor(color: RGBA): Color {
  if (color.intent === "default" || color.a === 0) return "default"
  if (color.intent === "indexed") return { indexed: color.slot }
  const [r, g, b] = color.toInts()
  return { rgb: `#${hexByte(r)}${hexByte(g)}${hexByte(b)}` }
}

export const isDefaultColor = (color: Color): color is "default" => {
  return color === "default"
}

export const extractRgb = (color: Color): `#${string}` | undefined => {
  return !isDefaultColor(color) && "rgb" in color ? color.rgb : undefined
}

export const extractIndexed = (color: Color): number | undefined => {
  return !isDefaultColor(color) && "indexed" in color ? color.indexed : undefined
}
