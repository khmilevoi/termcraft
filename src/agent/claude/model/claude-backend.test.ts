import { expect, spyOn, test } from "bun:test"
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { ProcessTree, ProcessTreeFactory } from "infrastructure/process"
import { createFakeProcessTree, ProcessTreeError } from "infrastructure/process"
import { deriveSessionScope } from "agent/model/session-scope"
import type { AgentRun, AgentTask, FencedEvent } from "agent/types"
import type { ClaudeQuery, ClaudeQueryFn } from "../types"
import { CLAUDE_BACKEND_ID } from "./backend-id"
import { createClaudeBackend } from "./claude-backend"
import { claudeCapabilities } from "./health"

/** Every async test gets a real timeout guard so a hang fails loudly instead of stalling the suite. */
const GUARD_MS = 2000

const task: AgentTask = {
  fence: { turnId: "t", attempt: 0, leaseNonce: "n" },
  workspacePath: "C:\\ws",
  systemPrompt: "sys",
  userMessage: "hi",
  model: "claude-opus-4-8",
  effort: "high",
  session: { kind: "fresh", seed: [] },
}

/** A scripted, non-throwing SDK stream. */
function query(messages: SDKMessage[]): ClaudeQuery {
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m
    },
    interrupt: async () => {},
  }
}

/** A stream that throws before yielding anything — drives `driveQuery`'s catch/`backend-error` path. */
function throwingQuery(reason: string): ClaudeQuery {
  return {
    async *[Symbol.asyncIterator]() {
      throw new Error(reason)
    },
    interrupt: async () => {},
  }
}

/**
 * Like `query`, but after yielding `messages` the generator hangs on a
 * never-settling promise instead of completing. Used where a test needs a
 * run that only `cancel()` can terminate — a stream that reaches natural
 * completion (even a "stream ended without a result" failure) races an
 * out-of-band `cancel()` call and would make the outcome timing-dependent.
 */
function hangingQuery(messages: SDKMessage[]): ClaudeQuery {
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m
      await new Promise<never>(() => {})
    },
    interrupt: async () => {},
  }
}

/** A success `result` message with no `usage` field, so `deriveUsage` yields `null` cleanly. */
const success = {
  type: "result",
  subtype: "success",
  result: "done",
  session_id: "s1",
  uuid: "u2",
  modelUsage: {},
  total_cost_usd: 0,
  permission_denials: [],
} as unknown as SDKMessage

/** A non-terminal assistant message; a stream containing only this never reaches a `result`. */
const assistant = {
  type: "assistant",
  session_id: "s1",
  uuid: "u1",
  parent_tool_use_id: null,
  message: { content: [{ type: "text", text: "editing" }] },
} as unknown as SDKMessage

/** A `system:init` message — the probe's "ready" classification. */
const initMessage = {
  type: "system",
  subtype: "init",
  apiKeySource: "oauth",
  model: "claude-opus-4-8",
  session_id: "s",
  uuid: "u",
} as unknown as SDKMessage

/** Wrap a `ProcessTree` so `terminate()`/`close()` calls can be counted by a test. */
function trackTree(tree: ProcessTree): { tree: ProcessTree; terminateCalls: () => number; closeCalls: () => number } {
  let terminate = 0
  let close = 0
  return {
    tree: {
      adopt: tree.adopt,
      activeProcesses: tree.activeProcesses,
      terminate: () => {
        terminate += 1
        return tree.terminate()
      },
      close: () => {
        close += 1
        tree.close()
      },
      noteAdoptionOutcome: tree.noteAdoptionOutcome,
      ownershipConfirmed: tree.ownershipConfirmed,
    },
    terminateCalls: () => terminate,
    closeCalls: () => close,
  }
}

test(
  "startTurn runs an attempt and produces a completed outcome",
  async () => {
    const backend = createClaudeBackend({
      queryFn: () => query([success]),
      processTreeFactory: () => createFakeProcessTree({ counts: [0], ownershipConfirmed: true }),
      wait: async () => {},
    })
    const run = backend.startTurn(task)
    const events: FencedEvent[] = []
    for await (const ev of run.events) events.push(ev)
    expect(events).toEqual([{ fence: task.fence, event: { kind: "final", text: "done" } }])
    expect(await run.outcome).toEqual({ kind: "completed", finalText: "done", usage: null, sessionId: "s1" })
  },
  GUARD_MS,
)

