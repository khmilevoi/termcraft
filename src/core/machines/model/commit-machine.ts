import { createStateMachine, type StateMachine, type TransitionTable } from "./state-machine"

/**
 * The Commit model (kernel-command-contract §7.4).
 *
 * TIER C FOR THE MVP: no service drives this machine yet — the roadmap defers scoped
 * Git commit to a later phase. The transition table below is nonetheless the complete
 * §7.4 graph, fully tested: §13.1 requires every state/action pair be enumerable, and a
 * partial table here would only have to be reopened once commit actually lands.
 * Nothing outside this file references it yet.
 *
 * "Only one termcraft commit plan or execution is active, but it is intentionally
 * independent from `TurnState`." (§7.4) — plan contents, Git process execution, and
 * mutex revalidation are out of scope here; this file is only the `CommitState` graph.
 */

export type CommitState = "idle" | "planning" | "awaiting-confirmation" | "executing" | "refreshing"

export type CommitAction =
  | "kernel.commit.beginPlan"
  | "kernel.commit.planReady"
  | "kernel.commit.planFailed"
  | "kernel.commit.confirm"
  | "kernel.commit.discardPlan"
  | "kernel.commit.beginRefresh"
  | "kernel.commit.finishRefresh"

/** §7.4's table, transcribed row for row; every row has exactly one source. */
export const COMMIT_TRANSITION_TABLE: TransitionTable<CommitState, CommitAction> = {
  "kernel.commit.beginPlan": [{ from: "idle", to: "planning" }],
  "kernel.commit.planReady": [{ from: "planning", to: "awaiting-confirmation" }],
  "kernel.commit.planFailed": [{ from: "planning", to: "idle" }],
  "kernel.commit.confirm": [{ from: "awaiting-confirmation", to: "executing" }],
  "kernel.commit.discardPlan": [{ from: "awaiting-confirmation", to: "idle" }],
  "kernel.commit.beginRefresh": [{ from: "executing", to: "refreshing" }],
  "kernel.commit.finishRefresh": [{ from: "refreshing", to: "idle" }],
}

/**
 * Builds one Kernel's Commit model. §11.1: `OPERATION_BUSY` is "The relevant
 * single-operation model is not idle" — Commit is exactly that kind of model, so every
 * unlisted (source, action) pair rejects with it.
 */
export function reatomCommitStateMachine(): StateMachine<CommitState, CommitAction> {
  return createStateMachine<CommitState, CommitAction>({
    traceRoot: "kernel.commit",
    initial: "idle",
    table: COMMIT_TRANSITION_TABLE,
    illegalCode: "OPERATION_BUSY",
  })
}
