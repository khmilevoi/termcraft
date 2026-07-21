import { describe, expect, test } from "bun:test"
import { context } from "@reatom/core"

import { createStateMachine, type TransitionTable } from "./state-machine"

type Phase = "idle" | "running" | "done"
type Act = "start" | "finish" | "reset"

const TABLE: TransitionTable<Phase, Act> = {
  start: [{ from: "idle", to: "running" }],
  finish: [{ from: "running", to: "done" }],
  reset: [
    { from: "done", to: "idle" },
    // A same-state legal edge: §13.1 requires these be classified as a real
    // revision-changing update or an explicit no-op.
    { from: "idle", to: "idle", noOp: true },
  ],
}

function machine() {
  return createStateMachine<Phase, Act>({
    traceRoot: "kernel.test",
    initial: "idle",
    table: TABLE,
    illegalCode: "OPERATION_BUSY",
  })
}

describe("createStateMachine", () => {
  test("starts in its initial phase", () => {
    context.start(() => {
      expect(machine().phase()).toBe("idle")
    })
  })

  test("a listed edge moves to its target and reports a state change", () => {
    context.start(() => {
      const m = machine()
      const outcome = m.apply("start")
      expect(outcome.kind).toBe("changed")
      expect(m.phase()).toBe("running")
    })
  })

  test("an unlisted (source, action) pair is rejected with the table's code and changes nothing", () => {
    context.start(() => {
      const m = machine()
      const outcome = m.apply("finish") // illegal from "idle"
      expect(outcome).toEqual({ kind: "illegal", code: "OPERATION_BUSY", from: "idle", action: "finish" })
      expect(m.phase()).toBe("idle")
    })
  })

  test("a same-state edge marked noOp reports no-op rather than a change", () => {
    context.start(() => {
      const m = machine()
      const outcome = m.apply("reset")
      expect(outcome.kind).toBe("no-op")
      expect(m.phase()).toBe("idle")
    })
  })

  test("one action may be legal from several sources", () => {
    context.start(() => {
      const m = machine()
      m.apply("start")
      m.apply("finish")
      expect(m.phase()).toBe("done")
      expect(m.apply("reset").kind).toBe("changed")
      expect(m.phase()).toBe("idle")
    })
  })

  test("the phase atom carries the hierarchical trace name the contract fixes", () => {
    context.start(() => {
      // §6 fixes the seven trace roots as `kernel.<domain>.state`.
      expect(machine().phaseAtom.name).toBe("kernel.test.state")
    })
  })

  test("two machines built from the same table are independent", () => {
    context.start(() => {
      const a = machine()
      const b = machine()
      a.apply("start")
      expect(a.phase()).toBe("running")
      expect(b.phase()).toBe("idle")
    })
  })

  test("canApply reports legality without moving the machine", () => {
    context.start(() => {
      const m = machine()
      expect(m.canApply("start")).toBe(true)
      expect(m.canApply("finish")).toBe(false)
      expect(m.phase()).toBe("idle")
    })
  })

  test("every action in the table is reachable from at least one declared source", () => {
    // Guards against a table row whose `from` list is empty — an action that exists in
    // the union but can never fire, i.e. a transition the spec fixes and the code drops.
    for (const [act, edges] of Object.entries(TABLE)) {
      expect(edges.length, `action "${act}" has no source states`).toBeGreaterThan(0)
    }
  })
})
