import { expect, spyOn, test } from "bun:test"
import * as errore from "errore"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { ProcessTree } from "infrastructure/process"
import { createFakeProcessTree, ProcessTreeError } from "infrastructure/process"
import type { AgentTask, FencedEvent } from "../types"
import { POLL_INTERVAL_MS, startClaudeRun } from "./agent-run"
import type { ClaudeQuery } from "./query-fn"

/** Every test gets a real timeout guard so a hang fails loudly instead of stalling the suite. */
const GUARD_MS = 2000

const task: AgentTask = {
  fence: { turnId: "t1", attempt: 0, leaseNonce: "n0" },
  workspacePath: "C:\\ws",
  systemPrompt: "sys",
  userMessage: "make the gauge red",
  model: "claude-opus-4-8",
  effort: "high",
  session: { kind: "fresh", seed: [] },
}

/**
 * Deps shared by most tests; individual tests override `queryFn`/`processTree`/`wait`.
 * `ownershipConfirmed: true` mirrors a real spawn that was successfully
 * adopted (query-fn.ts's `noteAdoptionOutcome(true)`) — most tests exercise
 * the "genuinely confirmed exit" path, not the "nothing was ever adopted"
 * edge case, which gets its own dedicated tests below.
 */
function baseDeps(overrides: Partial<Parameters<typeof startClaudeRun>[1]> = {}) {
  return {
    queryFn: () => scriptedQuery([]),
    processTree: createFakeProcessTree({ counts: [0], ownershipConfirmed: true }),
    abortController: new AbortController(),
    wait: async () => {},
    prompt: "prompt",
    options: {},
    ...overrides,
  }
}

function scriptedQuery(messages: SDKMessage[], onInterrupt?: () => void): ClaudeQuery {
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m
    },
    interrupt: async () => onInterrupt?.(),
  }
}

/** A generator that yields `first`, blocks until `release()` is called, then yields `second`. */
function gatedQuery(first: SDKMessage, second: SDKMessage): { query: ClaudeQuery; release: () => void } {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    query: {
      async *[Symbol.asyncIterator]() {
        yield first
        await gate
        yield second
      },
      interrupt: async () => {},
    },
    release,
  }
}

function throwingQuery(messages: SDKMessage[], reason: string): ClaudeQuery {
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m
      throw new Error(reason)
    },
    interrupt: async () => {},
  }
}

const assistant = {
  type: "assistant",
  session_id: "s1",
  uuid: "u1",
  parent_tool_use_id: null,
  message: {
    content: [
      { type: "text", text: "editing" },
      { type: "tool_use", id: "x", name: "Write", input: { file_path: "C:\\ws\\pages\\main.tsx" } },
    ],
  },
} as unknown as SDKMessage

const success = {
  type: "result",
  subtype: "success",
  result: "done",
  session_id: "s1",
  uuid: "u2",
  usage: { input_tokens: 10, output_tokens: 2 },
  modelUsage: {},
  total_cost_usd: 0,
  permission_denials: [],
} as unknown as SDKMessage

test(
  "a successful run streams fenced events then a completed outcome after confirmed exit",
  async () => {
    const { run } = startClaudeRun(
      task,
      baseDeps({
        queryFn: () => scriptedQuery([assistant, success]),
        processTree: createFakeProcessTree({ counts: [1, 0], ownershipConfirmed: true }),
      }),
    )
    const got: FencedEvent[] = []
    for await (const ev of run.events) got.push(ev)
    expect(got.every((e) => e.fence.turnId === "t1")).toBe(true)
    expect(got.map((e) => e.event.kind)).toEqual(["reasoning", "tool", "final", "usage"])
    const outcome = await run.outcome
    // DEVIATION from the plan's literal test body: the plan scripted a success
    // result with usage:{input_tokens:10,output_tokens:2}, modelUsage:{} (so
    // deriveUsage returns a non-null TokenUsage — confirmed against
    // normalize.ts/normalize.test.ts) yet asserted `usage: null` on the
    // outcome while asserting a `usage` event WAS emitted from that same
    // message — a genuine contradiction. Decision (per task instructions):
    // outcome.usage carries the SAME derived TokenUsage the usage event
    // carries; it is null only when deriveUsage genuinely returns null.
    expect(outcome).toEqual({
      kind: "completed",
      finalText: "done",
      usage: { inputTokens: 10, outputTokens: 2, contextPercent: null },
      sessionId: "s1",
    })
  },
  GUARD_MS,
)

