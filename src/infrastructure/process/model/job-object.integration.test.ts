import { expect, test } from "bun:test"
import type { ProcessTree } from "../types"
import { ProcessTreeError } from "../types"
import { createJobObjectTree } from "./job-object"

const win = process.platform === "win32"

/**
 * Polls `activeProcesses()` until it reads 0 or the timeout elapses,
 * returning the last read (Spike I: confirmation is a genuine OS read, not a
 * PID-liveness inference — but the read still needs a couple of polls of
 * slack around the kill call in a real test run).
 */
async function pollUntilZero(tree: ProcessTree, timeoutMs = 5000): Promise<ProcessTreeError | number> {
  const start = Date.now()
  let last: ProcessTreeError | number = tree.activeProcesses()
  while (Date.now() - start < timeoutMs) {
    last = tree.activeProcesses()
    if (last === 0) return last
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return last
}

test.if(win)("adopts a real child and confirms 0 active after terminate (Spike I)", async () => {
  const tree = createJobObjectTree()
  expect(tree).not.toBeInstanceOf(Error)
  const t = tree as ProcessTree

  const child = Bun.spawn({ cmd: ["bun", "-e", "setInterval(()=>{},1000)"] })
  // Prove the child actually spawned before trusting anything downstream.
  expect(typeof child.pid).toBe("number")
  expect(child.pid).toBeGreaterThan(0)
  expect(child.exitCode).toBeNull()
  expect(child.killed).toBe(false)

  expect(t.adopt(child.pid)).toBeNull()

  // Adopt-then-reread membership check: AssignProcessToJobObject races the
  // child spawning its own descendants (no CREATE_SUSPENDED is reachable
  // from Bun's spawn — Spike I FINDINGS.md "Ordering-hazard result"), so
  // membership must be confirmed by re-reading activeProcesses(), not
  // assumed from adopt()'s success alone.
  const activeAfterAdopt = t.activeProcesses()
  expect(activeAfterAdopt).not.toBeInstanceOf(Error)
  expect(activeAfterAdopt as number).toBeGreaterThanOrEqual(1)

  expect(t.terminate()).toBeNull()

  // Spike I: ActiveProcesses reached 0 within 0-1ms of TerminateJobObject in
  // every trial; poll briefly rather than asserting a single synchronous read.
  const after = await pollUntilZero(t)
  expect(after).not.toBeInstanceOf(Error)
  expect(after).toBe(0)

  // Cross-check against the real OS process, not just the job object's own
  // count: the child must have actually died, with the exit code
  // TerminateJobObject was called with.
  const exitCode = await child.exited
  expect(exitCode).toBe(1)
  expect(child.killed).toBe(true)
  expect(child.exitCode).toBe(1)

  t.close()
})

test.if(win)("createJobObjectTree returns independent trees that do not share job membership", async () => {
  const treeA = createJobObjectTree()
  const treeB = createJobObjectTree()
  expect(treeA).not.toBeInstanceOf(Error)
  expect(treeB).not.toBeInstanceOf(Error)
  const a = treeA as ProcessTree
  const b = treeB as ProcessTree

  const child = Bun.spawn({ cmd: ["bun", "-e", "setInterval(()=>{},1000)"] })
  expect(a.adopt(child.pid)).toBeNull()

  const activeInA = a.activeProcesses()
  const activeInB = b.activeProcesses()
  expect(activeInA).not.toBeInstanceOf(Error)
  expect(activeInB).not.toBeInstanceOf(Error)
  expect(activeInA as number).toBeGreaterThanOrEqual(1)
  expect(activeInB as number).toBe(0)

  expect(a.terminate()).toBeNull()
  const exitCode = await child.exited
  expect(exitCode).toBe(1)
  a.close()
  b.close()
})
