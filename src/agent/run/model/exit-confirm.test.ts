import { describe, expect, test } from "bun:test"
import { confirmExit, escalateAndConfirm, POLL_INTERVAL_MS } from "./exit-confirm"

describe("escalateAndConfirm", () => {
  test("terminates the tree, then reports a confirmed exit when the re-poll drains", async () => {
    const calls: string[] = []
    let active = 2
    const tree = {
      adopt: () => null,
      activeProcesses: () => {
        calls.push("poll")
        return active
      },
      terminate: () => {
        calls.push("terminate")
        active = 0
        return null
      },
      ownershipConfirmed: () => true,
      close: () => {},
      noteAdoptionOutcome: () => {},
    }
    const confirmed = await escalateAndConfirm(tree as never, async () => {}, POLL_INTERVAL_MS * 3)
    expect(confirmed).toBe(true)
    expect(calls[0]).toBe("terminate")
  })

  test("reports an unconfirmed exit when the tree never drains after terminate()", async () => {
    const tree = {
      adopt: () => null,
      activeProcesses: () => 3,
      terminate: () => null,
      ownershipConfirmed: () => true,
      close: () => {},
      noteAdoptionOutcome: () => {},
    }
    const confirmed = await escalateAndConfirm(tree as never, async () => {}, POLL_INTERVAL_MS * 2)
    expect(confirmed).toBe(false)
  })

  test("a terminate() that throws is logged and still followed by the re-poll", async () => {
    let polls = 0
    const tree = {
      adopt: () => null,
      activeProcesses: () => {
        polls += 1
        return 0
      },
      terminate: () => {
        throw new Error("boom")
      },
      ownershipConfirmed: () => true,
      close: () => {},
      noteAdoptionOutcome: () => {},
    }
    const confirmed = await escalateAndConfirm(tree as never, async () => {}, POLL_INTERVAL_MS)
    expect(confirmed).toBe(true)
    expect(polls).toBeGreaterThan(0)
  })
})
