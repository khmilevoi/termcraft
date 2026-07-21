import { describe, expect, test } from "bun:test"

import type { FailureDtoV1 } from "core/protocol"
import { createFakeTrustGate } from "./trust"

const FAILURE: FailureDtoV1 = { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: "trust ledger unwritable", details: {} }

describe("createFakeTrustGate", () => {
  test("isGranted() is false for a subject that was never granted — never fails open", async () => {
    const gate = createFakeTrustGate()
    const subject = await gate.buildSubject("C:/proj", "project-1", null)
    if ("code" in subject) throw new Error("unexpected failure")
    expect(await gate.isGranted(subject)).toBe(false)
  })

  test("buildSubject() is deterministic — the same inputs produce the same key", async () => {
    const gate = createFakeTrustGate()
    const a = await gate.buildSubject("C:/proj", "project-1", null)
    const b = await gate.buildSubject("C:/proj", "project-1", null)
    if ("code" in a || "code" in b) throw new Error("unexpected failure")
    expect(a.key).toBe(b.key)
  })

  test("grant() then isGranted() reports true for that exact subject", async () => {
    const gate = createFakeTrustGate()
    const subject = await gate.buildSubject("C:/proj", "project-1", null)
    if ("code" in subject) throw new Error("unexpected failure")
    await gate.grant(subject)
    expect(await gate.isGranted(subject)).toBe(true)
  })

  test("a differently-built subject (different git identity) is never granted by another subject's grant", async () => {
    const gate = createFakeTrustGate()
    const withoutGit = await gate.buildSubject("C:/proj", "project-1", null)
    const withGit = await gate.buildSubject("C:/proj", "project-1", {
      canonicalGitCommonDir: "C:/proj/.git",
      gitCommonDirFilesystemIdentity: "fsid-1",
      projectPathRelativeToWorktreeRoot: ".",
    })
    if ("code" in withoutGit || "code" in withGit) throw new Error("unexpected failure")
    await gate.grant(withoutGit)
    expect(await gate.isGranted(withGit)).toBe(false)
  })

  test("failNext() queues one failure for grant()", async () => {
    const gate = createFakeTrustGate()
    const subject = await gate.buildSubject("C:/proj", "project-1", null)
    if ("code" in subject) throw new Error("unexpected failure")
    gate.failNext("grant", FAILURE)
    const first = await gate.grant(subject)
    expect(first).toEqual(FAILURE)
    const second = await gate.grant(subject)
    expect(second).toBeUndefined()
  })

  test("records calls in order", async () => {
    const gate = createFakeTrustGate()
    const subject = await gate.buildSubject("C:/proj", "project-1", null)
    if ("code" in subject) throw new Error("unexpected failure")
    await gate.isGranted(subject)
    await gate.grant(subject)
    expect(gate.calls.map((c) => c.method)).toEqual(["buildSubject", "isGranted", "grant"])
  })
})
