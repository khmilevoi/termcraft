import { describe, expect, test } from "bun:test"

import { COMMAND_KINDS_V1, type CommandKindV1 } from "core/protocol"

import { DEFERRED_CAPABILITY_KINDS, deferredCapabilityReason, isDeferredCapabilityKind } from "./deferred-guards"

/**
 * mvp-phase-6-core plan, Decision D1 (lines 75-83): "Deferred-family guards reject with
 * `CAPABILITY_UNAVAILABLE`, §11.1's designated 'typed fallback for a guard reason that has
 * no more specific public code'. `GIT_UNAVAILABLE` is rejected as a candidate because it
 * asserts something false (installed Git may be perfectly usable; termcraft simply ships
 * no adapter). The choice is made in exactly one place —
 * `core/versions/model/deferred-guards.ts` — because capability/guard parity requires the
 * primary code to be identical on the projection path and the dispatch path."
 *
 * This file's own task brief pins the exact Tier-C family list: "The deferred families
 * (restore.*, commit.*, history.open, preview.forwardInput, preview.setTweak) reject with
 * CAPABILITY_UNAVAILABLE." That expands to exactly 10 of the 43 `CommandKindV1` members;
 * the list below is transcribed BY HAND from that sentence, independently of
 * `deferred-guards.ts`'s own `DEFERRED_CAPABILITY_KINDS` constant, so a wrong or drifted
 * implementation list shows up as a failing assertion here rather than being self-confirmed.
 */
const EXPECTED_DEFERRED_KINDS: readonly CommandKindV1[] = [
  "restore.plan",
  "restore.confirm",
  "restore.discardPlan",
  "restore.retryRecord",
  "commit.plan",
  "commit.confirm",
  "commit.discardPlan",
  "history.open",
  "preview.forwardInput",
  "preview.setTweak",
]

describe("DEFERRED_CAPABILITY_KINDS — the single MVP Tier-C family list", () => {
  test("is exactly the 10 kinds the plan's Decision D1 names, no more, no fewer", () => {
    expect([...DEFERRED_CAPABILITY_KINDS].sort()).toEqual([...EXPECTED_DEFERRED_KINDS].sort())
    expect(DEFERRED_CAPABILITY_KINDS.length).toBe(10)
  })

  test("contains no duplicate kind", () => {
    expect(new Set(DEFERRED_CAPABILITY_KINDS).size).toBe(DEFERRED_CAPABILITY_KINDS.length)
  })
})

describe("isDeferredCapabilityKind", () => {
  test("is true for every one of the 10 deferred kinds", () => {
    for (const kind of EXPECTED_DEFERRED_KINDS) {
      expect(isDeferredCapabilityKind(kind), `${kind} should be deferred`).toBe(true)
    }
  })

  test("is false for every one of the other 33 kinds", () => {
    const deferredSet = new Set(EXPECTED_DEFERRED_KINDS)
    const nonDeferred = COMMAND_KINDS_V1.filter((kind) => !deferredSet.has(kind))
    expect(nonDeferred.length).toBe(33)
    for (const kind of nonDeferred) {
      expect(isDeferredCapabilityKind(kind), `${kind} should not be deferred`).toBe(false)
    }
  })

  // A sample of specific, individually-meaningful non-deferred kinds — spelled out rather
  // than only relying on set subtraction above, so a wrong `EXPECTED_DEFERRED_KINDS`
  // transcription in this file could not silently launder a wrong implementation through.
  test("is false for turn.start, chat.create, migration.plan, preview.setMode, pin.create", () => {
    expect(isDeferredCapabilityKind("turn.start")).toBe(false)
    expect(isDeferredCapabilityKind("chat.create")).toBe(false)
    expect(isDeferredCapabilityKind("migration.plan")).toBe(false)
    expect(isDeferredCapabilityKind("preview.setMode")).toBe(false)
    expect(isDeferredCapabilityKind("pin.create")).toBe(false)
  })
})

describe("deferredCapabilityReason", () => {
  test("returns exactly { code: 'CAPABILITY_UNAVAILABLE' } for every deferred kind — no extra fields", () => {
    for (const kind of EXPECTED_DEFERRED_KINDS) {
      const reason = deferredCapabilityReason(kind)
      expect(reason, `${kind}: expected a reason`).not.toBeNull()
      expect(reason).toEqual({ code: "CAPABILITY_UNAVAILABLE" })
    }
  })

  test("never returns GIT_UNAVAILABLE — decision D1's explicitly rejected candidate", () => {
    for (const kind of EXPECTED_DEFERRED_KINDS) {
      const reason = deferredCapabilityReason(kind)
      expect(reason?.code).not.toBe("GIT_UNAVAILABLE")
    }
  })

  test("returns null for every non-deferred kind", () => {
    const deferredSet = new Set(EXPECTED_DEFERRED_KINDS)
    for (const kind of COMMAND_KINDS_V1) {
      if (deferredSet.has(kind)) continue
      expect(deferredCapabilityReason(kind), `${kind}: expected null`).toBeNull()
    }
  })
})

describe("the shared reason is frozen", () => {
  test("decorating one kind's reason cannot leak into another's", () => {
    // One object is handed to every caller for all ten deferred kinds, and §11.1 calls
    // user-facing prose "presentation data" — so a consumer attaching a display message is
    // a plausible thing to write. Against a mutable singleton that decoration would leak
    // process-wide, permanently, into every other kind's reason.
    const first = deferredCapabilityReason("commit.plan")
    expect(first).not.toBeNull()
    if (first === null) return
    expect(Object.isFrozen(first)).toBe(true)

    // A frozen object silently ignores the write in sloppy mode; what matters is that the
    // second caller is unaffected either way.
    try {
      ;(first as unknown as Record<string, unknown>).displayMessage = "leaked"
    } catch {
      // strict-mode TypeError is equally acceptable — the point is the leak cannot happen.
    }
    expect(deferredCapabilityReason("history.open")).toEqual({ code: "CAPABILITY_UNAVAILABLE" })
  })
})
