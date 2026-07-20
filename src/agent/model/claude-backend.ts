import type { ProcessTreeFactory } from "infrastructure/process"
import { ProcessTreeError } from "infrastructure/process"
import type {
  AgentBackend,
  AgentInfo,
  AgentRun,
  AgentRunOutcome,
  AgentTask,
  BackendCapabilities,
  FencedEvent,
  SessionScopeInput,
} from "../types"
import { startClaudeRun } from "./agent-run"
import { claudeCapabilities, probeHealth } from "./health"
import type { ClaudeQueryFn } from "./query-fn"
import { buildQueryOptions } from "./query-fn"
import { buildPrompt } from "./session-plan"
import { deriveSessionScope } from "./session-scope"

const BACKEND_ID = "claude"

/** Deps for {@link createClaudeBackend}. */
export interface ClaudeBackendDeps {
  readonly queryFn: ClaudeQueryFn
  /** Constructs a fresh, independently owned process tree per `startTurn` call (§6.5). */
  readonly processTreeFactory: ProcessTreeFactory
  /** Injectable delay for the §6.5 exit-confirmation polls; production = `(ms) => Bun.sleep(ms)`. */
  readonly wait: (ms: number) => Promise<void>
  /** Override for the CLI path in a compiled binary (Spike H compiled-binary parity). */
  readonly pathToClaudeCodeExecutable?: string
  /** Reparse-point backstop injected on Windows (Spike F). */
  readonly hasReparsePoint?: (p: string) => boolean
  /** Override for the §6.5 exit-confirmation budget; `startClaudeRun` supplies its own default when omitted. */
  readonly confirmTimeoutMs?: number
}

/** An `AsyncIterable` that yields `event` exactly once, then completes. */
function singleEventIterable(event: FencedEvent): AsyncIterable<FencedEvent> {
  return {
    [Symbol.asyncIterator]() {
      let delivered = false
      return {
        next: async (): Promise<IteratorResult<FencedEvent>> => {
          if (delivered) return { value: undefined, done: true }
          delivered = true
          return { value: event, done: false }
        },
      }
    },
  }
}

/**
 * A run degraded because `startTurn` never obtained an owned process tree
 * (§6.5). Without a tree there is nothing for the exit-confirmation ladder to
 * poll and nothing for `canUseTool` confinement to stand behind if the SDK
 * spawns anyway — confinement here is defense-in-depth (master §6.1), not the
 * wall, so the safe choice is to fail the attempt outright rather than let it
 * run unconfined. Reported the same shape a real attempt uses on failure: one
 * `error` event on the fence, then a matching `backend-error` outcome.
 */
function degradedRun(task: AgentTask, message: string): AgentRun {
  const outcome: AgentRunOutcome = { kind: "backend-error", message, sessionId: null }
  return {
    fence: task.fence,
    events: singleEventIterable({ fence: task.fence, event: { kind: "error", message } }),
    outcome: Promise.resolve(outcome),
  }
}

/**
 * Assemble the mechanism-blind `ClaudeBackend` (master §6.1) from the
 * pure/injected pieces built in T9–T13: `startClaudeRun` drives one fenced
 * attempt, `probeHealth`/`claudeCapabilities` answer health/capability
 * queries, and `deriveSessionScope` derives the opaque checkpoint key.
 *
 * Non-Reatom: `cancels` is a `WeakMap`-keyed registry of per-run cancel
 * closures, scoped to this factory call's closure lifetime — not a Reatom
 * atom. `agent/` is a non-Reatom injected adapter (CLAUDE.md / plan Global
 * Constraints); the backend instance itself is the only lifetime owner here.
 */
