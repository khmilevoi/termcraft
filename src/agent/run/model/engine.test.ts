import { describe, expect, spyOn, test } from "bun:test"
import * as errore from "errore"
import type { TurnFence } from "entities/turn"
import type { ProcessTree } from "infrastructure/process"
import { createFakeProcessTree, ProcessTreeError } from "infrastructure/process"
import { startAgentRun } from "./engine"
import type { RunDeps, RunSink } from "../types"

/** Every test gets a real timeout guard so a hang fails loudly instead of stalling the suite. */
const GUARD_MS = 2000

/** Canonical fence value shared by this file's tests. */
const fence: TurnFence = { turnId: "t1", attempt: 0, leaseNonce: "n0" }

function drainedTree(): ProcessTree {
  return {
    adopt: () => null,
    activeProcesses: () => 0,
    terminate: () => null,
    ownershipConfirmed: () => true,
    close: () => {},
    noteAdoptionOutcome: () => {},
  }
}

function deps(overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    processTree: drainedTree(),
    abortController: new AbortController(),
    wait: async () => {},
    confirmTimeoutMs: 10,
    ...overrides,
  }
}

describe("startAgentRun sink contract", () => {
  test("complete() emits finalEvents, closes the stream, and resolves the outcome", async () => {
    const { run } = startAgentRun(
      fence,
      async (sink: RunSink) => {
        sink.emit({ kind: "reasoning", text: "thinking" })
        sink.complete({ kind: "completed", finalText: "done", usage: null, sessionId: "s1" }, [
          { kind: "final", text: "done" },
        ])
      },
      deps(),
    )

    const seen = []
    for await (const e of run.events) seen.push(e.event)

    expect(seen).toEqual([
      { kind: "reasoning", text: "thinking" },
      { kind: "final", text: "done" },
    ])
    expect(await run.outcome).toEqual({ kind: "completed", finalText: "done", usage: null, sessionId: "s1" })
  })

  test("complete() after cancel won drops both the outcome and its finalEvents", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const { run, cancel } = startAgentRun(
      fence,
      async (sink: RunSink) => {
        await gate
        sink.complete({ kind: "completed", finalText: "late", usage: null, sessionId: "s1" }, [
          { kind: "final", text: "late" },
        ])
      },
      deps(),
    )

    await cancel()
    release()

    expect(await run.outcome).toEqual({ kind: "cancelled", exitConfirmed: true })

    const seen = []
    for await (const e of run.events) seen.push(e.event)
    expect(seen).toEqual([])
  })

  test("isTerminal() reports false before cancel and true to the driver once cancel has won", async () => {
    // Collecting into an array (rather than a single reassigned `let`)
    // sidesteps the closure-narrowing pitfall: TypeScript would otherwise
    // narrow a `let observed: boolean | null` read outside the driver
    // closure to the literal `null` from its synchronous initializer, and
    // only a cast (`as boolean | null`) restores the wider type. An array
    // never narrows that way.
    const observed: boolean[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const { cancel } = startAgentRun(
      fence,
      async (sink: RunSink) => {
        // `startAgentRun` invokes the driver synchronously up to its first
        // `await`, so this push always lands before the test below reaches
        // `cancel()` -- no extra gating needed for the ordering to hold.
        observed.push(sink.isTerminal())
        await gate
        observed.push(sink.isTerminal())
      },
      deps(),
    )

    await cancel()
    release()
    await Bun.sleep(0)

    expect(observed).toEqual([false, true])
  })

  test("a driver that throws past its own boundary becomes a backend-error, not a pending outcome", async () => {
    const { run } = startAgentRun(
      fence,
      async () => {
        throw new Error("driver exploded")
      },
      deps(),
    )

    const outcome = await run.outcome
    expect(outcome.kind).toBe("backend-error")
    if (outcome.kind === "backend-error") expect(outcome.message).toContain("driver exploded")
  })

  test("a driver that returns without completing still settles the outcome", async () => {
    const { run } = startAgentRun(fence, async () => {}, deps())
    const outcome = await run.outcome
    expect(outcome.kind).toBe("backend-error")
  })
})

// --- fence stamping ----------------------------------------------------------

