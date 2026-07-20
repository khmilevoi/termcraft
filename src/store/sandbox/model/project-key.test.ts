import { describe, expect, test } from "bun:test"
import crypto from "node:crypto"

import { computeProjectKey } from "./project-key"

const PROJECT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10"
const OTHER_PROJECT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d11"

describe("computeProjectKey — storage-identity §4 / turn-durability §6.2", () => {
  test("is deterministic for the same inputs", () => {
    const input = { canonicalProjectRoot: "/home/alice/project", projectId: PROJECT_ID }
    expect(computeProjectKey(input)).toBe(computeProjectKey({ ...input }))
  })

  test("is the lowercase-hex SHA-256 of root || 0x00 || projectId, byte for byte", () => {
    const input = { canonicalProjectRoot: "/home/alice/project", projectId: PROJECT_ID }
    const expected = crypto
      .createHash("sha256")
      .update(Buffer.concat([Buffer.from(input.canonicalProjectRoot, "utf8"), Buffer.from([0x00]), Buffer.from(input.projectId, "utf8")]))
      .digest("hex")

    expect(computeProjectKey(input)).toBe(expected)
    expect(computeProjectKey(input)).toMatch(/^[0-9a-f]{64}$/)
  })

  test("differs for the same basename under a different root (no two projects share a parent)", () => {
    const a = computeProjectKey({ canonicalProjectRoot: "/home/alice/project", projectId: PROJECT_ID })
    const b = computeProjectKey({ canonicalProjectRoot: "/home/bob/project", projectId: PROJECT_ID })
    expect(a).not.toBe(b)
  })

  test("differs for a different projectId on the same root", () => {
    const canonicalProjectRoot = "/home/alice/project"
    const a = computeProjectKey({ canonicalProjectRoot, projectId: PROJECT_ID })
    const b = computeProjectKey({ canonicalProjectRoot, projectId: OTHER_PROJECT_ID })
    expect(a).not.toBe(b)
  })

  test("the 0x00 separator prevents a root/projectId boundary collision", () => {
    // Without an explicit separator, `root="/a", id="b"` and `root="/ab", id=""` would
    // hash the same concatenated bytes under naive string joining.
    const a = computeProjectKey({ canonicalProjectRoot: "/a", projectId: "b" })
    const b = computeProjectKey({ canonicalProjectRoot: "/ab", projectId: "" })
    expect(a).not.toBe(b)
  })

  test("a trailing-separator spelling of the same root is a different key (no implicit canonicalization)", () => {
    // project-key.ts documents this as a caller responsibility, not something it re-derives.
    const a = computeProjectKey({ canonicalProjectRoot: "/home/alice/project", projectId: PROJECT_ID })
    const b = computeProjectKey({ canonicalProjectRoot: "/home/alice/project/", projectId: PROJECT_ID })
    expect(a).not.toBe(b)
  })
})
