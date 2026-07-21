import { describe, expect, test } from "bun:test"
import type { AgentInfo } from "agent/types"
import { runHealthProbe } from "./probe"

const deps = { abortController: new AbortController(), processTree: null, wait: async () => {}, deadlineMs: 10 }

describe("runHealthProbe classification", () => {
  test("passes a vendor verdict through unchanged", async () => {
    const verdict = { backendId: "x", health: { status: "ready" as const }, account: null }
    expect(await runHealthProbe("x", async () => verdict, deps)).toEqual(verdict)
  })

  test("a clean close with no verdict is not-logged-in, never ready", async () => {
    const info = await runHealthProbe("x", async () => null, deps)
    expect(info.health).toEqual({ status: "not-logged-in" })
  })

  test("a spawn/ENOENT failure is not-installed", async () => {
    const info = await runHealthProbe(
      "x",
      async () => {
        throw new Error("spawn claude ENOENT")
      },
      deps,
    )
    expect(info.health).toEqual({ status: "not-installed" })
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

  test("closes the process tree on every path", async () => {
    let closed = 0
    const tree = { close: () => { closed += 1 } } as never
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

// --- redistributed from claude/model/health.test.ts (pre-split): the shared
// classification/close/deadline outcomes exercised there via Claude-shaped
// fakes are generic to any backend, so they are re-asserted here directly
// against a fake HealthProbeReader with no SDK vocabulary involved. ---

describe("runHealthProbe: account is null on every non-passthrough classification", () => {
  test("a clean close with no verdict reports account: null", async () => {
    const info = await runHealthProbe("x", async () => null, deps)
    expect(info.account).toBeNull()
  })

  test("a spawn/ENOENT failure reports account: null", async () => {
    const info = await runHealthProbe(
      "x",
      async () => {
        throw new Error("spawn claude ENOENT")
      },
      deps,
    )
    expect(info.account).toBeNull()
  })
})

describe("runHealthProbe: process tree close on the remaining paths", () => {
  test("closes the process tree once when a vendor verdict passes through", async () => {
    let closed = 0
    const tree = { close: () => { closed += 1 } } as never
    const verdict = { backendId: "x", health: { status: "ready" as const }, account: null }
    await runHealthProbe("x", async () => verdict, { ...deps, processTree: tree })
    expect(closed).toBe(1)
  })

  test("closes the process tree once when the deadline elapses before the read settles", async () => {
    let closed = 0
    const tree = { close: () => { closed += 1 } } as never
    const info = await runHealthProbe(
      "x",
      () => new Promise<AgentInfo | null>(() => {}), // never resolves — models a stalled vendor reader
      { ...deps, deadlineMs: 5, processTree: tree },
    )
    expect(info.health).toEqual({ status: "not-logged-in" })
    expect(closed).toBe(1)
  })
})

describe("runHealthProbe: the probe deadline never reports ready on ambiguity", () => {
  test("a read that never settles within the deadline is not-logged-in, with no account", async () => {
    const info = await runHealthProbe(
      "x",
      () => new Promise<AgentInfo | null>(() => {}), // never resolves — models a stalled vendor reader
      { ...deps, deadlineMs: 5 },
    )
    expect(info.health).toEqual({ status: "not-logged-in" })
    expect(info.account).toBeNull()
  })
})
