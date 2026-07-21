import { describe, expect, test } from "bun:test"
import { context } from "@reatom/core"

import {
  PROJECT_ACTION_FULL_NAME,
  reatomProjectStateMachine,
  type ProjectAction,
  type ProjectState,
} from "./project-machine"

/**
 * kernel-command-contract §7.1 (lines 189-228), §13.1.
 *
 * `PROJECT_STATES`, `PROJECT_ACTIONS`, and `EXPECTED_EDGES` below are transcribed BY HAND
 * from the spec's §7.1 table a second time, independently of `project-machine.ts`'s own
 * `PROJECT_TRANSITION_TABLE`. Iterating the implementation's own table would not catch the
 * implementation transcribing a row wrong — pinning against this independent copy means a
 * wrong target, a dropped source, or a wrong illegal code in the implementation shows up as
 * a failing assertion here, not a test that trivially mirrors the code under test.
 */

const PROJECT_STATES: readonly ProjectState[] = [
  "closed",
  "opening",
  "recovering",
  "ready",
  "blocked",
  "closing",
]

const PROJECT_ACTIONS: readonly ProjectAction[] = [
  "beginCreate",
  "beginOpen",
  "beginRecovery",
  "finishOpen",
  "blockOpen",
  "setTrust",
  "renamePageTitle",
  "reorderPages",
  "beginPageRemovePlan",
  "confirmPageRemove",
  "discardPageRemovePlan",
  "beginClose",
  "finishClose",
  "retryOpen",
]

interface ExpectedEdge {
  readonly from: ProjectState
  readonly action: ProjectAction
  readonly to: ProjectState
  readonly noOp?: boolean
}

// One entry per §7.1 table row, multi-source rows expanded to one edge per source, and the
// two-action row ("beginCreate or beginOpen") expanded to one edge per action.
const EXPECTED_EDGES: readonly ExpectedEdge[] = [
  { from: "closed", action: "beginCreate", to: "opening" },
  { from: "closed", action: "beginOpen", to: "opening" },
  { from: "opening", action: "beginRecovery", to: "recovering" },
  { from: "opening", action: "finishOpen", to: "ready" },
  { from: "recovering", action: "finishOpen", to: "ready" },
  { from: "opening", action: "blockOpen", to: "blocked" },
  { from: "recovering", action: "blockOpen", to: "blocked" },
  // §7.1: setTrust from "opening" and from "ready" are both same-phase but real,
  // revision-changing transitions — neither row's rule text calls them a no-op, and the
  // "ready" row explicitly says "it is not an identity setter" — so noOp is NOT set.
  { from: "opening", action: "setTrust", to: "opening" },
  { from: "ready", action: "setTrust", to: "ready" },
  { from: "ready", action: "renamePageTitle", to: "ready" },
  { from: "ready", action: "reorderPages", to: "ready" },
  { from: "ready", action: "beginPageRemovePlan", to: "ready" },
  { from: "ready", action: "confirmPageRemove", to: "ready" },
  { from: "ready", action: "discardPageRemovePlan", to: "ready" },
  { from: "ready", action: "beginClose", to: "closing" },
  { from: "blocked", action: "beginClose", to: "closing" },
  { from: "closing", action: "finishClose", to: "closed" },
  { from: "blocked", action: "retryOpen", to: "opening" },
]

const ILLEGAL_CODE = "PROJECT_NOT_READY"

function findExpected(from: ProjectState, action: ProjectAction): ExpectedEdge | undefined {
  return EXPECTED_EDGES.find((edge) => edge.from === from && edge.action === action)
}

/** Drives a fresh machine straight to `phase` via a known-legal edge path. */
function machineAt(phase: ProjectState) {
  const m = reatomProjectStateMachine()
  if (phase === "closed") return m
  const path: Record<Exclude<ProjectState, "closed">, readonly ProjectAction[]> = {
    opening: ["beginOpen"],
    recovering: ["beginOpen", "beginRecovery"],
    ready: ["beginOpen", "beginRecovery", "finishOpen"],
    blocked: ["beginOpen", "beginRecovery", "blockOpen"],
    closing: ["beginOpen", "beginRecovery", "finishOpen", "beginClose"],
  }
  for (const action of path[phase]) m.apply(action)
  return m
}

describe("reatomProjectStateMachine", () => {
  test("starts closed", () => {
    context.start(() => {
      expect(reatomProjectStateMachine().phase()).toBe("closed")
    })
  })

  test("the phase atom carries the §6 trace root", () => {
    context.start(() => {
      expect(reatomProjectStateMachine().phaseAtom.name).toBe("kernel.project.state")
    })
  })

  test("the hand-counted §7.1 edge total is 18", () => {
    expect(EXPECTED_EDGES.length).toBe(18)
  })

  test("every (state, action) pair matches the §7.1 table exactly", () => {
    context.start(() => {
      for (const from of PROJECT_STATES) {
        for (const action of PROJECT_ACTIONS) {
          const expected = findExpected(from, action)
          const m = machineAt(from)
          const outcome = m.apply(action)

          if (expected === undefined) {
            expect(outcome).toEqual({ kind: "illegal", code: ILLEGAL_CODE, from, action })
            expect(m.phase()).toBe(from)
            continue
          }

          if (expected.noOp === true) {
            expect(outcome).toEqual({ kind: "no-op", phase: from })
          } else {
            expect(outcome).toEqual({ kind: "changed", from, to: expected.to })
          }
          expect(m.phase()).toBe(expected.to)
        }
      }
    })
  })

  test("two machines built by the factory are independent", () => {
    context.start(() => {
      const a = reatomProjectStateMachine()
      const b = reatomProjectStateMachine()
      a.apply("beginOpen")
      expect(a.phase()).toBe("opening")
      expect(b.phase()).toBe("closed")
    })
  })

  test("PROJECT_ACTION_FULL_NAME names every action with its kernel.project.<verb> form", () => {
    // Independent hand-transcription of §7.1's dotted action names, so a typo in the
    // implementation's map is caught here rather than by re-deriving the same string.
    const expectedFullNames: Readonly<Record<ProjectAction, string>> = {
      beginCreate: "kernel.project.beginCreate",
      beginOpen: "kernel.project.beginOpen",
      beginRecovery: "kernel.project.beginRecovery",
      finishOpen: "kernel.project.finishOpen",
      blockOpen: "kernel.project.blockOpen",
      setTrust: "kernel.project.setTrust",
      renamePageTitle: "kernel.project.renamePageTitle",
      reorderPages: "kernel.project.reorderPages",
      beginPageRemovePlan: "kernel.project.beginPageRemovePlan",
      confirmPageRemove: "kernel.project.confirmPageRemove",
      discardPageRemovePlan: "kernel.project.discardPageRemovePlan",
      beginClose: "kernel.project.beginClose",
      finishClose: "kernel.project.finishClose",
      retryOpen: "kernel.project.retryOpen",
    }
    for (const action of PROJECT_ACTIONS) {
      expect(PROJECT_ACTION_FULL_NAME[action]).toBe(expectedFullNames[action])
    }
  })

  test("beginPageRemovePlan from ready is phase-legal; the trusted/no-active-turn/listed-page precondition is the caller's, not the table's", () => {
    // §7.1: "Requires trusted writable state, no active turn, and a listed page." A
    // transition table can only express which (source, action) pairs are LEGAL at the
    // phase level — those preconditions are guard-layer concerns evaluated before the
    // action ever reaches this machine.
    context.start(() => {
      const m = machineAt("ready")
      expect(m.apply("beginPageRemovePlan")).toEqual({ kind: "changed", from: "ready", to: "ready" })
    })
  })
})