test("sessionScope is a pure, stable derivation matching deriveSessionScope", () => {
  const backend = createClaudeBackend({
    queryFn: () => query([success]),
    processTreeFactory: () => createFakeProcessTree({ counts: [0], ownershipConfirmed: true }),
    wait: async () => {},
  })
  const input = { account: "x", model: "claude-opus-4-8", workspaceIdentity: "w" }
  const a = backend.sessionScope(input)
  const b = backend.sessionScope(input)
  expect(a).toBe(b)
  // Cross-check against the underlying pure function with the real backend id.
  expect(a).toBe(deriveSessionScope(CLAUDE_BACKEND_ID, input))
})

test("capabilities are the static Claude table", () => {
  const backend = createClaudeBackend({
    queryFn: () => query([success]),
    processTreeFactory: () => createFakeProcessTree({ counts: [0], ownershipConfirmed: true }),
    wait: async () => {},
  })
  expect(backend.capabilities()).toEqual(claudeCapabilities())
})

test(
  "a ProcessTreeError from the factory degrades the run to a single error event + backend-error outcome",
  async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const backend = createClaudeBackend({
        queryFn: () => query([success]),
        processTreeFactory: () => new ProcessTreeError({ reason: "no Job Object support" }),
        wait: async () => {},
      })
      const run = backend.startTurn(task)
      const events: FencedEvent[] = []
      for await (const ev of run.events) events.push(ev)
      expect(events).toEqual([
        { fence: task.fence, event: { kind: "error", message: "Process-tree failure: no Job Object support" } },
      ])
      expect(await run.outcome).toEqual({
        kind: "backend-error",
        message: "Process-tree failure: no Job Object support",
        sessionId: null,
      })
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  },
  GUARD_MS,
)

test(
  "cancel(run) on a run this backend never created is a safe no-op",
  async () => {
    const backend = createClaudeBackend({
      queryFn: () => query([success]),
      processTreeFactory: () => createFakeProcessTree({ counts: [0], ownershipConfirmed: true }),
      wait: async () => {},
    })
    const foreignRun: AgentRun = {
      fence: task.fence,
      events: {
        [Symbol.asyncIterator]() {
          return { next: async (): Promise<IteratorResult<FencedEvent>> => ({ value: undefined, done: true }) }
        },
      },
      outcome: Promise.resolve({ kind: "unconfirmed-exit" }),
    }
    const result = await backend.cancel(foreignRun)
    expect(result).toBeUndefined()
  },
  GUARD_MS,
)

test(
  "cancel(run) on a real run actually reaches the §6.5 ladder",
  async () => {
    const { tree, terminateCalls } = trackTree(createFakeProcessTree({ counts: [2], ownershipConfirmed: true }))
    const backend = createClaudeBackend({
      queryFn: () => query([assistant]),
      processTreeFactory: () => tree,
      wait: async () => {},
    })
    const run = backend.startTurn(task)
    await backend.cancel(run)
    expect(terminateCalls()).toBe(1)
    expect(await run.outcome).toEqual({ kind: "cancelled", exitConfirmed: true })
  },
  GUARD_MS,
)

test(
  "healthCheck() delegates to probeHealth",
  async () => {
    const backend = createClaudeBackend({
      queryFn: () => query([initMessage]),
      processTreeFactory: () => createFakeProcessTree({ counts: [0], ownershipConfirmed: true }),
      wait: async () => {},
    })
    const info = await backend.healthCheck()
    // `apiKeySource` (`'user'|'project'|'org'|'temporary'|'oauth'`) names WHERE
    // a credential came from, not WHOSE it is, so `classifyMessage` (health.ts)
    // never reports it as `account` — storage-identity §6.2 requires a stable
    // per-account discriminator, and this SDK field is not one.
    expect(info).toEqual({ backendId: CLAUDE_BACKEND_ID, health: { status: "ready" }, account: null })
  },
  GUARD_MS,
)

// --- finding [26] half b: healthCheck() sources an owned tree for probeHealth, and it gets closed ---

