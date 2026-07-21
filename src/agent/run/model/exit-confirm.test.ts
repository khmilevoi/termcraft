import { describe, expect, spyOn, test } from "bun:test"
import { ProcessTreeError } from "infrastructure/process"
import { confirmExit, escalateAndConfirm, POLL_INTERVAL_MS } from "./exit-confirm"

// --- confirmExit's own polling rules ----------------------------------------

describe("confirmExit", () => {
  test("spaces non-final polling attempts with the injected wait at POLL_INTERVAL_MS until the tree drains", async () => {
    const waitCalls: number[] = []
    let i = 0
    const counts = [1, 1, 0]
    const tree = {
      adopt: () => null,
      activeProcesses: () => {
        const value = counts[Math.min(i, counts.length - 1)] ?? 0
        if (i < counts.length - 1) i += 1
        return value
      },
      terminate: () => null,
      ownershipConfirmed: () => true,
      close: () => {},
      noteAdoptionOutcome: () => {},
    }
    const confirmed = await confirmExit(
      tree as never,
      async (ms) => {
        waitCalls.push(ms)
      },
      1000,
    )
    expect(confirmed).toBe(true)
    // Two non-zero reads precede the confirming zero -> wait is called
    // exactly twice, each time with the nominal poll interval.
    expect(waitCalls).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS])
  })

  test("returns false once its attempt budget is exhausted without the tree ever draining", async () => {
    const tree = {
      adopt: () => null,
      activeProcesses: () => 1, // never drains
      terminate: () => null,
      ownershipConfirmed: () => true,
      close: () => {},
      noteAdoptionOutcome: () => {},
    }
    const confirmed = await confirmExit(tree as never, async () => {}, POLL_INTERVAL_MS * 2)
    expect(confirmed).toBe(false)
  })

  test("does not treat a zero read as a confirmed exit when ownership of the tree was never confirmed", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const tree = {
        adopt: () => null,
        activeProcesses: () => 0, // reports zero on every read...
        terminate: () => null,
        ownershipConfirmed: () => false, // ...but nothing was ever adopted
        close: () => {},
        noteAdoptionOutcome: () => {},
      }
      const confirmed = await confirmExit(tree as never, async () => {}, POLL_INTERVAL_MS)
      expect(confirmed).toBe(false)
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("tolerates a ProcessTreeError from activeProcesses(), logging it and continuing to poll within budget", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      let calls = 0
      const tree = {
        adopt: () => null,
        activeProcesses: () => {
          calls += 1
          if (calls === 1) return new ProcessTreeError({ reason: "transient boom" })
          return 0
        },
        terminate: () => null,
        ownershipConfirmed: () => true,
        close: () => {},
        noteAdoptionOutcome: () => {},
      }
      const confirmed = await confirmExit(tree as never, async () => {}, POLL_INTERVAL_MS * 3)
      expect(confirmed).toBe(true)
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

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
