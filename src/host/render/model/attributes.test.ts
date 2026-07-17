import { describe, expect, test } from "bun:test"
import { TextAttributes } from "@opentui/core"

import { attributesToMask } from "./attributes"

describe("attributesToMask", () => {
  test("maps none to 0", () => {
    expect(attributesToMask(0)).toBe(0)
  })

  test("keeps the coincident low bits (bold/dim/italic/underline)", () => {
    expect(attributesToMask(TextAttributes.BOLD)).toBe(1)
    expect(attributesToMask(TextAttributes.DIM)).toBe(2)
    expect(attributesToMask(TextAttributes.ITALIC)).toBe(4)
    expect(attributesToMask(TextAttributes.UNDERLINE)).toBe(8)
  })

  test("remaps INVERSE (OpenTUI 32) to protocol bit 16", () => {
    expect(attributesToMask(TextAttributes.INVERSE)).toBe(16)
  })

  test("remaps STRIKETHROUGH (OpenTUI 128) to protocol bit 32", () => {
    expect(attributesToMask(TextAttributes.STRIKETHROUGH)).toBe(32)
  })

  test("drops BLINK and HIDDEN (no protocol bit)", () => {
    expect(attributesToMask(TextAttributes.BLINK)).toBe(0)
    expect(attributesToMask(TextAttributes.HIDDEN)).toBe(0)
  })

  test("combines flags and strips a hyperlink id", () => {
    const raw = TextAttributes.BOLD | TextAttributes.INVERSE
    expect(attributesToMask(raw)).toBe(1 | 16)
    // A link id lives in the upper bits; getBaseAttributes must strip it.
    const withLink = raw | (7 << 8)
    expect(attributesToMask(withLink)).toBe(1 | 16)
  })
})