test(
  "healthCheck() sources a fresh tree from processTreeFactory and it is closed once the probe settles",
  async () => {
    const { tree, closeCalls } = trackTree(createFakeProcessTree({ counts: [0], ownershipConfirmed: true }))
    let factoryCalls = 0
    const backend = createClaudeBackend({
      queryFn: () => query([initMessage]),
      processTreeFactory: () => {
        factoryCalls += 1
        return tree
      },
      wait: async () => {},
    })
    expect(factoryCalls).toBe(0) // not called until healthCheck() actually runs
    const info = await backend.healthCheck()
    expect(factoryCalls).toBe(1)
    expect(info).toEqual({ backendId: CLAUDE_BACKEND_ID, health: { status: "ready" }, account: null })
    // health.ts's probeHealth closes the tree it was handed on every path —
    // this proves claude-backend.ts's healthCheck() actually reaches that
    // code, not just that health.ts's own unit tests do.
    expect(closeCalls()).toBe(1)
  },
  GUARD_MS,
)

test(
  "healthCheck() still probes (rather than reporting a false verdict) when processTreeFactory fails",
  async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const backend = createClaudeBackend({
        queryFn: () => query([initMessage]),
        processTreeFactory: () => new ProcessTreeError({ reason: "no Job Object support" }),
        wait: async () => {},
      })
      const info = await backend.healthCheck()
      // No tree was available to adopt into, but the probe still ran and
      // classified a real verdict instead of assuming "not-installed".
      expect(info).toEqual({ backendId: CLAUDE_BACKEND_ID, health: { status: "ready" }, account: null })
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  },
  GUARD_MS,
)

test(
  "two startTurn calls get independent trees and abort controllers",
  async () => {
    const a = trackTree(createFakeProcessTree({ counts: [2], ownershipConfirmed: true }))
    const b = trackTree(createFakeProcessTree({ counts: [2], ownershipConfirmed: true }))
    const trees = [a.tree, b.tree]
    let factoryCalls = 0
    const processTreeFactory: ProcessTreeFactory = () => {
      factoryCalls += 1
      return trees[factoryCalls - 1]!
    }
    const abortControllersSeen: AbortController[] = []
    const queryFn: ClaudeQueryFn = (params) => {
      if (params.options.abortController !== undefined) abortControllersSeen.push(params.options.abortController)
      return hangingQuery([assistant])
    }
    const backend = createClaudeBackend({ queryFn, processTreeFactory, wait: async () => {} })

    const runA = backend.startTurn(task)
    const runB = backend.startTurn({ ...task, fence: { ...task.fence, attempt: 1 } })

    expect(factoryCalls).toBe(2)
    expect(abortControllersSeen.length).toBe(2)
    expect(abortControllersSeen[0]).not.toBe(abortControllersSeen[1])

    await backend.cancel(runA)
    expect(await runA.outcome).toEqual({ kind: "cancelled", exitConfirmed: true })
    expect(a.terminateCalls()).toBe(1)
    expect(b.terminateCalls()).toBe(0) // runB's tree must be untouched by cancelling runA

    await backend.cancel(runB)
    expect(await runB.outcome).toEqual({ kind: "cancelled", exitConfirmed: true })
    expect(b.terminateCalls()).toBe(1)
  },
  GUARD_MS,
)

// --- finding [1]/[21]: ProcessTree.close() must fire on every terminal path ---

test(
  "close() is called once the outcome settles as completed, and not before",
  async () => {
    const { tree, closeCalls } = trackTree(createFakeProcessTree({ counts: [0], ownershipConfirmed: true }))
    const backend = createClaudeBackend({
      queryFn: () => query([success]),
      processTreeFactory: () => tree,
      wait: async () => {},
    })
    const run = backend.startTurn(task)
    expect(closeCalls()).toBe(0) // not called before outcome settles
    expect(await run.outcome).toEqual({ kind: "completed", finalText: "done", usage: null, sessionId: "s1" })
    expect(closeCalls()).toBe(1)
  },
  GUARD_MS,
)

test(
  "close() is called once the outcome settles as backend-error, and not before",
  async () => {
    const { tree, closeCalls } = trackTree(createFakeProcessTree({ counts: [0], ownershipConfirmed: true }))
    const backend = createClaudeBackend({
      queryFn: () => throwingQuery("boom"),
      processTreeFactory: () => tree,
      wait: async () => {},
    })
    const run = backend.startTurn(task)
    expect(closeCalls()).toBe(0)
    const outcome = await run.outcome
    expect(outcome.kind).toBe("backend-error")
    expect(closeCalls()).toBe(1)
  },
  GUARD_MS,
)

