import { describe, expect, test } from "bun:test"
import type { AgentInfo } from "agent/types"
import type { ProcessTree } from "infrastructure/process"
import type { HealthProbeReader } from "../types"
import { runHealthProbe } from "./probe"

// No `wait` here deliberately: non-deadline tests below run against the real
// `defaultWait` (20s, never reached), so the deadline-vs-read race is never
// decided by microtask count. Tests that deliberately exercise the deadline
// set `wait: async () => {}` inline instead of relying on this default.
const deps = { abortController: new AbortController(), processTree: null }

describe("runHealthProbe classification", () => {
  test("passes a vendor verdict through unchanged", async () => {
    const verdict = { backendId: "x", health: { status: "ready" as const }, account: null }
    expect(await runHealthProbe("x", async () => verdict, deps)).toEqual(verdict)
  })

  test("a clean close with no verdict is not-logged-in, never ready, and reports account: null", async () => {
    const info = await runHealthProbe("x", async () => null, deps)
    expect(info.health).toEqual({ status: "not-logged-in" })
    expect(info.account).toBeNull()
  })

  test("a spawn/ENOENT failure is not-installed, with account: null", async () => {
    const info = await runHealthProbe(
      "x",
      async () => {
        throw new Error("spawn claude ENOENT")
      },
      deps,
    )
    expect(info.health).toEqual({ status: "not-installed" })
    expect(info.account).toBeNull()
  })

  test("any other stream failure is not-logged-in", async () => {
    const info = await runHealthProbe(
      "x",
      async () => {
        throw new Error("socket reset")
      },
      deps,
    )
    expect(info.health).toEqual({ status: "not-logged-in" })
  })

  test("a read that rejects with an abort-flavoured error before any verdict is classified is not-logged-in, never ready, with no account", async () => {
    const info = await runHealthProbe(
      "x",
      async () => {
        throw new DOMException("The operation was aborted.", "AbortError")
      },
      deps,
    )
    expect(info.health).toEqual({ status: "not-logged-in" })
    expect(info.account).toBeNull()
  })

  test("a reader that throws synchronously (not just rejects) does not escape runHealthProbe as a rejection, and still closes the process tree", async () => {
    let closed = 0
    const tree = { close: () => { closed += 1 } } as unknown as ProcessTree
    const syncThrow = (() => {
      throw new Error("sync boom")
    }) as HealthProbeReader
    const info = await runHealthProbe("x", syncThrow, { ...deps, processTree: tree })
    expect(info.health).toEqual({ status: "not-logged-in" })
    expect(closed).toBe(1)
  })

  test("closes the process tree on every path", async () => {
    let closed = 0
    const tree = { close: () => { closed += 1 } } as unknown as ProcessTree
    await runHealthProbe("x", async () => null, { ...deps, processTree: tree })
    await runHealthProbe(
      "x",
      async () => {
        throw new Error("boom")
      },
      { ...deps, processTree: tree },
    )
    expect(closed).toBe(2)
  })
})

// --- The shared classification/close/deadline outcomes are generic to any
// backend, so they are asserted here directly against a fake
// HealthProbeReader with no SDK vocabulary involved. ---

describe("runHealthProbe: process tree close on the remaining paths", () => {
  test("closes the process tree once when a vendor verdict passes through", async () => {
    let closed = 0
    const tree = { close: () => { closed += 1 } } as unknown as ProcessTree
    const verdict = { backendId: "x", health: { status: "ready" as const }, account: null }
    await runHealthProbe("x", async () => verdict, { ...deps, processTree: tree })
    expect(closed).toBe(1)
  })

  test("closes the process tree once when the deadline elapses before the read settles, reporting not-logged-in with no account", async () => {
    let closed = 0
    const tree = { close: () => { closed += 1 } } as unknown as ProcessTree
    const info = await runHealthProbe(
      "x",
      () => new Promise<AgentInfo | null>(() => {}), // never resolves — models a stalled vendor reader
      { ...deps, wait: async () => {}, deadlineMs: 5, processTree: tree },
    )
    expect(info.health).toEqual({ status: "not-logged-in" })
    expect(info.account).toBeNull()
    expect(closed).toBe(1)
  })
})
