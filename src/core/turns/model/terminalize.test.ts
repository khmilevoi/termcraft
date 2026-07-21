import { describe, expect, test } from "bun:test"
import { context, wrap } from "@reatom/core"

import type { FailureDtoV1 } from "core/protocol"
import { createFakeTurnTransactionService } from "core/ports/fakes"
import { reatomTurnStateMachine, type StateMachine, type TurnAction, type TurnState, type TurnTerminalOutcome } from "core/machines"

import { terminalizeTurn, type TerminalizeTurnInputV1 } from "./terminalize"

/**
 * TESTING NOTE (same hazard as `finalize.test.ts`/`core/project/model/page-mutations.test.ts`):
 * `context.start(cb)` pops its isolated frame the instant `cb()` returns, even for an async
 * `cb`. Every test calls `terminalizeTurn` SYNCHRONOUSLY inside `context.start(() => {...})`
 * and reads `machine.phase()` only through a `wrap(() => machine.phase())` reader captured
 * in that same window.
 */

const TURN_ID = "0192f6f0-0000-7000-8000-00000000aaaa"
const CHAT_ID = "0192f6f0-0000-7000-8000-00000000bbbb"
const CREATED_AT = "2024-06-01T12:00:00.000Z"

/** Walks a fresh machine from `idle` to `terminalizing` — terminalize.ts's own entry phase. */
function advanceToTerminalizing(machine: StateMachine<TurnState, TurnAction>): void {
  const steps: TurnAction[] = ["beginAdmission", "finishAdmission", "beginAttempt", "beginStopping", "beginTerminalization"]
  for (const step of steps) {
    const outcome = machine.apply(step)
    if (outcome.kind === "illegal") throw new Error(`setup: ${step} was illegal from ${outcome.from}`)
  }
}

function baseInput(overrides: Partial<TerminalizeTurnInputV1> = {}): TerminalizeTurnInputV1 {
  return {
    turnId: TURN_ID,
    targetChatId: CHAT_ID,
    outcome: "failed",
    text: "the agent backend failed",
    createdAt: CREATED_AT,
    ...overrides,
  }
}

function setup() {
  const machine = reatomTurnStateMachine()
  advanceToTerminalizing(machine)
  const turnTransactions = createFakeTurnTransactionService()
  return { machine, turnTransactions }
}