test(
  "every emitted event is stamped with the fence the run was started with",
  async () => {
    const { run } = startAgentRun(
      fence,
      async (sink: RunSink) => {
        sink.emit({ kind: "reasoning", text: "a" })
        sink.emit({ kind: "tool", op: "edit", target: "pages/main.tsx" })
        sink.complete({ kind: "completed", finalText: "done", usage: null, sessionId: "s1" })
      },
      deps(),
    )
    const seen = []
    for await (const e of run.events) seen.push(e)
    expect(seen.every((e) => e.fence.turnId === fence.turnId)).toBe(true)
    expect(seen.map((e) => e.event.kind)).toEqual(["reasoning", "tool"])
  },
  GUARD_MS,
)

// --- cancel ladder rungs -----------------------------------------------------

test(
  "cancel confirms exit and resolves cancelled",
  async () => {
    const tree = createFakeProcessTree({ counts: [2], ownershipConfirmed: true })
    const { run, cancel } = startAgentRun(
      fence,
      async () => {
        await new Promise(() => {}) // never completes naturally
      },
      // A larger budget than deps()'s default 10ms: this fake tree's `counts`
      // array only grows once terminate() runs (rung 4), so reaching its
      // confirming `0` needs more than a single poll attempt across both the
      // pre-terminate (rung 2) and post-terminate confirmExit calls.
      deps({ processTree: tree, confirmTimeoutMs: 500 }),
    )
    await cancel()
    expect(await run.outcome).toEqual({ kind: "cancelled", exitConfirmed: true })
  },
  GUARD_MS,
)

test(
  "cancel that cannot confirm exit resolves unconfirmed-exit",
  async () => {
    const tree = createFakeProcessTree({ counts: [2], neverZero: true })
    const { run, cancel } = startAgentRun(
      fence,
      async () => {
        await new Promise(() => {})
      },
      deps({ processTree: tree }),
    )
    await cancel()
    expect(await run.outcome).toEqual({ kind: "unconfirmed-exit" })
  },
  GUARD_MS,
)

test(
  "cancel after natural completion is a safe no-op that does not alter the outcome",
  async () => {
    const { run, cancel } = startAgentRun(
      fence,
      async (sink: RunSink) => {
        sink.complete({ kind: "completed", finalText: "done", usage: null, sessionId: "s1" })
      },
      deps(),
    )
    const first = await run.outcome
    expect(first.kind).toBe("completed")
    await cancel()
    expect(await run.outcome).toEqual(first)
  },
  GUARD_MS,
)

test(
  "a ProcessTreeError from activeProcesses() and terminate() degrades cancel to unconfirmed-exit and is logged",
  async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const tree: ProcessTree = {
        adopt: () => null,
        activeProcesses: () => new ProcessTreeError({ reason: "boom" }),
        terminate: () => new ProcessTreeError({ reason: "boom2" }),
        close: () => {},
        noteAdoptionOutcome: () => {},
        ownershipConfirmed: () => false,
      }
      const { run, cancel } = startAgentRun(
        fence,
        async () => {
          await new Promise(() => {})
        },
        deps({ processTree: tree, confirmTimeoutMs: 250 }),
      )
      await cancel()
      expect(await run.outcome).toEqual({ kind: "unconfirmed-exit" })
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  },
  GUARD_MS,
)

test(
  "two concurrent cancel() calls run the ladder exactly once",
  async () => {
    const inner = createFakeProcessTree({ counts: [2], ownershipConfirmed: true })
    let terminateCalls = 0
    const tree: ProcessTree = {
      adopt: inner.adopt,
      activeProcesses: inner.activeProcesses,
      terminate: () => {
        terminateCalls += 1
        return inner.terminate()
      },
      close: inner.close,
      noteAdoptionOutcome: inner.noteAdoptionOutcome,
      ownershipConfirmed: inner.ownershipConfirmed,
    }
    const { run, cancel } = startAgentRun(
      fence,
      async () => {
        await new Promise(() => {})
      },
      deps({ processTree: tree, confirmTimeoutMs: 500 }),
    )
    await Promise.all([cancel(), cancel()])
    expect(await run.outcome).toEqual({ kind: "cancelled", exitConfirmed: true })
    expect(terminateCalls).toBe(1)
  },
  GUARD_MS,
)

