import { describe, expect, test } from "bun:test"
import type { HostSessionSpec, Size } from "../../types"
import type { ExportTask, OneShotResult } from "../types"
import { SupervisorError } from "./errors"
import { createExportPool, resolveExportWorkerCount } from "./export-pool"

/** The pool stores `result` opaquely, so a minimal stub stands in for a real one-shot. */
function fakeResult(): OneShotResult {
  return { exitCode: 0 } as unknown as OneShotResult
}

function specFor(size: Size, overrides: Partial<HostSessionSpec> = {}): HostSessionSpec {
  return {
    mode: "export",
    interactionMode: "static",
    pageSlug: "dash",
    sourcePath: "/scratch/candidate.tsx",
    sourceHash: "a".repeat(64),
    kitApiVersion: 1,
    size,
    theme: "dark-default",
    capabilities: { colorDepth: 24 },
    ...overrides,
  }
}

function taskFor(manifestIndex: number, size: Size): ExportTask {
  return { spec: specFor(size), manifestIndex }
}

/** Yield `n` macrotask ticks so scheduling in a fake `runTask` is deterministic. */
async function yieldTicks(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0))
}

describe("resolveExportWorkerCount (§11.4)", () => {
  test("no override → min(4, max(1, floor(cpu/2)))", () => {
    expect(resolveExportWorkerCount(8)).toBe(4)
    expect(resolveExportWorkerCount(2)).toBe(1)
    expect(resolveExportWorkerCount(16)).toBe(4)
    expect(resolveExportWorkerCount(1)).toBe(1)
  })

  test("override is clamped into [1, 8] — zero and unbounded are invalid", () => {
    expect(resolveExportWorkerCount(8, 6)).toBe(6)
    expect(resolveExportWorkerCount(8, 20)).toBe(8)
    expect(resolveExportWorkerCount(8, 0)).toBe(1)
    expect(resolveExportWorkerCount(8, -3)).toBe(1)
  })
})

describe("createExportPool (§11.4)", () => {
  test("empty tasks resolve to []", async () => {
    const pool = createExportPool({ runTask: async () => fakeResult(), cpuCount: 8 })
    const result = await pool.run([])
    expect(result).toEqual([])
  })

  test("no more than `workers` tasks run concurrently; all still complete", async () => {
    let inFlight = 0
    let maxInFlight = 0
    const runTask = async (_task: ExportTask) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 0))
      inFlight -= 1
      return fakeResult()
    }
    const tasks = [0, 1, 2, 3, 4].map((mi) => taskFor(mi, { w: 80, h: 24 }))
    const pool = createExportPool({ runTask, cpuCount: 8, workers: 2 })
    const result = await pool.run(tasks)
    if (result instanceof Error) throw result
    expect(maxInFlight).toBe(2)
    expect(result.length).toBe(5)
  })

  test("outcomes are published in manifest order even when later tasks finish first", async () => {
    // Higher manifestIndex resolves sooner → completion order is REVERSED from manifest order.
    const runTask = async (task: ExportTask) => {
      await yieldTicks(5 - task.manifestIndex)
      return fakeResult()
    }
    // Input is scrambled and includes two tasks that share manifestIndex 2.
    const tasks: ExportTask[] = [
      taskFor(2, { w: 100, h: 24 }),
      taskFor(0, { w: 80, h: 24 }),
      taskFor(2, { w: 80, h: 24 }),
      taskFor(1, { w: 80, h: 24 }),
    ]
    const pool = createExportPool({ runTask, cpuCount: 8, workers: 4 })
    const result = await pool.run(tasks)
    if (result instanceof Error) throw result
    expect(result.map((o) => [o.manifestIndex, o.spec.size.w])).toEqual([
      [0, 80],
      [1, 80],
      [2, 80],
      [2, 100],
    ])
  })

  test("tasks with the same manifestIndex are ordered by (w, h)", async () => {
    const pool = createExportPool({ runTask: async () => fakeResult(), cpuCount: 8, workers: 4 })
    // Input is the reverse of the expected (w, h) order.
    const tasks: ExportTask[] = [
      taskFor(0, { w: 100, h: 24 }),
      taskFor(0, { w: 80, h: 48 }),
      taskFor(0, { w: 80, h: 24 }),
    ]
    const result = await pool.run(tasks)
    if (result instanceof Error) throw result
    expect(result.map((o) => [o.spec.size.w, o.spec.size.h])).toEqual([
      [80, 24],
      [80, 48],
      [100, 24],
    ])
  })

  test("a failing task cancels the pending rest and returns that first failure (all-or-nothing)", async () => {
    let calls = 0
    const boom = new SupervisorError({ code: "DESIGN_RENDER_FAILED", reason: "task 1 blew up" })
    const runTask = async (task: ExportTask) => {
      calls += 1
      await new Promise((r) => setTimeout(r, 0))
      if (task.manifestIndex === 1) return boom
      return fakeResult()
    }
    // workers=1 → strictly ordered: index 0 succeeds, index 1 fails, 2..4 are cancelled.
    const tasks = [0, 1, 2, 3, 4].map((mi) => taskFor(mi, { w: 80, h: 24 }))
    const pool = createExportPool({ runTask, cpuCount: 8, workers: 1 })
    const result = await pool.run(tasks)
    expect(result).toBeInstanceOf(SupervisorError)
    expect(result).toBe(boom)
    expect(calls).toBeLessThan(5)
    expect(calls).toBe(2)
  })
})