test(
  "close() is called once the outcome settles as cancelled, and not before",
  async () => {
    const { tree, closeCalls } = trackTree(createFakeProcessTree({ counts: [2], ownershipConfirmed: true }))
    const backend = createClaudeBackend({
      queryFn: () => query([assistant]),
      processTreeFactory: () => tree,
      wait: async () => {},
    })
    const run = backend.startTurn(task)
    expect(closeCalls()).toBe(0)
    await backend.cancel(run)
    expect(await run.outcome).toEqual({ kind: "cancelled", exitConfirmed: true })
    expect(closeCalls()).toBe(1)
  },
  GUARD_MS,
)

test(
  "close() is called once the outcome settles as unconfirmed-exit, and not before",
  async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      // Ownership is never confirmed (`noteAdoptionOutcome(true)` never
      // recorded), so `activeProcesses() === 0` can never read as a
      // confirmed exit — the natural-completion path escalates and finally
      // reports `unconfirmed-exit`.
      const { tree, closeCalls } = trackTree(createFakeProcessTree({ counts: [0] }))
      const backend = createClaudeBackend({
        queryFn: () => query([success]),
        processTreeFactory: () => tree,
        wait: async () => {},
      })
      const run = backend.startTurn(task)
      expect(closeCalls()).toBe(0)
      expect(await run.outcome).toEqual({ kind: "unconfirmed-exit" })
      expect(closeCalls()).toBe(1)
    } finally {
      warnSpy.mockRestore()
    }
  },
  GUARD_MS,
)

test(
  "cancel() racing a natural completion does not double-close the tree (idempotent close)",
  async () => {
    const { tree, closeCalls } = trackTree(createFakeProcessTree({ counts: [0], ownershipConfirmed: true }))
    const backend = createClaudeBackend({
      queryFn: () => query([success]),
      processTreeFactory: () => tree,
      wait: async () => {},
    })
    const run = backend.startTurn(task)
    // The run already reached a natural outcome by the time cancel() is
    // awaited; cancel()'s loser branch (agent-run.ts) just waits on the same
    // outcome instead of re-running the ladder.
    await run.outcome
    await backend.cancel(run)
    expect(closeCalls()).toBe(1)
  },
  GUARD_MS,
)

// --- finding [30]: unhealthy-unconfirmed-exit latch ---

test(
  "healthCheck() latches unhealthy-unconfirmed-exit after a run resolves unconfirmed-exit, and stops probing",
  async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      let probeCalls = 0
      const queryFn: ClaudeQueryFn = () => {
        probeCalls += 1
        return query([success])
      }
      const backend = createClaudeBackend({
        queryFn,
        processTreeFactory: () => createFakeProcessTree({ counts: [0] }), // ownership never confirmed
        wait: async () => {},
      })
      const run = backend.startTurn(task)
      expect(await run.outcome).toEqual({ kind: "unconfirmed-exit" })
      const probeCallsAfterStartTurn = probeCalls // one call, from the run's own driveQuery

      const info = await backend.healthCheck()
      expect(info).toEqual({ backendId: CLAUDE_BACKEND_ID, health: { status: "unhealthy-unconfirmed-exit" }, account: null })
      expect(probeCalls).toBe(probeCallsAfterStartTurn) // healthCheck() did not spawn another CLI

      // The latch is sticky across repeated calls, not a one-shot report.
      const info2 = await backend.healthCheck()
      expect(info2).toEqual({ backendId: CLAUDE_BACKEND_ID, health: { status: "unhealthy-unconfirmed-exit" }, account: null })
      expect(probeCalls).toBe(probeCallsAfterStartTurn)
    } finally {
      warnSpy.mockRestore()
    }
  },
  GUARD_MS,
)

