import { getBaseAttributes, TextAttributes } from "@opentui/core"

/**
 * Map OpenTUI's text-attribute integer to the protocol 6-bit mask (§5.3). NOT a
 * plain `& 0x3f`: OpenTUI `INVERSE=32` and `STRIKETHROUGH=128` do not sit on the
 * protocol's inverse (16) and strikethrough (32) bits, and `BLINK`/`HIDDEN` have
 * no protocol bit. `getBaseAttributes` first strips the hyperlink id from the
 * upper bits.
 */
export function attributesToMask(raw: number): number {
  const base = getBaseAttributes(raw)
  let mask = 0
  if (base & TextAttributes.BOLD) mask |= 1
  if (base & TextAttributes.DIM) mask |= 2
  if (base & TextAttributes.ITALIC) mask |= 4
  if (base & TextAttributes.UNDERLINE) mask |= 8
  if (base & TextAttributes.INVERSE) mask |= 16
  if (base & TextAttributes.STRIKETHROUGH) mask |= 32
  return mask
}
