import { describe, expect, test } from "bun:test"

import { uuidv7 } from "infrastructure/uuid"

import { checkRevisionGuard, type ActiveTurnCancelState, type TurnCancelProbe } from "./revision-guard"

/** A probe that always reports no active turn. */
const noActiveTurnProbe: TurnCancelProbe = { activeTurn: () => null }

/** Builds a probe reporting exactly one active turn, for a given phase/intent state. */
function probeFor(state: ActiveTurnCancelState): TurnCancelProbe {
  return { activeTurn: () => state }
}

/** A probe that throws if consulted — proves the guard never touches it on a given path. */
const explodingProbe: TurnCancelProbe = {
  activeTurn: () => {
    throw new Error("cancel probe must not be consulted for this command")
  },
}

describe("checkRevisionGuard — ordinary (non-cancel) dispatch", () => {
  test("proceeds when expectedRevision equals the current revision", () => {
    const decision = checkRevisionGuard({
      command: { kind: "pin.create", expectedRevision: "5" },
      currentRevision: "5",
      cancelProbe: explodingProbe,
    })
    expect(decision).toEqual({ kind: "proceed" })
  })

  test("rejects with STALE_REVISION and the current revision on any mismatch", () => {
    const decision = checkRevisionGuard({
      command: { kind: "pin.create", expectedRevision: "4" },
      currentRevision: "5",
      cancelProbe: explodingProbe,
    })
    expect(decision).toEqual({ kind: "rejected", code: "STALE_REVISION", currentRevision: "5" })
  })

  test("rejects with STALE_REVISION even when expectedRevision is ahead of current", () => {
    // §8.4 requires strict equality, not "expected <= current" — a UI that raced ahead is
    // just as stale a snapshot as one that lagged behind.
    const decision = checkRevisionGuard({
      command: { kind: "pin.create", expectedRevision: "9" },
      currentRevision: "5",
      cancelProbe: explodingProbe,
    })
    expect(decision).toEqual({ kind: "rejected", code: "STALE_REVISION", currentRevision: "5" })
  })

  test("never consults the cancel probe for a non-cancel command", () => {
    // Proven by `explodingProbe` above not throwing in either case; this test pins that
    // guarantee explicitly rather than leaving it implicit in the other two.
    expect(() =>
      checkRevisionGuard({
        command: { kind: "turn.start", expectedRevision: "1" },
        currentRevision: "1",
        cancelProbe: explodingProbe,
      }),
    ).not.toThrow()
  })
})

describe("checkRevisionGuard — turn.cancel §8.4 rules 1, 2, 5: identity and staleness tolerance", () => {
  test("rule 5: rejects with TURN_NOT_ACTIVE when no turn is active", () => {
    const decision = checkRevisionGuard({
      command: { kind: "turn.cancel", expectedRevision: "1", turnId: uuidv7() },
      currentRevision: "9",
      cancelProbe: noActiveTurnProbe,
    })
    expect(decision).toEqual({ kind: "rejected", code: "TURN_NOT_ACTIVE", currentRevision: "9" })
  })

  test("rules 1 + 5: rejects with TURN_ID_MISMATCH when the payload names a different turn", () => {
    const activeTurnId = uuidv7()
    const decision = checkRevisionGuard({
      command: { kind: "turn.cancel", expectedRevision: "9", turnId: uuidv7() },
      currentRevision: "9",
      cancelProbe: probeFor({ turnId: activeTurnId, phase: "running", durableIntentRecorded: false }),
    })
    expect(decision).toEqual({ kind: "rejected", code: "TURN_ID_MISMATCH", currentRevision: "9" })
  })

  test("rule 2: proceeds despite a stale expectedRevision when it names the active turn", () => {
    // This is the §8.4 rationale case: "an Esc generated from a slightly stale UI [can]
    // stop the intended run" — expectedRevision ("1") is far behind currentRevision ("9"),
    // yet the command still proceeds because it names the turn that is actually running.
    const activeTurnId = uuidv7()
    const decision = checkRevisionGuard({
      command: { kind: "turn.cancel", expectedRevision: "1", turnId: activeTurnId },
      currentRevision: "9",
      cancelProbe: probeFor({ turnId: activeTurnId, phase: "running", durableIntentRecorded: false }),
    })
    expect(decision).toEqual({ kind: "proceed" })
  })

  test("rationale pair: a stale-revision cancel never cancels a newer turn it does not name", () => {
    // Same stale expectedRevision ("1") and currentRevision ("9") as the previous test, but
    // the payload names a DIFFERENT (older) turnId than the one actually active — this must
    // reject, never silently proceed against the newer turn.
    const olderTurnId = uuidv7()
    const activeTurnId = uuidv7()
    const decision = checkRevisionGuard({
      command: { kind: "turn.cancel", expectedRevision: "1", turnId: olderTurnId },
      currentRevision: "9",
      cancelProbe: probeFor({ turnId: activeTurnId, phase: "running", durableIntentRecorded: false }),
    })
    expect(decision).toEqual({ kind: "rejected", code: "TURN_ID_MISMATCH", currentRevision: "9" })
  })
})

