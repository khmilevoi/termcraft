import { describe, expect, test } from "bun:test"

import { ProtocolError } from "../../protocol"
import { computeSourceHash, scanPageImports } from "./source-mount"

describe("computeSourceHash", () => {
  test("is the lowercase-hex SHA-256 of the exact bytes", () => {
    const hash = computeSourceHash(new TextEncoder().encode("hello world\n"))
    expect(hash).toBe(
      "a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447",
    )
    expect(hash).toHaveLength(64)
  })

  test("differs for a one-byte change", () => {
    const a = computeSourceHash(new TextEncoder().encode("a"))
    const b = computeSourceHash(new TextEncoder().encode("b"))
    expect(a).not.toBe(b)
  })
})

describe("scanPageImports", () => {
  test("accepts a page importing only @termcraft/runtime", () => {
    const src = `import { definePage, Panel } from "@termcraft/runtime"
import type { PageMeta } from "@termcraft/runtime"
export default function P() { return null }`
    expect(scanPageImports(src)).toBeUndefined()
  })

  test("rejects a bare react import", () => {
    const src = `import { useState } from "react"`
    const result = scanPageImports(src)
    expect(result).toBeInstanceOf(ProtocolError)
    expect((result as ProtocolError).code).toBe("MALFORMED_PROTOCOL")
    expect((result as ProtocolError).reason).toContain("react")
  })

  test("rejects a relative re-export", () => {
    const src = `export { x } from "./sibling.ts"`
    expect(scanPageImports(src)).toBeInstanceOf(ProtocolError)
  })

  test("rejects a dynamic import of a forbidden module", () => {
    const src = `const m = () => import("@termcraft/kit")`
    const result = scanPageImports(src)
    expect(result).toBeInstanceOf(ProtocolError)
    expect((result as ProtocolError).reason).toContain("@termcraft/kit")
  })

  test("rejects an @opentui side-effect import", () => {
    const src = `import "@opentui/core"`
    expect(scanPageImports(src)).toBeInstanceOf(ProtocolError)
  })
})
