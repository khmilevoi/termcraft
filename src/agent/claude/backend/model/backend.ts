import { buildQueryOptions } from "agent/claude/query";
import { createClaudeDriver } from "agent/claude/run";
import type { ClaudeBackendDeps } from "agent/claude/types";
import { createDegradedRun, createUnconfirmedExitLatch, startAgentRun } from "agent/run";
import { buildPrompt, deriveSessionScope } from "agent/session";
import type {
  AgentBackend,
  AgentInfo,
  AgentRun,
  AgentTask,
  BackendCapabilities,
  SessionScopeInput,
} from "agent/types";
import { log, trace } from "infrastructure/debug-log";
import { ProcessTreeError } from "infrastructure/process";

import { CLAUDE_BACKEND_ID } from "./backend-id";
import { claudeCapabilities } from "./capabilities";
import { probeClaudeHealth } from "./probe";

/**
 * Assemble the mechanism-blind `ClaudeBackend` (master §6.1) from pure,
 * injected pieces: `startAgentRun` + `createClaudeDriver` drive one fenced
 * attempt, `probeClaudeHealth`/`claudeCapabilities` answer health/capability
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
  const cancels = new WeakMap<AgentRun, () => Promise<void>>();
  const unhealthy = createUnconfirmedExitLatch(CLAUDE_BACKEND_ID);

  return {
    startTurn(task: AgentTask): AgentRun {
      if (unhealthy.isLatched()) {
        // DIAGNOSTIC (infrastructure/debug-log): a turn was refused outright because a prior run exit
        // was never confirmed (§6.5) -- the turn never reaches the agent at all.
        trace("agent.claude.backend.startTurnRefused", {
          turnId: task.fence.turnId,
          attempt: task.fence.attempt,
          reason: "unhealthy-unconfirmed-exit",
        });
        return createDegradedRun(
          task.fence,
          "backend is unhealthy: a prior run's exit was never confirmed (§6.5)",
        );
      }

      const abortController = new AbortController();
      const tree = deps.processTreeFactory();
      if (tree instanceof ProcessTreeError) {
        log.warn(
          "agent/claude-backend: processTreeFactory failed, run degraded:",
          tree.message,
        );
        // DIAGNOSTIC (infrastructure/debug-log): a turn was refused outright because acquiring the
        // process tree failed -- the turn never reaches the agent at all.
        trace("agent.claude.backend.startTurnRefused", {
          turnId: task.fence.turnId,
          attempt: task.fence.attempt,
          reason: "processTreeFactory failed: " + tree.message,
        });
        return createDegradedRun(task.fence, tree.message);
      }

      const options = buildQueryOptions(task, {
        abortController,
        processTree: tree,
        // Forwarded, never defaulted here: the tool is bound to THIS attempt's workspace inside
        // `buildQueryOptions`, and a backend that quietly substituted a no-op checker would
        // advertise `check_design` and answer nothing.
        designChecker: deps.designChecker,
        pathToClaudeCodeExecutable: deps.pathToClaudeCodeExecutable,
        hasReparsePoint: deps.hasReparsePoint,
      });

      // DIAGNOSTIC (infrastructure/debug-log): the turn this backend is about to actually run through
      // the SDK -- the entry point for "agent work" from the port's own perspective.
      trace("agent.claude.backend.startTurn", {
        turnId: task.fence.turnId,
        attempt: task.fence.attempt,
        model: task.model,
        effort: task.effort,
        sessionKind: task.session.kind,
        workspacePath: task.workspacePath,
      });

      const { run, cancel } = startAgentRun(
        task.fence,
        createClaudeDriver({
          queryFn: deps.queryFn,
          prompt: buildPrompt(task),
          options,
          sessionKind: task.session.kind,
        }),
        {
          processTree: tree,
          abortController,
          wait: deps.wait,
          confirmTimeoutMs: deps.confirmTimeoutMs,
        },
      );
      cancels.set(run, cancel);

      // `startTurn` mints `tree`, so `startTurn` owns releasing it. Close on
      // EVERY terminal kind including `unconfirmed-exit`: that kind names our
      // inability to CONFIRM the exit, not a reason to keep the tree open, and
      // closing arms Windows' kill-on-close for any survivor. `outcome` never
      // rejects, and it only settles AFTER exit confirmation has finished
      // reading `activeProcesses()`, so this cannot race that read.
      void run.outcome.then((outcome) => {
        // DIAGNOSTIC (infrastructure/debug-log): this run final outcome, at the exact point the backend
        // closes its process tree -- ties together every trace this run produced upstream
        // (driver/engine/attempt) with what the backend itself decided to do about it.
        trace("agent.claude.backend.runSettled", {
          turnId: task.fence.turnId,
          attempt: task.fence.attempt,
          outcome,
        });
        tree.close();
        unhealthy.noteOutcome(outcome);
      });

      return run;
    },

    async cancel(run: AgentRun): Promise<void> {
      const runCancel = cancels.get(run);
      if (runCancel === undefined) return; // not a run this backend created (or already degraded) -> safe no-op
      await runCancel();
    },

    healthCheck(): Promise<AgentInfo> {
      if (unhealthy.isLatched()) {
        // Report the latch instead of probing: a probe would spawn a fresh,
        // unrelated CLI that can only attest to its OWN health, never to
        // whether the stale tree is gone.
        const info: AgentInfo = {
          backendId: CLAUDE_BACKEND_ID,
          health: { status: "unhealthy-unconfirmed-exit" },
          account: null,
        };
        // DIAGNOSTIC (infrastructure/debug-log): healthCheck reported the latch instead of probing --
        // see the branch's own comment for why. `source` distinguishes this from a real probe verdict
        // below, since all three call sites share one channel.
        trace("agent.claude.backend.healthCheck", { source: "latched", ...info });
        return Promise.resolve(info);
      }
      const tree = deps.processTreeFactory();
      if (tree instanceof ProcessTreeError) {
        // Probe anyway rather than reporting a false "not-installed": no owned
        // tree exists here, but that says nothing about whether the CLI is
        // installed. `startTurn` already refuses a real turn on this same
        // failure, so no paid turn can start on a wrong "ready".
        log.warn(
          "agent/claude-backend: processTreeFactory failed for healthCheck(), probing without adoption:",
          tree.message,
        );
        return probeClaudeHealth(deps.queryFn, {
          abortController: new AbortController(),
          processTree: null,
        }).then((info) => {
          // DIAGNOSTIC (infrastructure/debug-log): the probe verdict for this healthCheck call, run
          // without process-tree adoption because no tree could be created (see the branch above).
          trace("agent.claude.backend.healthCheck", { source: "probe-no-tree", ...info });
          return info;
        });
      }
      return probeClaudeHealth(deps.queryFn, {
        abortController: new AbortController(),
        processTree: tree,
      }).then((info) => {
        // DIAGNOSTIC (infrastructure/debug-log): the probe verdict for an ordinary healthCheck call.
        trace("agent.claude.backend.healthCheck", { source: "probe", ...info });
        return info;
      });
    },

    capabilities(): BackendCapabilities {
      return claudeCapabilities();
    },

    sessionScope(input: SessionScopeInput): string {
      return deriveSessionScope(CLAUDE_BACKEND_ID, input);
    },
  };
}
