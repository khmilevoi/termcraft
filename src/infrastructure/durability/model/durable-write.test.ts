import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { DurableWriteError } from "./errors"
import { durableFileWrite } from "./durable-write"

const onWindows = process.platform === "win32"

describe.skipIf(!onWindows)("durableFileWrite (Windows)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-durwrite-"))

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("installs a fresh file with exact bytes and leaves no temp behind", () => {
    const target = path.join(root, "fresh.bin")
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    expect(durableFileWrite(target, bytes)).toBeUndefined()
    expect(new Uint8Array(fs.readFileSync(target))).toEqual(bytes)
    const leftovers = fs.readdirSync(root).filter((n) => n.startsWith(".tmp-"))
    expect(leftovers).toEqual([])
  })

  test("atomically replaces an existing target", () => {
    const target = path.join(root, "replace.bin")
    expect(durableFileWrite(target, new Uint8Array([9, 9]))).toBeUndefined()
    const next = new Uint8Array([7, 7, 7])
    expect(durableFileWrite(target, next)).toBeUndefined()
    expect(new Uint8Array(fs.readFileSync(target))).toEqual(next)
  })

  test("fails cleanly when the target directory does not exist", () => {
    const target = path.join(root, "missing-dir", "x.bin")
    const result = durableFileWrite(target, new Uint8Array([1]))
    expect(result).toBeInstanceOf(DurableWriteError)
    if (result instanceof DurableWriteError) expect(result.step).toBe("create")
    expect(fs.existsSync(path.dirname(target))).toBe(false)
  })
})
