import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { FsIdentityError } from "./errors"
import { formatFsIdentity } from "./fs-identity"

describe("formatFsIdentity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-fsid-"))

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("formats a canonical, platform-tagged identity string", () => {
    const id = formatFsIdentity(root)
    expect(id).not.toBeInstanceOf(FsIdentityError)
    if (typeof id === "string") {
      if (process.platform === "win32") {
        expect(id).toMatch(/^windows:[0-9a-f]{8}:[0-9a-f]+$/)
      } else {
        expect(id).toMatch(/^unix:\d+:\d+$/)
      }
    }
  })

  test("is stable across repeated reads of the same path", () => {
    expect(formatFsIdentity(root)).toBe(formatFsIdentity(root) as string)
  })

  test("distinguishes two different directories", () => {
    const a = path.join(root, "a")
    const b = path.join(root, "b")
    fs.mkdirSync(a)
    fs.mkdirSync(b)
    expect(formatFsIdentity(a)).not.toBe(formatFsIdentity(b) as string)
  })

  test("returns a typed error for a missing path", () => {
    expect(formatFsIdentity(path.join(root, "missing"))).toBeInstanceOf(FsIdentityError)
  })
})