describe("terminalizeTurn", () => {
  describe("the outcome -> persisted record mapping is §7.2 verbatim", () => {
    // "failed | cancelled | stale | interrupted", in that exact order, transcribed by hand
    // from §7.2 rather than iterated from the implementation's own mapping.
    const CASES: readonly {
      readonly outcome: TurnTerminalOutcome
      readonly expectKind: "system:error" | "system:cancelled"
      readonly expectRecordOutcome?: "error" | "stale" | "interrupted"
    }[] = [
      { outcome: "failed", expectKind: "system:error", expectRecordOutcome: "error" },
      { outcome: "cancelled", expectKind: "system:cancelled" },
      { outcome: "stale", expectKind: "system:error", expectRecordOutcome: "stale" },
      { outcome: "interrupted", expectKind: "system:error", expectRecordOutcome: "interrupted" },
    ]

    for (const testCase of CASES) {
      test(`"${testCase.outcome}" persists as ${testCase.expectKind}${testCase.expectRecordOutcome ? ` with outcome "${testCase.expectRecordOutcome}"` : ""}`, async () => {
        const { call, turnTransactions } = context.start(() => {
          const { machine, turnTransactions } = setup()
          const call = terminalizeTurn({ machine, turnTransactions }, baseInput({ outcome: testCase.outcome, text: "boom" }))
          return { call, turnTransactions }
        })

        const result = await call

        expect(result.kind).toBe("recorded")
        const terminalizeCall = turnTransactions.calls.find((c) => c.method === "terminalize")
        if (terminalizeCall?.method !== "terminalize") throw new Error("expected a terminalize call")
        expect(terminalizeCall.input.turnId).toBe(TURN_ID)
        expect(terminalizeCall.input.targetChatId).toBe(CHAT_ID)
        expect(terminalizeCall.input.record.kind).toBe(testCase.expectKind)
        expect(terminalizeCall.input.record.turnId).toBe(TURN_ID)
        expect(terminalizeCall.input.record.text).toBe("boom")
        if (terminalizeCall.input.record.kind === "system:error" && testCase.expectRecordOutcome !== undefined) {
          expect(terminalizeCall.input.record.outcome).toBe(testCase.expectRecordOutcome)
        }
      })
    }
  })

  test("never persists turnId AND actionId together — actionId is always absent for a turn terminalization", async () => {
    const { call, turnTransactions } = context.start(() => {
      const { machine, turnTransactions } = setup()
      const call = terminalizeTurn({ machine, turnTransactions }, baseInput())
      return { call, turnTransactions }
    })

    await call

    const terminalizeCall = turnTransactions.calls.find((c) => c.method === "terminalize")
    if (terminalizeCall?.method !== "terminalize") throw new Error("expected a terminalize call")
    expect(terminalizeCall.input.record.actionId).toBeUndefined()
  })

  test("on success it moves terminalizing -> terminal -> idle and reports 'recorded'", async () => {
    const { call, readPhase, turnTransactions } = context.start(() => {
      const { machine, turnTransactions } = setup()
      const call = terminalizeTurn({ machine, turnTransactions }, baseInput())
      return { call, readPhase: wrap(() => machine.phase()), turnTransactions }
    })

    const result = await call

    expect(result.kind).toBe("recorded")
    if (result.kind !== "recorded") return
    expect(typeof result.commit.transactionId).toBe("string")
    expect(readPhase()).toBe("idle")
    expect(turnTransactions.calls.map((c) => c.method)).toEqual(["terminalize"])
  })

  test("rejects with the machine's illegal code and touches no port when the turn is not terminalizing", async () => {
    const { call, turnTransactions } = context.start(() => {
      const machine = reatomTurnStateMachine() // stays at idle
      const turnTransactions = createFakeTurnTransactionService()
      const call = terminalizeTurn({ machine, turnTransactions }, baseInput())
      return { call, turnTransactions }
    })

    const result = await call

    expect(result).toEqual({ kind: "illegal", code: "TURN_ALREADY_ACTIVE" })
    expect(turnTransactions.calls).toEqual([])
  })

  test("§7.2: finishTerminalization is legal on a TYPED UNRECORDED condition too — a failed append still reaches terminal -> idle", async () => {
    // "Requires exactly one terminal chat record OR a typed unrecorded recovery
    // condition." A turn that could not even append its own failure record must not get
    // stuck outside `terminal` — startup orphan recovery (already landed) picks this up.
    const FAILURE: FailureDtoV1 = { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: "disk unavailable", details: {} }
    const { call, readPhase, turnTransactions } = context.start(() => {
      const { machine, turnTransactions } = setup()
      turnTransactions.failNext("terminalize", FAILURE)
      const call = terminalizeTurn({ machine, turnTransactions }, baseInput())
      return { call, readPhase: wrap(() => machine.phase()), turnTransactions }
    })

    const result = await call

    expect(result).toEqual({ kind: "unrecorded", failure: FAILURE })
    expect(readPhase()).toBe("idle")
    expect(turnTransactions.calls.map((c) => c.method)).toEqual(["terminalize"])
  })

  test("a reason is threaded onto the system:error record only", async () => {
    const { call, turnTransactions } = context.start(() => {
      const { machine, turnTransactions } = setup()
      const call = terminalizeTurn(
        { machine, turnTransactions },
        baseInput({ outcome: "interrupted", reason: "process_restart_before_intent" }),
      )
      return { call, turnTransactions }
    })

    await call

    const terminalizeCall = turnTransactions.calls.find((c) => c.method === "terminalize")
    if (terminalizeCall?.method !== "terminalize") throw new Error("expected a terminalize call")
    if (terminalizeCall.input.record.kind !== "system:error") throw new Error("expected system:error")
    expect(terminalizeCall.input.record.reason).toBe("process_restart_before_intent")
  })
})
