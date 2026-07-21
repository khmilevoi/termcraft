import { ProcessTreeError } from "infrastructure/process"
import { createDegradedRun, createUnconfirmedExitLatch, startAgentRun } from "agent/run"
import { buildPrompt, deriveSessionScope } from "agent/session"
import type {
  AgentBackend,
  AgentInfo,
  AgentRun,
  AgentTask,
  BackendCapabilities,
  SessionScopeInput,
} from "agent/types"
import { buildQueryOptions } from "agent/claude/query"
import { createClaudeDriver } from "agent/claude/run"
import type { ClaudeBackendDeps } from "agent/claude/types"
import { CLAUDE_BACKEND_ID } from "./backend-id"
import { claudeCapabilities } from "./capabilities"
import { probeClaudeHealth } from "./probe"

/**
 * Assemble the mechanism-blind `ClaudeBackend` (master §6.1) from the
 * pure/injected pieces built in T9–T13: `startClaudeRun` drives one fenced
 * attempt, `probeHealth`/`claudeCapabilities` answer health/capability
 * queries, and `deriveSessionScope` derives the opaque checkpoint key.
 * `createDegradedRun`/`createUnconfirmedExitLatch` (agent/run) are the
 * backend-agnostic §6.5 policy pieces this factory wires in.
 *
 * Non-Reatom: `cancels` is a `WeakMap`-keyed registry of per-run cancel
 * closures, scoped to this factory call's closure lifetime — not a Reatom
 * atom. `agent/` is a non-Reatom injected adapter (CLAUDE.md / plan Global
 * Constraints); the backend instance itself is the only lifetime owner here.
 */
export function createClaudeBackend(deps: ClaudeBackendDeps): AgentBackend {
  const cancels = new WeakMap<AgentRun, () => Promise<void>>()
  const unhealthy = createUnconfirmedExitLatch(CLAUDE_BACKEND_ID)

  return {
    startTurn(task: AgentTask): AgentRun {
      if (unhealthy.isLatched()) {
        return createDegradedRun(
          task.fence,
          "backend is unhealthy: a prior run's exit was never confirmed (§6.5)",
        )
      }

      const abortController = new AbortController()
      const tree = deps.processTreeFactory()
      if (tree instanceof ProcessTreeError) {
        console.warn("agent/claude-backend: processTreeFactory failed, run degraded:", tree.message)
        return createDegradedRun(task.fence, tree.message)
      }

      const options = buildQueryOptions(task, {
        abortController,
        processTree: tree,
        pathToClaudeCodeExecutable: deps.pathToClaudeCodeExecutable,
        hasReparsePoint: deps.hasReparsePoint,
      })

      const { run, cancel } = startAgentRun(
        task.fence,
        createClaudeDriver({ queryFn: deps.queryFn, prompt: buildPrompt(task), options }),
        { processTree: tree, abortController, wait: deps.wait, confirmTimeoutMs: deps.confirmTimeoutMs },
      )
      cancels.set(run, cancel)

      // `startTurn` mints `tree`, so `startTurn` owns releasing it. Close on
      // EVERY terminal kind including `unconfirmed-exit`: that kind names our
      // inability to CONFIRM the exit, not a reason to keep the tree open, and
      // closing arms Windows' kill-on-close for any survivor. `outcome` never
      // rejects, and it only settles AFTER exit confirmation has finished
      // reading `activeProcesses()`, so this cannot race that read.
      void run.outcome.then((outcome) => {
        tree.close()
        unhealthy.noteOutcome(outcome)
      })

      return run
    },

    async cancel(run: AgentRun): Promise<void> {
      const runCancel = cancels.get(run)
      if (runCancel === undefined) return // not a run this backend created -> safe no-op
      await runCancel()
    },

    healthCheck(): Promise<AgentInfo> {
      if (unhealthy.isLatched()) {
        // Report the latch instead of probing: a probe would spawn a fresh,
        // unrelated CLI that can only attest to its OWN health, never to
        // whether the stale tree is gone.
        return Promise.resolve({
          backendId: CLAUDE_BACKEND_ID,
          health: { status: "unhealthy-unconfirmed-exit" },
          account: null,
        })
      }
      const tree = deps.processTreeFactory()
      if (tree instanceof ProcessTreeError) {
        // Probe anyway rather than reporting a false "not-installed": no owned
        // tree exists here, but that says nothing about whether the CLI is
        // installed. `startTurn` already refuses a real turn on this same
        // failure, so no paid turn can start on a wrong "ready".
        console.warn(
          "agent/claude-backend: processTreeFactory failed for healthCheck(), probing without adoption:",
          tree.message,
        )
        return probeClaudeHealth(deps.queryFn, { abortController: new AbortController(), processTree: null })
      }
      return probeClaudeHealth(deps.queryFn, { abortController: new AbortController(), processTree: tree })
    },

    capabilities(): BackendCapabilities {
      return claudeCapabilities()
    },

    sessionScope(input: SessionScopeInput): string {
      return deriveSessionScope(CLAUDE_BACKEND_ID, input)
    },
  }
}
