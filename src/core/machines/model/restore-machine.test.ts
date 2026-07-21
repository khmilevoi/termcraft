import { describe, expect, test } from "bun:test"
import { context } from "@reatom/core"

import { reatomRestoreStateMachine, type RestoreAction, type RestoreState } from "./restore-machine"

/**
 * kernel-command-contract §7.3, §13.1.
 *
 * `RESTORE_STATES`, `RESTORE_ACTIONS`, and `EXPECTED_EDGES` are transcribed BY HAND from
 * §7.3's table a second time, independently of `restore-machine.ts`'s own
 * `RESTORE_TRANSITION_TABLE` — see `export-machine.test.ts` for why iterating the
 * implementation's own table would not discriminate.
 */

const RESTORE_STATES: readonly RestoreState[] = [
  "idle",
  "planning",
  "awaiting-confirmation",
  "executing",
  "record-pending",
  "recovering",
  "blocked",
]

const RESTORE_ACTIONS: readonly RestoreAction[] = [
  "kernel.restore.beginPlan",
  "kernel.restore.planReady",
  "kernel.restore.planFailed",
  "kernel.restore.confirm",
  "kernel.restore.discardPlan",
  "kernel.restore.markRecordPending",
  "kernel.restore.complete",
  "kernel.restore.failBeforeIntent",
  "kernel.restore.beginRecovery",
  "kernel.restore.retryRecord",
  "kernel.restore.blockRecovery",
  "kernel.restore.retryRecovery",
]

interface ExpectedEdge {
  readonly from: RestoreState
  readonly action: RestoreAction
  readonly to: RestoreState
}

// One row per §7.3 table entry, multi-source rows expanded to one edge per source.
const EXPECTED_EDGES: readonly ExpectedEdge[] = [
  { from: "idle", action: "kernel.restore.beginPlan", to: "planning" },
  { from: "planning", action: "kernel.restore.planReady", to: "awaiting-confirmation" },
  { from: "planning", action: "kernel.restore.planFailed", to: "idle" },
  { from: "awaiting-confirmation", action: "kernel.restore.confirm", to: "executing" },
  { from: "awaiting-confirmation", action: "kernel.restore.discardPlan", to: "idle" },
  { from: "executing", action: "kernel.restore.markRecordPending", to: "record-pending" },
  { from: "executing", action: "kernel.restore.complete", to: "idle" },
  { from: "record-pending", action: "kernel.restore.complete", to: "idle" },
  { from: "recovering", action: "kernel.restore.complete", to: "idle" },
  { from: "executing", action: "kernel.restore.failBeforeIntent", to: "idle" },
  { from: "executing", action: "kernel.restore.beginRecovery", to: "recovering" },
  { from: "idle", action: "kernel.restore.beginRecovery", to: "recovering" },
  { from: "record-pending", action: "kernel.restore.retryRecord", to: "recovering" },
  { from: "recovering", action: "kernel.restore.blockRecovery", to: "blocked" },
  { from: "blocked", action: "kernel.restore.retryRecovery", to: "recovering" },
]

const ILLEGAL_CODE = "OPERATION_BUSY"

function findExpected(from: RestoreState, action: RestoreAction): ExpectedEdge | undefined {
  return EXPECTED_EDGES.find((edge) => edge.from === from && edge.action === action)
}

/** Drives a fresh machine straight to `phase` via a known-legal edge path. */
function machineAt(phase: RestoreState) {
  const m = reatomRestoreStateMachine()
  if (phase === "idle") return m
  const path: Record<Exclude<RestoreState, "idle">, readonly RestoreAction[]> = {
    planning: ["kernel.restore.beginPlan"],
    "awaiting-confirmation": ["kernel.restore.beginPlan", "kernel.restore.planReady"],
    executing: ["kernel.restore.beginPlan", "kernel.restore.planReady", "kernel.restore.confirm"],
    "record-pending": [
      "kernel.restore.beginPlan",
      "kernel.restore.planReady",
      "kernel.restore.confirm",
      "kernel.restore.markRecordPending",
    ],
    recovering: ["kernel.restore.beginRecovery"],
    blocked: ["kernel.restore.beginRecovery", "kernel.restore.blockRecovery"],
  }
  for (const action of path[phase]) m.apply(action)
  return m
}

describe("reatomRestoreStateMachine", () => {
  test("starts idle", () => {
    context.start(() => {
      expect(reatomRestoreStateMachine().phase()).toBe("idle")
    })
  })

  test("the phase atom carries the §6 trace root", () => {
    context.start(() => {
      expect(reatomRestoreStateMachine().phaseAtom.name).toBe("kernel.restore.state")
    })
  })

  test("the hand-counted §7.3 edge total is 15", () => {
    expect(EXPECTED_EDGES.length).toBe(15)
  })

  test("every (state, action) pair matches the §7.3 table exactly", () => {
    context.start(() => {
      for (const from of RESTORE_STATES) {
        for (const action of RESTORE_ACTIONS) {
          const expected = findExpected(from, action)
          const m = machineAt(from)
          const outcome = m.apply(action)

          if (expected === undefined) {
            expect(outcome).toEqual({ kind: "illegal", code: ILLEGAL_CODE, from, action })
            expect(m.phase()).toBe(from)
            continue
          }

          expect(outcome).toEqual({ kind: "changed", from, to: expected.to })
          expect(m.phase()).toBe(expected.to)
        }
      }
    })
  })

  test("complete reaches idle from all three of executing, record-pending, and recovering", () => {
    context.start(() => {
      expect(machineAt("executing").apply("kernel.restore.complete").kind).toBe("changed")
      expect(machineAt("record-pending").apply("kernel.restore.complete").kind).toBe("changed")
      expect(machineAt("recovering").apply("kernel.restore.complete").kind).toBe("changed")
    })
  })
})