test(
  "the unhealthy-unconfirmed-exit latch is scoped to one backend instance — a freshly constructed backend still probes normally",
  async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const staleBackend = createClaudeBackend({
        queryFn: () => query([success]),
        processTreeFactory: () => createFakeProcessTree({ counts: [0] }), // ownership never confirmed
        wait: async () => {},
      })
      expect(await staleBackend.startTurn(task).outcome).toEqual({ kind: "unconfirmed-exit" })
      expect((await staleBackend.healthCheck()).health).toEqual({ status: "unhealthy-unconfirmed-exit" })

      const freshBackend = createClaudeBackend({
        queryFn: () => query([initMessage]),
        processTreeFactory: () => createFakeProcessTree({ counts: [0], ownershipConfirmed: true }),
        wait: async () => {},
      })
      expect(await freshBackend.healthCheck()).toEqual({
        backendId: CLAUDE_BACKEND_ID,
        health: { status: "ready" },
        account: null,
      })
    } finally {
      warnSpy.mockRestore()
    }
  },
  GUARD_MS,
)

// --- finding [17]: pathToClaudeCodeExecutable / confirmTimeoutMs pass-through ---

test(
  "pathToClaudeCodeExecutable reaches the query options when set",
  async () => {
    let capturedOptions: Options | undefined
    const queryFn: ClaudeQueryFn = (params) => {
      capturedOptions = params.options
      return query([success])
    }
    const backend = createClaudeBackend({
      queryFn,
      processTreeFactory: () => createFakeProcessTree({ counts: [0], ownershipConfirmed: true }),
      wait: async () => {},
      pathToClaudeCodeExecutable: "C:\\bin\\claude.exe",
    })
    await backend.startTurn(task).outcome
    expect(capturedOptions?.pathToClaudeCodeExecutable).toBe("C:\\bin\\claude.exe")
  },
  GUARD_MS,
)

test(
  "pathToClaudeCodeExecutable is absent from the query options when not set",
  async () => {
    let capturedOptions: Options | undefined
    const queryFn: ClaudeQueryFn = (params) => {
      capturedOptions = params.options
      return query([success])
    }
    const backend = createClaudeBackend({
      queryFn,
      processTreeFactory: () => createFakeProcessTree({ counts: [0], ownershipConfirmed: true }),
      wait: async () => {},
    })
    await backend.startTurn(task).outcome
    expect(capturedOptions).toBeDefined()
    // The compiled-binary parity (Spike H) hazard this guards against: an
    // inverted conditional spread would inject a literal `undefined` key
    // instead of omitting it — `"in"` still catches that, `?? ` would not.
    expect("pathToClaudeCodeExecutable" in (capturedOptions as Options)).toBe(false)
  },
  GUARD_MS,
)

test(
  "confirmTimeoutMs reaches the run and bounds the exit-confirmation poll budget",
  async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      let waitCalls = 0
      const backend = createClaudeBackend({
        queryFn: () => query([assistant]),
        processTreeFactory: () =>
          createFakeProcessTree({ counts: [5], neverZero: true, ownershipConfirmed: true }),
        wait: async () => {
          waitCalls += 1
        },
        confirmTimeoutMs: 300, // ceil(300 / POLL_INTERVAL_MS(100)) = 3 attempts per poll
      })
      const run = backend.startTurn(task)
      await backend.cancel(run)
      expect(await run.outcome).toEqual({ kind: "unconfirmed-exit" })
      // Two pollUntilZero calls in the cancel ladder (rung 2 pre-terminate,
      // rung 4 post-terminate), each with 3 attempts -> 2 `wait` calls each.
      expect(waitCalls).toBe(4)
    } finally {
      warnSpy.mockRestore()
    }
  },
  GUARD_MS,
)

test(
  "confirmTimeoutMs absent falls back to startClaudeRun's default 5s budget",
  async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      let waitCalls = 0
      const backend = createClaudeBackend({
        queryFn: () => query([assistant]),
        processTreeFactory: () =>
          createFakeProcessTree({ counts: [5], neverZero: true, ownershipConfirmed: true }),
        wait: async () => {
          waitCalls += 1
        },
      })
      const run = backend.startTurn(task)
      await backend.cancel(run)
      expect(await run.outcome).toEqual({ kind: "unconfirmed-exit" })
      // Default 5000ms budget -> ceil(5000/100) = 50 attempts -> 49 `wait`
      // calls per poll, two polls (rung 2 + rung 4) = 98.
      expect(waitCalls).toBe(98)
    } finally {
      warnSpy.mockRestore()
    }
  },
  GUARD_MS,
)
