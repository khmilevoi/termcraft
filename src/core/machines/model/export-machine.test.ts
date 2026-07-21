import { describe, expect, test } from "bun:test"
import { context } from "@reatom/core"

import { reatomExportStateMachine, type ExportAction, type ExportState } from "./export-machine"

/**
 * kernel-command-contract §7.5, §13.1.
 *
 * `EXPORT_STATES`, `EXPORT_ACTIONS`, and `EXPECTED_EDGES` below are transcribed BY HAND
 * from the spec's §7.5 table a second time, independently of `export-machine.ts`'s own
 * `EXPORT_TRANSITION_TABLE`. Iterating the implementation's own table would not be able
 * to catch the implementation transcribing a row wrong — this file pins against the spec
 * text itself, so a wrong target, a dropped source, or a wrong illegal code in the
 * implementation shows up as a failing assertion here.
 */

const EXPORT_STATES: readonly ExportState[] = [
  "idle",
  "preparing",
  "rendering",
  "publishing",
  "recovering",
  "blocked",
]

const EXPORT_ACTIONS: readonly ExportAction[] = [
  "kernel.export.begin",
  "kernel.export.beginRendering",
  "kernel.export.beginPublication",
  "kernel.export.complete",
  "kernel.export.fail",
  "kernel.export.failBeforeIntent",
  "kernel.export.beginRecovery",
  "kernel.export.completeRecovery",
  "kernel.export.blockRecovery",
  "kernel.export.retryRecovery",
]

interface ExpectedEdge {
  readonly from: ExportState
  readonly action: ExportAction
  readonly to: ExportState
  readonly noOp?: boolean
}

// One row per §7.5 table entry, multi-source rows expanded to one edge per source.
const EXPECTED_EDGES: readonly ExpectedEdge[] = [
  { from: "idle", action: "kernel.export.begin", to: "preparing" },
  { from: "preparing", action: "kernel.export.beginRendering", to: "rendering" },
  { from: "rendering", action: "kernel.export.beginPublication", to: "publishing" },
  { from: "publishing", action: "kernel.export.complete", to: "idle" },
  { from: "preparing", action: "kernel.export.fail", to: "idle" },
  { from: "rendering", action: "kernel.export.fail", to: "idle" },
  { from: "publishing", action: "kernel.export.failBeforeIntent", to: "idle" },
  { from: "publishing", action: "kernel.export.beginRecovery", to: "recovering" },
  { from: "idle", action: "kernel.export.beginRecovery", to: "recovering" },
  { from: "recovering", action: "kernel.export.completeRecovery", to: "idle" },
  { from: "recovering", action: "kernel.export.blockRecovery", to: "blocked" },
  { from: "blocked", action: "kernel.export.retryRecovery", to: "recovering" },
]

const ILLEGAL_CODE = "OPERATION_BUSY"

function findExpected(from: ExportState, action: ExportAction): ExpectedEdge | undefined {
  return EXPECTED_EDGES.find((edge) => edge.from === from && edge.action === action)
}

/** Drives a fresh machine straight to `phase` via a known-legal edge path, or `idle` if none needed. */
function machineAt(phase: ExportState) {
  const m = reatomExportStateMachine()
  if (phase === "idle") return m
  const path: Record<Exclude<ExportState, "idle">, readonly ExportAction[]> = {
    preparing: ["kernel.export.begin"],
    rendering: ["kernel.export.begin", "kernel.export.beginRendering"],
    publishing: ["kernel.export.begin", "kernel.export.beginRendering", "kernel.export.beginPublication"],
    recovering: ["kernel.export.beginRecovery"],
    blocked: ["kernel.export.beginRecovery", "kernel.export.blockRecovery"],
  }
  for (const action of path[phase]) m.apply(action)
  return m
}

describe("reatomExportStateMachine", () => {
  test("starts idle", () => {
    context.start(() => {
      expect(reatomExportStateMachine().phase()).toBe("idle")
    })
  })

  test("the phase atom carries the §6 trace root", () => {
    context.start(() => {
      expect(reatomExportStateMachine().phaseAtom.name).toBe("kernel.export.state")
    })
  })

  test("the hand-counted §7.5 edge total is 12", () => {
    expect(EXPECTED_EDGES.length).toBe(12)
  })

  test("every (state, action) pair matches the §7.5 table exactly", () => {
    context.start(() => {
      for (const from of EXPORT_STATES) {
        for (const action of EXPORT_ACTIONS) {
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

  test("failBeforeIntent from publishing is legal but its journal-proof precondition is the caller's, not the table's", () => {
    // §7.5: "Legal only when journal inspection proves no durable commit intent exists."
    // The table cannot express "only with proof" — it only encodes that the edge exists.
    context.start(() => {
      const m = machineAt("publishing")
      const outcome = m.apply("kernel.export.failBeforeIntent")
      expect(outcome).toEqual({ kind: "changed", from: "publishing", to: "idle" })
    })
  })
})
