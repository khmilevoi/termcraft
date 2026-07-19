import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { DirectoryFlushError } from "./errors"
import { flushDir } from "./flush-dir"

const onWindows = process.platform === "win32"

describe.skipIf(!onWindows)("flushDir (Windows)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-flush-"))

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("durably flushes an existing directory", () => {
    fs.writeFileSync(path.join(root, "a.txt"), "hello")
    expect(flushDir(root)).toBeUndefined()
  })

  test("returns a typed error for a missing directory", () => {
    const missing = path.join(root, "does-not-exist")
    const result = flushDir(missing)
    expect(result).toBeInstanceOf(DirectoryFlushError)
    if (result instanceof DirectoryFlushError) {
      expect(result.path).toBe(missing)
      expect(typeof result.lastError).toBe("number")
    }
  })
})