test(
  "events after the terminal result are suppressed (late-event drop)",
  async () => {
    const late = { ...assistant, uuid: "u3" } as unknown as SDKMessage
    const { run } = startClaudeRun(
      task,
      baseDeps({
        queryFn: () => scriptedQuery([success, late]),
        processTree: createFakeProcessTree({ counts: [0], ownershipConfirmed: true }),
      }),
    )
    const kinds: string[] = []
    for await (const ev of run.events) kinds.push(ev.event.kind)
    // DEVIATION from the plan's literal test body: the plan asserted
    // `["final"]`, silently assuming this fixture's `usage` derives to null.
    // It does not (same fixture as the test above) — normalizeMessage emits
    // final+usage together for one "result" message, and message-level
    // late-event-drop suppresses only messages AFTER the terminal one (the
    // `late` assistant message here), not part of the terminal message's own
    // event set. Corrected to match the actual normalizeMessage output.
    expect(kinds).toEqual(["final", "usage"])
  },
  GUARD_MS,
)

test(
  "cancel confirms exit and resolves cancelled",
  async () => {
    const tree = createFakeProcessTree({ counts: [2], ownershipConfirmed: true })
    const { run, cancel } = startClaudeRun(
      task,
      baseDeps({ queryFn: () => scriptedQuery([assistant]), processTree: tree }),
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
    const { run, cancel } = startClaudeRun(
      task,
      baseDeps({ queryFn: () => scriptedQuery([assistant]), processTree: tree }),
    )
    await cancel()
    expect(await run.outcome).toEqual({ kind: "unconfirmed-exit" })
  },
  GUARD_MS,
)

test(
  "an SDK generator throw becomes a fenced terminal error event and a backend-error outcome",
  async () => {
    const { run } = startClaudeRun(
      task,
      baseDeps({ queryFn: () => throwingQuery([assistant], "stream exploded") }),
    )
    const got: FencedEvent[] = []
    for await (const ev of run.events) got.push(ev)
    expect(got.every((e) => e.fence.turnId === "t1")).toBe(true)
    expect(got.map((e) => e.event.kind)).toEqual(["reasoning", "tool", "error"])
    const outcome = await run.outcome
    expect(outcome.kind).toBe("backend-error")
    if (outcome.kind !== "backend-error") throw new Error("unreachable")
    expect(outcome.message).toContain("stream exploded")
    // sessionId falls back to the last session_id seen before the throw (from
    // the `assistant` message) since no `result` message ever arrived.
    expect(outcome.sessionId).toBe("s1")
  },
  GUARD_MS,
)

test(
  "a stream that ends without ever yielding a result message still resolves outcome instead of hanging",
  async () => {
    const { run } = startClaudeRun(task, baseDeps({ queryFn: () => scriptedQuery([assistant]) }))
    const outcome = await run.outcome
    expect(outcome.kind).toBe("backend-error")
  },
  GUARD_MS,
)

test(
  "cancel fired before any event arrives drops all events and resolves cancelled",
  async () => {
    const { run, cancel } = startClaudeRun(
      task,
      baseDeps({ queryFn: () => scriptedQuery([assistant, success]) }),
    )
    await cancel()
    const events: FencedEvent[] = []
    for await (const ev of run.events) events.push(ev)
    expect(events).toEqual([])
    expect(await run.outcome).toEqual({ kind: "cancelled", exitConfirmed: true })
  },
  GUARD_MS,
)

test(
  "cancel after natural completion is a safe no-op that does not alter the outcome",
  async () => {
    const { run, cancel } = startClaudeRun(task, baseDeps({ queryFn: () => scriptedQuery([success]) }))
    const first = await run.outcome
    expect(first.kind).toBe("completed")
    await cancel()
    expect(await run.outcome).toEqual(first)
  },
  GUARD_MS,
)

test(
  "cancel racing an in-flight stream drops the still-pending terminal message",
  async () => {
    const { query, release } = gatedQuery(assistant, success)
    const { run, cancel } = startClaudeRun(task, baseDeps({ queryFn: () => query }))

    const iterator = run.events[Symbol.asyncIterator]()
    const e1 = await iterator.next()
    const e2 = await iterator.next()
    expect(e1.done).toBe(false)
    expect(e2.done).toBe(false)
    expect([e1.value?.event.kind, e2.value?.event.kind]).toEqual(["reasoning", "tool"])

    await cancel()
    release() // let the generator continue — its `success` message must be dropped

    const e3 = await iterator.next()
    expect(e3.done).toBe(true)
    expect(await run.outcome).toEqual({ kind: "cancelled", exitConfirmed: true })
  },
  GUARD_MS,
)

test(
  "a ProcessTreeError from activeProcesses() and terminate() degrades to unconfirmed-exit and is logged",
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
      const { run, cancel } = startClaudeRun(
        task,
        baseDeps({ queryFn: () => scriptedQuery([assistant]), processTree: tree, confirmTimeoutMs: 250 }),
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
    const { run, cancel } = startClaudeRun(
      task,
      baseDeps({ queryFn: () => scriptedQuery([assistant]), processTree: tree }),
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
    const { run } = startClaudeRun(
      task,
      baseDeps({
        queryFn: () => scriptedQuery([assistant, success]),
        processTree: createFakeProcessTree({ counts: [0], ownershipConfirmed: true }),
      }),
    )
    const outcome = await run.outcome
    expect(outcome).toEqual({
      kind: "completed",
      finalText: "done",
      usage: { inputTokens: 10, outputTokens: 2, contextPercent: null },
      sessionId: "s1",
    })
  },
  GUARD_MS,
)

// --- finding [5]: cancel() must actually abort the AbortController ---------

test(
  "cancel() aborts the run's AbortController with a tagged reason errore.isAbortError detects",
  async () => {
    const abortController = new AbortController()
    const { cancel } = startClaudeRun(
      task,
      baseDeps({ queryFn: () => scriptedQuery([assistant]), abortController }),
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

// --- finding [8] / [16]: the injected `wait` seam is timed and asserted ----

test(
  "the exit-confirmation poll spaces non-final attempts with the injected wait at POLL_INTERVAL_MS",
  async () => {
    const waitCalls: number[] = []
    const { run } = startClaudeRun(
      task,
      baseDeps({
        // Natural completion against a tree that only reaches zero on its
        // third read -- covers finding [16] (completion vs. a tree that
        // does not immediately report zero) in the same test.
        queryFn: () => scriptedQuery([success]),
        processTree: createFakeProcessTree({ counts: [1, 1, 0], ownershipConfirmed: true }),
        wait: async (ms) => {
          waitCalls.push(ms)
        },
      }),
    )
    const outcome = await run.outcome
    expect(outcome.kind).toBe("completed")
    // Two non-zero reads precede the confirming zero -> wait is called
    // exactly twice, each time with the nominal poll interval.
    expect(waitCalls).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS])
  },
  GUARD_MS,
)

// --- finding [24]/[29]: natural completion must confirm exit, not assume it ---

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
      const { run } = startClaudeRun(
        task,
        baseDeps({
          queryFn: () => scriptedQuery([success]),
          processTree: tree,
          confirmTimeoutMs: 150,
        }),
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
        ownershipConfirmed: () => false, // ...but nothing was ever adopted (finding [22])
      }
      const { run } = startClaudeRun(
        task,
        baseDeps({
          queryFn: () => scriptedQuery([success]),
          processTree: tree,
          confirmTimeoutMs: 150,
        }),
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

// --- finding [25]: outcome must always settle, even if `wait` misbehaves ---

test(
  "a rejecting injected wait() during natural completion still lets outcome settle instead of hanging forever",
  async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const rejectingWait = async (): Promise<void> => {
        throw new Error("injected wait() boom")
      }
      const tree = createFakeProcessTree({ counts: [1], neverZero: true, ownershipConfirmed: true })
      const { run } = startClaudeRun(
        task,
        baseDeps({
          queryFn: () => scriptedQuery([success]),
          processTree: tree,
          wait: rejectingWait,
          confirmTimeoutMs: 300,
        }),
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
      const { run, cancel } = startClaudeRun(
        task,
        baseDeps({
          queryFn: () => scriptedQuery([assistant]),
          processTree: tree,
          wait: rejectingWait,
          confirmTimeoutMs: 300,
        }),
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

// --- finding [27]: the events iterator must release on break and refuse a second reader ---

test(
  "returning from run.events' iterator (a for-await break) is supported, and driveQuery still runs outcome to completion",
  async () => {
    const manyMessages = [assistant, { ...assistant, uuid: "u4" } as unknown as SDKMessage, success]
    const { run } = startClaudeRun(task, baseDeps({ queryFn: () => scriptedQuery(manyMessages) }))

    const iterator = run.events[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)

    // `for await (const e of run.events) { ...; break }` calls `return()` on
    // the iterator per the language spec -- calling it directly here gives
    // the test deterministic control instead of racing driveQuery's
    // fire-and-forget loop.
    expect(typeof iterator.return).toBe("function")
    await iterator.return?.()

    // The producer is unaffected by the reader being gone: outcome still
    // settles even though further messages keep pushing into an EventQueue
    // nobody will ever read again.
    expect((await run.outcome).kind).toBe("completed")
  },
  GUARD_MS,
)

test(
  "a second concurrent iteration of run.events fails loudly instead of silently deadlocking",
  async () => {
    const { run } = startClaudeRun(task, baseDeps({ queryFn: () => scriptedQuery([assistant, success]) }))

    const first = run.events[Symbol.asyncIterator]()
    await first.next() // claim the sole reader slot without finishing iteration

    const second = run.events[Symbol.asyncIterator]()
    await expect(second.next()).rejects.toThrow()
  },
  GUARD_MS,
)