test(
  "outcome settles even when nothing consumes events",
  async () => {
    const { run } = startAgentRun(
      fence,
      async (sink: RunSink) => {
        sink.emit({ kind: "reasoning", text: "a" })
        sink.complete({ kind: "completed", finalText: "done", usage: null, sessionId: "s1" })
      },
      deps(),
    )
    const outcome = await run.outcome
    expect(outcome).toEqual({ kind: "completed", finalText: "done", usage: null, sessionId: "s1" })
  },
  GUARD_MS,
)

// --- cancel() must actually abort the AbortController -----------------------

test(
  "cancel() aborts the run's AbortController with a tagged reason errore.isAbortError detects",
  async () => {
    const abortController = new AbortController()
    const { cancel } = startAgentRun(
      fence,
      async () => {
        await new Promise(() => {})
      },
      deps({ abortController }),
    )
    expect(abortController.signal.aborted).toBe(false)
    await cancel()
    expect(abortController.signal.aborted).toBe(true)
    // Not just "some abort happened" -- the reason must be detectable by
    // errore.isAbortError so downstream `.catch()` boundaries correctly
    // classify it as a cancellation rather than a generic failure.
    expect(errore.isAbortError(abortController.signal.reason)).toBe(true)
  },
  GUARD_MS,
)

// --- natural completion must confirm exit, not assume it --------------------

test(
  "a natural completion whose tree never drains escalates to terminate() and reports unconfirmed-exit instead of completed",
  async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      let terminateCalls = 0
      const tree: ProcessTree = {
        adopt: () => null,
        activeProcesses: () => 1, // never drains
        terminate: () => {
          terminateCalls += 1
          return null
        },
        close: () => {},
        noteAdoptionOutcome: () => {},
        ownershipConfirmed: () => true,
      }
      const { run } = startAgentRun(
        fence,
        async (sink: RunSink) => {
          sink.complete({ kind: "completed", finalText: "done", usage: null, sessionId: "s1" })
        },
        deps({ processTree: tree, confirmTimeoutMs: 150 }),
      )
      expect(await run.outcome).toEqual({ kind: "unconfirmed-exit" })
      expect(terminateCalls).toBe(1)
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  },
  GUARD_MS,
)

test(
  "activeProcesses() reporting zero does not confirm a natural completion when ownership of the tree was never confirmed",
  async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      let terminateCalls = 0
      const tree: ProcessTree = {
        adopt: () => null,
        activeProcesses: () => 0, // reports zero on every read...
        terminate: () => {
          terminateCalls += 1
          return null
        },
        close: () => {},
        noteAdoptionOutcome: () => {},
        ownershipConfirmed: () => false, // ...but nothing was ever adopted
      }
      const { run } = startAgentRun(
        fence,
        async (sink: RunSink) => {
          sink.complete({ kind: "completed", finalText: "done", usage: null, sessionId: "s1" })
        },
        deps({ processTree: tree, confirmTimeoutMs: 150 }),
      )
      expect(await run.outcome).toEqual({ kind: "unconfirmed-exit" })
      expect(terminateCalls).toBe(1)
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  },
  GUARD_MS,
)

// --- outcome must always settle, even if `wait` misbehaves ------------------

test(
  "a rejecting injected wait() during natural completion still lets outcome settle instead of hanging forever",
  async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const rejectingWait = async (): Promise<void> => {
        throw new Error("injected wait() boom")
      }
      const tree = createFakeProcessTree({ counts: [1], neverZero: true, ownershipConfirmed: true })
      const { run } = startAgentRun(
        fence,
        async (sink: RunSink) => {
          sink.complete({ kind: "completed", finalText: "done", usage: null, sessionId: "s1" })
        },
        deps({ processTree: tree, wait: rejectingWait, confirmTimeoutMs: 300 }),
      )
      const outcome = await run.outcome
      expect(outcome.kind).toBe("unconfirmed-exit")
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  },
  GUARD_MS,
)

