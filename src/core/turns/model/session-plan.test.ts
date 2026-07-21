import { describe, expect, test } from "bun:test"

import { createFakeSessionCheckpointService } from "core/ports/fakes"
import type { FailureDtoV1 } from "core/protocol"

import type { TurnDeadlines } from "./deadlines"
import {
  advanceSessionCheckpoint,
  evaluateSessionPlan,
  fallbackToFreshSession,
} from "./session-plan"

/**
 * `session-plan.ts` against 6D's fake `SessionCheckpointService` only. No Reatom, no
 * `context.start` — none of this file's functions touch an atom or action; `TurnDeadlines`
 * (`deadlines.ts`) is plain closures too (see that file's own header), so a hand-written spy
 * suffices for asserting `noteSessionFallback` was (or was not) called, without needing the
 * real factory's clock machinery.
 */

const FAILURE: FailureDtoV1 = { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: "boom", details: {} }

interface SpyDeadlines extends TurnDeadlines {
  readonly noteSessionFallbackCalls: number
}

function createSpyDeadlines(): SpyDeadlines {
  let fallbackCalls = 0
  return {
    noteEvent: () => {},
    noteAttemptStarted: () => {},
    noteSessionFallback: () => {
      fallbackCalls += 1
    },
    check: () => ({ kind: "ok" }),
    absoluteDeadlineAt: () => 0,
    get noteSessionFallbackCalls() {
      return fallbackCalls
    },
  }
}

describe("evaluateSessionPlan", () => {
  test("a resume verdict maps straight to a resume SessionPlan and never calls selectSeed", async () => {
    const sessionCheckpoint = createFakeSessionCheckpointService()
    // Setup: seed the fake's checkpoint store so `evaluateResume` resolves "resume". This
    // call itself is NOT part of what this test asserts on — sliced off below.
    await sessionCheckpoint.advanceCheckpoint({ chatId: "chat-1", sessionScopeId: "scope-1", sessionId: "sess-1" })
    const callsBeforeRun = sessionCheckpoint.calls.length

    const result = await evaluateSessionPlan({ sessionCheckpoint }, { chatId: "chat-1", sessionScopeId: "scope-1" })

    expect(result).toEqual({ kind: "resume", sessionId: "sess-1", promptDelta: null })
    expect(sessionCheckpoint.calls.slice(callsBeforeRun).map((c) => c.method)).toEqual(["evaluateResume"])
  })

  test("a fresh verdict calls selectSeed(chatId) — evaluateResume first, then selectSeed", async () => {
    const seeds = new Map([["chat-1", [{ role: "user" as const, text: "hi" }]]])
    const sessionCheckpoint = createFakeSessionCheckpointService({ seeds })

    const result = await evaluateSessionPlan({ sessionCheckpoint }, { chatId: "chat-1", sessionScopeId: "scope-1" })

    expect(result).toEqual({ kind: "fresh", seed: [{ role: "user", text: "hi" }] })
    expect(sessionCheckpoint.calls.map((c) => c.method)).toEqual(["evaluateResume", "selectSeed"])
  })

  test("a fresh verdict with no seeded records returns an empty seed, not an error", async () => {
    const sessionCheckpoint = createFakeSessionCheckpointService()
    const result = await evaluateSessionPlan({ sessionCheckpoint }, { chatId: "chat-1", sessionScopeId: "scope-1" })
    expect(result).toEqual({ kind: "fresh", seed: [] })
  })

  test("evaluateResume failing propagates the failure and never calls selectSeed", async () => {
    const sessionCheckpoint = createFakeSessionCheckpointService()
    sessionCheckpoint.failNext("evaluateResume", FAILURE)

    const result = await evaluateSessionPlan({ sessionCheckpoint }, { chatId: "chat-1", sessionScopeId: "scope-1" })

    expect(result).toEqual(FAILURE)
    expect(sessionCheckpoint.calls.map((c) => c.method)).toEqual(["evaluateResume"])
  })

  test("selectSeed failing (after a fresh verdict) propagates the failure", async () => {
    const sessionCheckpoint = createFakeSessionCheckpointService()
    sessionCheckpoint.failNext("selectSeed", FAILURE)

    const result = await evaluateSessionPlan({ sessionCheckpoint }, { chatId: "chat-1", sessionScopeId: "scope-1" })

    expect(result).toEqual(FAILURE)
  })
})

describe("fallbackToFreshSession", () => {
  test("selects the seed and notes the deadlines session fallback — in that order", async () => {
    const seeds = new Map([["chat-1", [{ role: "agent" as const, text: "reply" }]]])
    const sessionCheckpoint = createFakeSessionCheckpointService({ seeds })
    const deadlines = createSpyDeadlines()

    const result = await fallbackToFreshSession({ sessionCheckpoint, deadlines }, "chat-1")

    expect(result).toEqual({ kind: "fresh", seed: [{ role: "agent", text: "reply" }] })
    expect(deadlines.noteSessionFallbackCalls).toBe(1)
  })

  test("a selectSeed failure propagates and does NOT note a session fallback", async () => {
    const sessionCheckpoint = createFakeSessionCheckpointService()
    sessionCheckpoint.failNext("selectSeed", FAILURE)
    const deadlines = createSpyDeadlines()

    const result = await fallbackToFreshSession({ sessionCheckpoint, deadlines }, "chat-1")

    expect(result).toEqual(FAILURE)
    expect(deadlines.noteSessionFallbackCalls).toBe(0)
  })
})

describe("advanceSessionCheckpoint", () => {
  test("advances the checkpoint with the exact input and returns undefined on success", async () => {
    const sessionCheckpoint = createFakeSessionCheckpointService()
    const input = { chatId: "chat-1", sessionScopeId: "scope-1", sessionId: "sess-9" }

    const result = await advanceSessionCheckpoint({ sessionCheckpoint }, input)

    expect(result).toBeUndefined()
    expect(sessionCheckpoint.calls).toEqual([{ method: "advanceCheckpoint", ...input }])
  })

  test("propagates an advanceCheckpoint failure", async () => {
    const sessionCheckpoint = createFakeSessionCheckpointService()
    sessionCheckpoint.failNext("advanceCheckpoint", FAILURE)

    const result = await advanceSessionCheckpoint(
      { sessionCheckpoint },
      { chatId: "chat-1", sessionScopeId: "scope-1", sessionId: "sess-9" },
    )

    expect(result).toEqual(FAILURE)
  })
})
