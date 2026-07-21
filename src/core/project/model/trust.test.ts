import { describe, expect, test } from "bun:test"

import { createFakeTrustGate } from "core/ports/fakes"

import { buildTrustStatus, grantImplicitTrust, resolveTrustDecision } from "./trust"

/**
 * KCC §12.8/§7.1: subject build, the grant decision, and the untrusted-read-only
 * refusal path. Every test drives the real `TrustGate` fake (`core/ports/fakes/trust.ts`)
 * — no real disk, no crypto — per this slice's TDD/fakes-only mandate.
 *
 * `FailureDtoV1` is a plain DTO, not an `Error` subclass (`core/protocol/model/failure.ts`),
 * so narrowing a `FailureDtoV1 | T` result uses this ring's own `"code" in x` idiom
 * (`core/ports/fakes/page-store.test.ts`'s precedent), never `instanceof Error`.
 */

const ROOT = "/fake/project"
const PROJECT_ID = "fake-project-1"

describe("buildTrustStatus", () => {
  test("builds the subject and reports ungranted for a never-seen root", async () => {
    const trustGate = createFakeTrustGate()
    const status = await buildTrustStatus({ trustGate, root: ROOT, projectId: PROJECT_ID, git: null })
    if ("code" in status) throw new Error("unexpected failure")
    expect(status.granted).toBe(false)
    expect(status.subject.canonicalProjectPath).toBe(ROOT)
    expect(status.subject.projectId).toBe(PROJECT_ID)
  })

  test("reports granted once the exact same subject was previously granted", async () => {
    const trustGate = createFakeTrustGate()
    const first = await buildTrustStatus({ trustGate, root: ROOT, projectId: PROJECT_ID, git: null })
    if ("code" in first) throw new Error("unexpected failure")
    const granted = await trustGate.grant(first.subject)
    if (granted !== undefined) throw new Error("unexpected failure")

    const second = await buildTrustStatus({ trustGate, root: ROOT, projectId: PROJECT_ID, git: null })
    if ("code" in second) throw new Error("unexpected failure")
    expect(second.granted).toBe(true)
  })

  test("propagates a buildSubject failure", async () => {
    const trustGate = createFakeTrustGate()
    const failure = { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: "disk error", details: {} } as const
    trustGate.failNext("buildSubject", failure)
    const status = await buildTrustStatus({ trustGate, root: ROOT, projectId: PROJECT_ID, git: null })
    expect(status).toEqual(failure)
  })
})

describe("grantImplicitTrust", () => {
  test("project.create's implicit grant: builds the subject then durably grants it", async () => {
    const trustGate = createFakeTrustGate()
    const subject = await grantImplicitTrust({ trustGate, root: ROOT, projectId: PROJECT_ID, git: null })
    if ("code" in subject) throw new Error("unexpected failure")

    expect(trustGate.calls.map((c) => c.method)).toEqual(["buildSubject", "grant"])
    expect(await trustGate.isGranted(subject)).toBe(true)
  })

  test("a buildSubject failure short-circuits before grant is ever called", async () => {
    const trustGate = createFakeTrustGate()
    const failure = { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: "disk error", details: {} } as const
    trustGate.failNext("buildSubject", failure)

    const result = await grantImplicitTrust({ trustGate, root: ROOT, projectId: PROJECT_ID, git: null })

    expect(result).toEqual(failure)
    expect(trustGate.calls.map((c) => c.method)).toEqual(["buildSubject"])
  })

  test("propagates a grant failure", async () => {
    const trustGate = createFakeTrustGate()
    const failure = { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: "disk full", details: {} } as const
    trustGate.failNext("grant", failure)

    const result = await grantImplicitTrust({ trustGate, root: ROOT, projectId: PROJECT_ID, git: null })

    expect(result).toEqual(failure)
  })
})

describe("resolveTrustDecision", () => {
  test("a refusal returns untrusted-read-only and never calls grant", async () => {
    const trustGate = createFakeTrustGate()
    const status = await buildTrustStatus({ trustGate, root: ROOT, projectId: PROJECT_ID, git: null })
    if ("code" in status) throw new Error("unexpected failure")

    const decision = await resolveTrustDecision(trustGate, status.subject, "refuse")

    expect(decision).toBe("untrusted-read-only")
    // KCC §12.8: refusal "neither transitions to closed nor starts Gate, HostSupervisor,
    // migration transformation, export, or any mutation" — proved here as the negative
    // that matters at THIS boundary: no `grant` call was made for the refused subject.
    expect(trustGate.calls.map((c) => c.method)).toEqual(["buildSubject", "isGranted"])
    expect(await trustGate.isGranted(status.subject)).toBe(false)
  })

  test("a grant decision calls TrustGate.grant and returns trusted", async () => {
    const trustGate = createFakeTrustGate()
    const status = await buildTrustStatus({ trustGate, root: ROOT, projectId: PROJECT_ID, git: null })
    if ("code" in status) throw new Error("unexpected failure")

    const decision = await resolveTrustDecision(trustGate, status.subject, "grant")

    expect(decision).toBe("trusted")
    expect(await trustGate.isGranted(status.subject)).toBe(true)
  })

  test("propagates a grant failure on the grant path", async () => {
    const trustGate = createFakeTrustGate()
    const status = await buildTrustStatus({ trustGate, root: ROOT, projectId: PROJECT_ID, git: null })
    if ("code" in status) throw new Error("unexpected failure")
    const failure = { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: "disk full", details: {} } as const
    trustGate.failNext("grant", failure)

    const decision = await resolveTrustDecision(trustGate, status.subject, "grant")

    expect(decision).toEqual(failure)
  })
})