export function createClaudeBackend(deps: ClaudeBackendDeps): AgentBackend {
  const cancels = new WeakMap<AgentRun, () => Promise<void>>()

  /**
   * finding [30]: sticky, per-backend-instance latch. Set the moment any
   * run's outcome resolves `unconfirmed-exit` — turn-durability §6.5 requires
   * the backend be locked out of new turns until "a full health check proves
   * the owned tree absent". Non-Reatom: explicit closure state scoped to this
   * backend instance's lifetime (CLAUDE.md), not an atom.
   *
   * How it clears (decision, since no in-place mechanism this layer owns can
   * satisfy §6.5's wording literally): the tree below is now `close()`d on
   * every outcome including `unconfirmed-exit`, which is INVALIDATING —
   * every method on that specific tree refuses with `ProcessTreeError`
   * afterwards, so this backend has no way to re-query the SPECIFIC stale
   * tree to prove it emptied. Spawning an unrelated fresh CLI (what the old,
   * unconditional `probeHealth` call did) proves nothing about the stale
   * tree either — that is the exact false-admission bug this latch exists to
   * close, so `healthCheck()` deliberately does not fall back to it. The
   * latch therefore never auto-clears in place: recovery matches §6.5's own
   * documented remedy, "the user sees a restart... action" — restarting
   * reconstructs the backend via `createClaudeBackend`/
   * `createProductionClaudeBackend`, producing a fresh closure with the latch
   * unset. A stronger in-place recovery (e.g. a dedicated confined write
   * probe, §6.5's second clause) is out of scope for this task.
   */
  let unhealthyUnconfirmedExit = false

  return {
    startTurn(task: AgentTask): AgentRun {
      const abortController = new AbortController()
      const tree = deps.processTreeFactory()
      if (tree instanceof ProcessTreeError) {
        // Swallowed here (the run degrades instead of throwing) — logged per
        // errore rule 21 so a broken process-tree factory stays visible.
        console.warn("agent/claude-backend: processTreeFactory failed, run degraded:", tree.message)
        return degradedRun(task, tree.message)
      }

      const options = buildQueryOptions(task, {
        abortController,
        processTree: tree,
        pathToClaudeCodeExecutable: deps.pathToClaudeCodeExecutable,
        hasReparsePoint: deps.hasReparsePoint,
      })

      const { run, cancel } = startClaudeRun(task, {
        queryFn: deps.queryFn,
        processTree: tree,
        abortController,
        wait: deps.wait,
        confirmTimeoutMs: deps.confirmTimeoutMs,
        options,
        prompt: buildPrompt(task),
      })
      cancels.set(run, cancel)

      // finding [1]/[21]: `startTurn` mints `tree`, so `startTurn` owns
      // releasing it. Close it once this run's outcome is known — on EVERY
      // terminal kind, including `unconfirmed-exit`: that kind names our
      // inability to CONFIRM the exit, not a reason to keep the tree open,
      // and closing is the last-resort reaper (it arms Windows'
      // kill-on-close for any survivor). `outcome` never rejects (types.ts),
      // so a bare `.then` is enough, and it only fires AFTER the
      // exit-confirmation poll has already finished reading
      // `activeProcesses()` (agent-run.ts), so this can never race that
      // read. `ProcessTree.close()` is idempotent and invalidating
      // (job-object.ts), so a concurrent `cancel()` racing to close the same
      // tree a second time is safe.
      void run.outcome.then((outcome) => {
        tree.close()
        if (outcome.kind === "unconfirmed-exit") {
          console.warn(
            "agent/claude-backend: run exited unconfirmed; latching this backend unhealthy until it is restarted (§6.5)",
          )
          unhealthyUnconfirmedExit = true
        }
      })

      return run
    },

    async cancel(run: AgentRun): Promise<void> {
      const runCancel = cancels.get(run)
      if (runCancel === undefined) return // not a run this backend created (or already degraded) -> safe no-op
      await runCancel()
    },

    healthCheck(): Promise<AgentInfo> {
      if (unhealthyUnconfirmedExit) {
        // finding [30]: report the latch instead of probing. A probe here
        // would spawn a brand-new, unrelated CLI that can only ever attest to
        // its OWN health, never to whether the stale (already-closed) tree
        // from the unconfirmed exit is actually gone — reporting "ready"
        // regardless is exactly the false-admission bug this latch exists to
        // prevent (see the latch doc comment above for how it clears).
        return Promise.resolve({
          backendId: BACKEND_ID,
          health: { status: "unhealthy-unconfirmed-exit" },
          account: null,
        })
      }
      return probeHealth(deps.queryFn, { abortController: new AbortController() })
    },

    capabilities(): BackendCapabilities {
      return claudeCapabilities()
    },

    sessionScope(input: SessionScopeInput): string {
      return deriveSessionScope(BACKEND_ID, input)
    },
  }
}
