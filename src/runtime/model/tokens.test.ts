import { describe, expect, test } from "bun:test"
import type { ThemeTokens } from "../types"
import { DEFAULT_THEME_ID, themeTokens } from "./tokens"

const HEX = /^#[0-9a-f]{6}$/

describe("theme token registry (§5.4)", () => {
  test("dark-default resolves a complete token palette", () => {
    const tokens = themeTokens("dark-default")
    const keys: (keyof ThemeTokens)[] = [
      "background",
      "surface",
      "surfaceMuted",
      "foreground",
      "foregroundMuted",
      "border",
      "accent",
      "success",
      "warning",
      "danger",
    ]
    for (const key of keys) expect(tokens[key]).toMatch(HEX)
  })

  test("the default theme id is dark-default (MVP ships this theme only)", () => {
    expect(DEFAULT_THEME_ID).toBe("dark-default")
    expect(themeTokens(DEFAULT_THEME_ID)).toBe(themeTokens("dark-default"))
  })
})
