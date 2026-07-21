import { describe, expect, test } from "bun:test"
import { context } from "@reatom/core"

import { reatomPreviewStateMachine, type PreviewAction, type PreviewState } from "./preview-machine"

/**
 * kernel-command-contract §7.6, §13.1.
 *
 * `PREVIEW_STATES`, `PREVIEW_ACTIONS`, and `EXPECTED_EDGES` are transcribed BY HAND from
 * §7.6's table a second time, independently of `preview-machine.ts`'s own
 * `PREVIEW_TRANSITION_TABLE` — see `export-machine.test.ts` for why iterating the
 * implementation's own table would not discriminate.
 *
 * Two same-state rows need special care:
 * - `live | setMode, setTweak, resize, setThemeCapabilities | live` is FOUR separate
 *   actions, each a real revision-changing update (they mutate authoritative mode/tweak/
 *   geometry/theme state even though `PreviewState` itself stays `"live"`).
 * - `live | forwardInput, queryGeometry | live` is TWO separate guarded service actions
 *   that §7.6 says "do not bump `stateRevision` unless authoritative Kernel state
 *   changes" — modeled as explicit no-ops here.
 */

const PREVIEW_STATES: readonly PreviewState[] = [
  "disabled",
  "idle",
  "starting",
  "live",
  "switching",
  "failed",
  "circuit-open",
]

const PREVIEW_ACTIONS: readonly PreviewAction[] = [
  "kernel.preview.enable",
  "kernel.preview.beginStart",
  "kernel.preview.beginSwitch",
  "kernel.preview.sessionReady",
  "kernel.preview.sessionFailed",
  "kernel.preview.openCircuit",
  "kernel.preview.retryCircuit",
  "kernel.preview.setMode",
  "kernel.preview.setTweak",
  "kernel.preview.resize",
  "kernel.preview.setThemeCapabilities",
  "kernel.preview.forwardInput",
  "kernel.preview.queryGeometry",
  "kernel.preview.disable",
]

interface ExpectedEdge {
  readonly from: PreviewState
  readonly action: PreviewAction
  readonly to: PreviewState
  readonly noOp?: boolean
}

const OPEN_STATES: readonly PreviewState[] = ["idle", "starting", "live", "switching", "failed", "circuit-open"]

const EXPECTED_EDGES: readonly ExpectedEdge[] = [
  { from: "disabled", action: "kernel.preview.enable", to: "idle" },
  { from: "idle", action: "kernel.preview.beginStart", to: "starting" },
  { from: "failed", action: "kernel.preview.beginStart", to: "starting" },
  { from: "live", action: "kernel.preview.beginSwitch", to: "switching" },
  { from: "failed", action: "kernel.preview.beginSwitch", to: "switching" },
  { from: "starting", action: "kernel.preview.sessionReady", to: "live" },
  { from: "switching", action: "kernel.preview.sessionReady", to: "live" },
  { from: "starting", action: "kernel.preview.sessionFailed", to: "failed" },
  { from: "switching", action: "kernel.preview.sessionFailed", to: "failed" },
  { from: "live", action: "kernel.preview.sessionFailed", to: "failed" },
  { from: "failed", action: "kernel.preview.openCircuit", to: "circuit-open" },
  { from: "circuit-open", action: "kernel.preview.retryCircuit", to: "starting" },
  { from: "live", action: "kernel.preview.setMode", to: "live" },
  { from: "live", action: "kernel.preview.setTweak", to: "live" },
  { from: "live", action: "kernel.preview.resize", to: "live" },
  { from: "live", action: "kernel.preview.setThemeCapabilities", to: "live" },
  { from: "live", action: "kernel.preview.forwardInput", to: "live", noOp: true },
  { from: "live", action: "kernel.preview.queryGeometry", to: "live", noOp: true },
  ...OPEN_STATES.map((from) => ({ from, action: "kernel.preview.disable" as const, to: "disabled" as const })),
]

const ILLEGAL_CODE = "OPERATION_BUSY"

function findExpected(from: PreviewState, action: PreviewAction): ExpectedEdge | undefined {
  return EXPECTED_EDGES.find((edge) => edge.from === from && edge.action === action)
}

/** Drives a fresh machine straight to `phase` via a known-legal edge path. */
function machineAt(phase: PreviewState) {
  const m = reatomPreviewStateMachine()
  if (phase === "disabled") return m
  const path: Record<Exclude<PreviewState, "disabled">, readonly PreviewAction[]> = {
    idle: ["kernel.preview.enable"],
    starting: ["kernel.preview.enable", "kernel.preview.beginStart"],
    live: ["kernel.preview.enable", "kernel.preview.beginStart", "kernel.preview.sessionReady"],
    switching: [
      "kernel.preview.enable",
      "kernel.preview.beginStart",
      "kernel.preview.sessionReady",
      "kernel.preview.beginSwitch",
    ],
    failed: ["kernel.preview.enable", "kernel.preview.beginStart", "kernel.preview.sessionFailed"],
    "circuit-open": [
      "kernel.preview.enable",
      "kernel.preview.beginStart",
      "kernel.preview.sessionFailed",
      "kernel.preview.openCircuit",
    ],
  }
  for (const action of path[phase]) m.apply(action)
  return m
}

describe("reatomPreviewStateMachine", () => {
  test("starts disabled", () => {
    context.start(() => {
      expect(reatomPreviewStateMachine().phase()).toBe("disabled")
    })
  })

  test("the phase atom carries the §6 trace root", () => {
    context.start(() => {
      expect(reatomPreviewStateMachine().phaseAtom.name).toBe("kernel.preview.state")
    })
  })

  test("the hand-counted §7.6 edge total is 24", () => {
    expect(EXPECTED_EDGES.length).toBe(24)
  })

  test("every (state, action) pair matches the §7.6 table exactly", () => {
    context.start(() => {
      for (const from of PREVIEW_STATES) {
        for (const action of PREVIEW_ACTIONS) {
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

  test("setMode is a real change while forwardInput is an explicit no-op, both from live to live", () => {
    // §7.6: the tweak/mode/resize/theme quartet mutates authoritative state even though
    // PreviewState itself stays "live"; forwardInput/queryGeometry explicitly do not
    // bump stateRevision unless authoritative state changes.
    context.start(() => {
      const setMode = machineAt("live").apply("kernel.preview.setMode")
      expect(setMode.kind).toBe("changed")

      const forwardInput = machineAt("live").apply("kernel.preview.forwardInput")
      expect(forwardInput.kind).toBe("no-op")
    })
  })

  test("disable is legal from every non-disabled state and illegal from disabled itself", () => {
    context.start(() => {
      for (const from of OPEN_STATES) {
        expect(machineAt(from).apply("kernel.preview.disable").kind).toBe("changed")
      }
      const alreadyDisabled = reatomPreviewStateMachine()
      expect(alreadyDisabled.apply("kernel.preview.disable")).toEqual({
        kind: "illegal",
        code: ILLEGAL_CODE,
        from: "disabled",
        action: "kernel.preview.disable",
      })
    })
  })
})
