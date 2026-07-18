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

  test("returns a ProtocolError (never a throw) for unparseable source", () => {
    // Bun.Transpiler.scanImports throws a BuildMessage on syntactically broken
    // TSX; scanPageImports must convert that throw into a typed ProtocolError.
    const broken = `export default function P() { return <text>hi`
    const result = scanPageImports(broken)
    expect(result).toBeInstanceOf(ProtocolError)
    expect((result as ProtocolError).code).toBe("MALFORMED_PROTOCOL")
  })

  test("rejects a dynamic import of the runtime — only a static import is allowed (§3.1)", () => {
    const src = `const rt = () => import("@termcraft/runtime")`
    const result = scanPageImports(src)
    expect(result).toBeInstanceOf(ProtocolError)
    expect((result as ProtocolError).reason).toContain("@termcraft/runtime")
  })

  test("rejects a require of the runtime — only a static import is allowed (§3.1)", () => {
    const src = `const rt = require("@termcraft/runtime")`
    expect(scanPageImports(src)).toBeInstanceOf(ProtocolError)
  })
})

import { registerRuntimeResolver } from "./resolver"
import { computeSourceHash as hashBytes, loadPage } from "./source-mount"

const fixture = (name: string) => `${import.meta.dir}/../fixtures/${name}`

async function hashOfFile(path: string): Promise<string> {
  const bytes = await Bun.file(path).bytes()
  return hashBytes(bytes)
}

describe("loadPage", () => {
  test("loads a valid facade page and validates its meta", async () => {
    registerRuntimeResolver()
    const path = fixture("probe-page.tsx")
    const loaded = await loadPage({
      sourcePath: path,
      expectedSourceHash: await hashOfFile(path),
    })
    expect(loaded).not.toBeInstanceOf(ProtocolError)
    if (loaded instanceof ProtocolError) throw loaded
    expect(loaded.meta.kitApiVersion).toBe(1)
    expect(loaded.meta.title).toBe("Probe page")
    expect(loaded.meta.minSize).toEqual({ w: 10, h: 2 })
    expect(typeof loaded.component).toBe("function")
  })

  test("rejects a source-hash mismatch with SOURCE_HASH_MISMATCH", async () => {
    const path = fixture("probe-page.tsx")
    const result = await loadPage({
      sourcePath: path,
      expectedSourceHash: "0".repeat(64),
    })
    expect(result).toBeInstanceOf(ProtocolError)
    expect((result as ProtocolError).code).toBe("SOURCE_HASH_MISMATCH")
    expect((result as ProtocolError).reason).toContain("source hash")
  })

  test("rejects a page importing a forbidden module before it runs", async () => {
    const path = fixture("forbidden-react.tsx")
    const result = await loadPage({
      sourcePath: path,
      expectedSourceHash: await hashOfFile(path),
    })
    expect(result).toBeInstanceOf(ProtocolError)
    expect((result as ProtocolError).reason).toContain("react")
  })

  test("rejects a missing source path", async () => {
    const result = await loadPage({
      sourcePath: fixture("does-not-exist.tsx"),
      expectedSourceHash: "0".repeat(64),
    })
    expect(result).toBeInstanceOf(ProtocolError)
  })

  test("returns a typed ProtocolError (not a rejection) for a hash-matching but unparseable page", async () => {
    // A hand-edited canonical file or an old snapshot whose stored bytes are
    // syntactically broken still passes the hash + UTF-8 gates and reaches the
    // import scan, which throws. loadPage must surface a typed ProtocolError so
    // the state machine can emit its best-effort `error` envelope (§5/§12).
    const path = fixture("broken-syntax.tsx")
    const result = await loadPage({
      sourcePath: path,
      expectedSourceHash: await hashOfFile(path),
    })
    expect(result).toBeInstanceOf(ProtocolError)
    expect((result as ProtocolError).code).toBe("MALFORMED_PROTOCOL")
  })
})
