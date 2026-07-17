import { describe, expect, test } from "bun:test"

import type { TerminalCapabilities } from "./types"

describe("TerminalCapabilities", () => {
  test("carries a color depth", () => {
    const caps: TerminalCapabilities = { colorDepth: 24 }
    expect(caps.colorDepth).toBe(24)
  })
})
