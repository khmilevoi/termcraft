import type { AgentEvent, TurnFence } from "entities/turn"
import type { AssertConforms } from "../index"
import type {
  AgentBackend,
  AgentInfo,
  AgentRun,
  AgentRunOutcome,
  AgentTask,
  BackendCapabilities,
  FencedEvent,
  SessionScopeInput,
} from "../agent-backend"

/**
 * In-memory {@link AgentBackend} fake (6D task brief). `startTurn` never streams anything
 * on its own — a test drives the run explicitly via {@link FakeAgentBackend.emitEvent} and
 * {@link FakeAgentBackend.completeRun}, keyed by the exact `TurnFence` the orchestration
 * code passed in, so a 6F test can script retries (a fresh fence per attempt), interleaved
 * events, and cancellation timing without a real process or any timer.
 *
 * `cancel()` resolves ONLY once the matching run's own outcome promise settles — the same
 * "resolves only after confirmed exit" contract the port's doc fixes — which falls out for
 * free from awaiting `run.outcome` rather than needing separate bookkeeping.
 */

function fenceKey(fence: TurnFence): string {
  return `${fence.turnId}:${fence.attempt}:${fence.leaseNonce}`
}

/** A minimal push-based async-iterable channel — no timers, no polling, fully test-driven. */
interface Channel<T> {
  push(value: T): void
  close(): void
  readonly iterable: AsyncIterable<T>
}

function createChannel<T>(): Channel<T> {
  const queue: T[] = []
  const waiting: Array<(result: IteratorResult<T>) => void> = []
  let closed = false
  return {
    push(value) {
      const waiter = waiting.shift()
      if (waiter !== undefined) {
        waiter({ value, done: false })
        return
      }
      queue.push(value)
    },
    close() {
      closed = true
      while (waiting.length > 0) {
        const waiter = waiting.shift()
        waiter?.({ value: undefined as unknown as T, done: true })
      }
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            const next = queue.shift()
            if (next !== undefined) return Promise.resolve({ value: next, done: false })
            if (closed) return Promise.resolve({ value: undefined as unknown as T, done: true })
            return new Promise((resolve) => waiting.push(resolve))
          },
        }
      },
    },
  }
}

interface RunHandle {
  readonly channel: Channel<FencedEvent>
  readonly resolveOutcome: (outcome: AgentRunOutcome) => void
  readonly outcome: Promise<AgentRunOutcome>
  settled: boolean
}

const DEFAULT_CAPABILITIES: BackendCapabilities = {
  backendId: "fake-backend",
  models: [{ model: "fake-model", efforts: ["medium"] }],
  confinement: "canUseTool",
  sessionWorkspaceBinding: "fixed",
}

export type AgentBackendCall =
  | { readonly method: "startTurn"; readonly fence: TurnFence }
  | { readonly method: "cancel"; readonly fence: TurnFence }
  | { readonly method: "healthCheck" }
  | { readonly method: "capabilities" }
  | { readonly method: "sessionScope"; readonly input: SessionScopeInput }

export interface FakeAgentBackend extends AgentBackend {
  readonly calls: readonly AgentBackendCall[]
  /** Push one live event onto the still-open run for `fence`. Logs and no-ops for an unknown/closed run. */
  emitEvent(fence: TurnFence, event: AgentEvent): void
  /** Settle the run's terminal outcome and close its event stream. Logs and no-ops if already settled. */
  completeRun(fence: TurnFence, outcome: AgentRunOutcome): void
  /** Queues the next `healthCheck()` result (FIFO), one shot; default when empty is `{status:"ready"}`. */
  queueHealth(info: AgentInfo): void
}

export function createFakeAgentBackend(options?: { readonly capabilities?: BackendCapabilities }): FakeAgentBackend {
  const capabilitiesValue = options?.capabilities ?? DEFAULT_CAPABILITIES
  const calls: AgentBackendCall[] = []
  const runs = new Map<string, RunHandle>()
  const healthQueue: AgentInfo[] = []

  function queueHealth(info: AgentInfo): void {
    healthQueue.push(info)
  }

  function emitEvent(fence: TurnFence, event: AgentEvent): void {
    const run = runs.get(fenceKey(fence))
    if (run === undefined || run.settled) {
      console.warn(`fakes/agent-backend: emitEvent for unknown or settled fence ${fenceKey(fence)}, ignored`)
      return
    }
    run.channel.push({ fence, event })
  }

  function completeRun(fence: TurnFence, outcome: AgentRunOutcome): void {
    const key = fenceKey(fence)
    const run = runs.get(key)
    if (run === undefined || run.settled) {
      console.warn(`fakes/agent-backend: completeRun for unknown or already-settled fence ${key}, ignored`)
      return
    }
    run.settled = true
    run.channel.close()
    run.resolveOutcome(outcome)
  }

  function startTurn(task: AgentTask): AgentRun {
    calls.push({ method: "startTurn", fence: task.fence })
    const channel = createChannel<FencedEvent>()
    let resolveOutcome!: (outcome: AgentRunOutcome) => void
    const outcome = new Promise<AgentRunOutcome>((resolve) => {
      resolveOutcome = resolve
    })
    runs.set(fenceKey(task.fence), { channel, resolveOutcome, outcome, settled: false })
    return { fence: task.fence, events: channel.iterable, outcome }
  }

  async function cancel(run: AgentRun): Promise<void> {
    calls.push({ method: "cancel", fence: run.fence })
    await run.outcome
  }

  async function healthCheck(): Promise<AgentInfo> {
    calls.push({ method: "healthCheck" })
    return healthQueue.shift() ?? { backendId: capabilitiesValue.backendId, health: { status: "ready" }, account: null }
  }

  function capabilities(): BackendCapabilities {
    calls.push({ method: "capabilities" })
    return capabilitiesValue
  }

  function sessionScope(input: SessionScopeInput): string {
    calls.push({ method: "sessionScope", input })
    return `${input.account ?? "anon"}|${input.model}|${input.workspaceIdentity}`
  }

  return { startTurn, cancel, healthCheck, capabilities, sessionScope, calls, emitEvent, completeRun, queueHealth }
}

type _Conforms = AssertConforms<AgentBackend, FakeAgentBackend>