test(
  "a rejecting injected wait() during cancel still lets cancel() resolve (never throw) and outcome settle",
  async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const rejectingWait = async (): Promise<void> => {
        throw new Error("injected wait() boom")
      }
      const tree = createFakeProcessTree({ counts: [1], neverZero: true, ownershipConfirmed: true })
      const { run, cancel } = startAgentRun(
        fence,
        async () => {
          await new Promise(() => {})
        },
        deps({ processTree: tree, wait: rejectingWait, confirmTimeoutMs: 300 }),
      )
      await expect(cancel()).resolves.toBeUndefined()
      expect((await run.outcome).kind).toBe("unconfirmed-exit")
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  },
  GUARD_MS,
)

// --- the run keeps driving to completion after its reader abandons ----------

test(
  "returning from run.events' iterator (a for-await break) is supported, and the driver still runs outcome to completion",
  async () => {
    const { run } = startAgentRun(
      fence,
      async (sink: RunSink) => {
        sink.emit({ kind: "reasoning", text: "a" })
        sink.emit({ kind: "reasoning", text: "b" })
        sink.complete({ kind: "completed", finalText: "done", usage: null, sessionId: "s1" })
      },
      deps(),
    )

    const iterator = run.events[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)

    // `for await (const e of run.events) { ...; break }` calls `return()` on
    // the iterator per the language spec -- calling it directly here gives
    // the test deterministic control instead of racing the driver's
    // fire-and-forget loop.
    expect(typeof iterator.return).toBe("function")
    await iterator.return?.()

    // The producer is unaffected by the reader being gone: outcome still
    // settles even though further events keep pushing into an EventQueue
    // nobody will ever read again.
    expect((await run.outcome).kind).toBe("completed")
  },
  GUARD_MS,
)

// --- a driver that claims an outcome and then hangs must not wedge outcome
// or cancel() forever (Fix 1: a driver's own IteratorClose can hang after
// `complete()` has already run) -------------------------------------------

test(
  "a driver that claims an outcome and then hangs still resolves outcome, unblocking the downstream tree.close() wiring backend.ts relies on",
  async () => {
    let closeCalls = 0
    const tree: ProcessTree = { ...drainedTree(), close: () => { closeCalls += 1 } }
    const { run } = startAgentRun(
      fence,
      async (sink: RunSink) => {
        sink.complete({ kind: "completed", finalText: "done", usage: null, sessionId: "s1" })
        await new Promise(() => {}) // claims, then never returns -- e.g. a hung IteratorClose
      },
      deps({ processTree: tree }),
    )
    // Mirrors agent/claude/backend/model/backend.ts's
    // `void run.outcome.then((outcome) => { tree.close(); ... })` wiring: if
    // `outcome` never settled, this `.then()` would never fire and the tree's
    // kill-on-close would never arm.
    void run.outcome.then(() => tree.close())

    expect(await run.outcome).toEqual({ kind: "completed", finalText: "done", usage: null, sessionId: "s1" })
    await Bun.sleep(0)
    expect(closeCalls).toBe(1)
  },
  GUARD_MS,
)

test(
  "cancel() resolves against a driver that claimed and then hung, instead of awaiting a never-settling outcome",
  async () => {
    const { cancel } = startAgentRun(
      fence,
      async (sink: RunSink) => {
        sink.complete({ kind: "completed", finalText: "done", usage: null, sessionId: "s1" })
        await new Promise(() => {})
      },
      deps(),
    )
    // cancel() loses the latch race to the already-claimed natural outcome
    // and falls into `await outcomePromise` -- before Fix 1 that promise
    // never settled because `runDriver()` was itself stuck awaiting the
    // hung driver before ever reaching `resolveWithExitConfirm`.
    await expect(cancel()).resolves.toBeUndefined()
  },
  GUARD_MS,
)

test(
  "a driver that hangs without ever claiming an outcome is still cancellable (the driver-return grace race must not interfere)",
  async () => {
    const tree = createFakeProcessTree({ counts: [2], ownershipConfirmed: true })
    const { run, cancel } = startAgentRun(
      fence,
      async () => {
        await new Promise(() => {}) // never calls complete(), never returns
      },
      deps({ processTree: tree, confirmTimeoutMs: 500 }),
    )
    await cancel()
    expect(await run.outcome).toEqual({ kind: "cancelled", exitConfirmed: true })
  },
  GUARD_MS,
)