describe("checkRevisionGuard — turn.cancel §8.4 rule 3: active pre-intent phases proceed", () => {
  const activeTurnId = uuidv7()
  const prIntentPhases = [
    "admitting",
    "workspace-ready",
    "running",
    "snapshotting",
    "validating",
  ] as const

  for (const phase of prIntentPhases) {
    test(`phase "${phase}" proceeds`, () => {
      const decision = checkRevisionGuard({
        command: { kind: "turn.cancel", expectedRevision: "0", turnId: activeTurnId },
        currentRevision: "7",
        cancelProbe: probeFor({ turnId: activeTurnId, phase, durableIntentRecorded: false }),
      })
      expect(decision).toEqual({ kind: "proceed" })
    })
  }

  test('"finalizing" before durable intent proceeds', () => {
    const decision = checkRevisionGuard({
      command: { kind: "turn.cancel", expectedRevision: "0", turnId: activeTurnId },
      currentRevision: "7",
      cancelProbe: probeFor({ turnId: activeTurnId, phase: "finalizing", durableIntentRecorded: false }),
    })
    expect(decision).toEqual({ kind: "proceed" })
  })
})

describe("checkRevisionGuard — turn.cancel §8.4 rule 4: repeated cancel is an accepted no-op", () => {
  const activeTurnId = uuidv7()

  test('"stopping" returns accepted-no-op for the same turn', () => {
    const decision = checkRevisionGuard({
      command: { kind: "turn.cancel", expectedRevision: "0", turnId: activeTurnId },
      currentRevision: "3",
      cancelProbe: probeFor({ turnId: activeTurnId, phase: "stopping", durableIntentRecorded: false }),
    })
    expect(decision).toEqual({ kind: "accepted-no-op" })
  })

  test('"terminalizing" returns accepted-no-op for the same turn', () => {
    const decision = checkRevisionGuard({
      command: { kind: "turn.cancel", expectedRevision: "0", turnId: activeTurnId },
      currentRevision: "3",
      cancelProbe: probeFor({ turnId: activeTurnId, phase: "terminalizing", durableIntentRecorded: false }),
    })
    expect(decision).toEqual({ kind: "accepted-no-op" })
  })
})

describe("checkRevisionGuard — turn.cancel §8.4 rule 6: too late after durable intent", () => {
  test('"finalizing" with durable intent recorded rejects with CANCEL_TOO_LATE', () => {
    const activeTurnId = uuidv7()
    const decision = checkRevisionGuard({
      command: { kind: "turn.cancel", expectedRevision: "0", turnId: activeTurnId },
      currentRevision: "12",
      cancelProbe: probeFor({ turnId: activeTurnId, phase: "finalizing", durableIntentRecorded: true }),
    })
    expect(decision).toEqual({ kind: "rejected", code: "CANCEL_TOO_LATE", currentRevision: "12" })
  })
})
