import { createStateMachine, type StateMachine, type TransitionTable } from "./state-machine"

/**
 * The Kernel project model (kernel-command-contract §7.1, lines 189-228).
 *
 * `ready` also carries the portable project identity, canonical root, trust state,
 * storage health, active page/chat identities, current Git/status projections, and at
 * most one immutable `PageRemovePlanV1` — none of that payload lives here. This file is
 * only the table §7.1 fixes: the legal `ProjectState` graph and its named actions. The
 * service/guard layer (out of scope for this file) supplies the payload and the
 * per-command preconditions the table cannot express (see the per-action notes below).
 *
 * Table keys are bare verbs (`beginCreate`, not `kernel.project.beginCreate`) per this
 * slice's naming convention; {@link PROJECT_ACTION_FULL_NAME} carries the full
 * `kernel.project.<verb>` name §6/§7.1 use, for traceability without repeating the
 * `kernel.project.` prefix on every table row.
 */

export type ProjectState = "closed" | "opening" | "recovering" | "ready" | "blocked" | "closing"

export type ProjectAction =
  | "beginCreate"
  | "beginOpen"
  | "beginRecovery"
  | "finishOpen"
  | "blockOpen"
  | "setTrust"
  | "renamePageTitle"
  | "reorderPages"
  | "beginPageRemovePlan"
  | "confirmPageRemove"
  | "discardPageRemovePlan"
  | "beginClose"
  | "finishClose"
  | "retryOpen"

/** The full `kernel.project.<verb>` name for every {@link ProjectAction}, §7.1 verbatim. */
export const PROJECT_ACTION_FULL_NAME: Readonly<Record<ProjectAction, string>> = {
  beginCreate: "kernel.project.beginCreate",
  beginOpen: "kernel.project.beginOpen",
  beginRecovery: "kernel.project.beginRecovery",
  finishOpen: "kernel.project.finishOpen",
  blockOpen: "kernel.project.blockOpen",
  setTrust: "kernel.project.setTrust",
  renamePageTitle: "kernel.project.renamePageTitle",
  reorderPages: "kernel.project.reorderPages",
  beginPageRemovePlan: "kernel.project.beginPageRemovePlan",
  confirmPageRemove: "kernel.project.confirmPageRemove",
  discardPageRemovePlan: "kernel.project.discardPageRemovePlan",
  beginClose: "kernel.project.beginClose",
  finishClose: "kernel.project.finishClose",
  retryOpen: "kernel.project.retryOpen",
}

/**
 * §7.1's table, transcribed row for row. A row listing multiple sources for one action
 * ("opening, recovering | finishOpen | ready") becomes one edge per source; a row listing
 * multiple actions for one target ("beginCreate or beginOpen") becomes one edge per
 * action. None of the same-phase edges below (`setTrust`, `renamePageTitle`, ...) are
 * marked `noOp`: every one of them is a real, revision-changing mutation per its own rule
 * text (e.g. setTrust's "it is not an identity setter"), just one that happens not to move
 * the discrete phase — unlike §7.2's `requestCancel` no-ops, nothing in §7.1's prose calls
 * any of these idempotent.
 */
export const PROJECT_TRANSITION_TABLE: TransitionTable<ProjectState, ProjectAction> = {
  // `closed | beginCreate or beginOpen | opening` — a second open is illegal because
  // neither action is listed from any state other than `closed`.
  beginCreate: [{ from: "closed", to: "opening" }],
  beginOpen: [{ from: "closed", to: "opening" }],
  // `opening | beginRecovery | recovering`
  beginRecovery: [{ from: "opening", to: "recovering" }],
  // `opening, recovering | finishOpen | ready`
  finishOpen: [
    { from: "opening", to: "ready" },
    { from: "recovering", to: "ready" },
  ],
  // `opening, recovering | blockOpen | blocked`
  blockOpen: [
    { from: "opening", to: "blocked" },
    { from: "recovering", to: "blocked" },
  ],
  // `opening | setTrust | opening` and `ready | setTrust | ready` — two edges, one per row.
  setTrust: [
    { from: "opening", to: "opening" },
    { from: "ready", to: "ready" },
  ],
  // `ready | renamePageTitle, reorderPages | ready` — one row, two actions.
  renamePageTitle: [{ from: "ready", to: "ready" }],
  reorderPages: [{ from: "ready", to: "ready" }],
  // `ready | beginPageRemovePlan | ready` — the "trusted writable state, no active turn,
  // listed page" precondition is a guard concern; the table only says the edge exists.
  beginPageRemovePlan: [{ from: "ready", to: "ready" }],
  // `ready | confirmPageRemove | ready` — likewise, revalidation under the project-write
  // mutex is the service layer's job, not this table's.
  confirmPageRemove: [{ from: "ready", to: "ready" }],
  // `ready | discardPageRemovePlan | ready`
  discardPageRemovePlan: [{ from: "ready", to: "ready" }],
  // `ready, blocked | beginClose | closing`
  beginClose: [
    { from: "ready", to: "closing" },
    { from: "blocked", to: "closing" },
  ],
  // `closing | finishClose | closed`
  finishClose: [{ from: "closing", to: "closed" }],
  // `blocked | retryOpen | opening`
  retryOpen: [{ from: "blocked", to: "opening" }],
}

/**
 * §7.1: "All project-scoped commands except open/create/retry/close/trust and a trusted
 * pre-Workspace migration plan/confirmation reject with `PROJECT_NOT_READY` unless the
 * model is `ready`." This is the table-wide fallback §6 requires ("Any source/action pair
 * not listed in the following tables is illegal and returns the table's domain rejection
 * code without changing state"), not a per-command code: an unlisted pair for, say,
 * `finishOpen` from `ready` also returns `PROJECT_NOT_READY` here even though that specific
 * situation has no natural "not ready" reading. Selecting a more specific code per command
 * (e.g. distinguishing an already-open project from a genuinely not-ready one) is the guard
 * layer's job, not this machine's.
 */
const PROJECT_ILLEGAL_CODE = "PROJECT_NOT_READY"

/**
 * Builds one Kernel's project model. A factory, not a module-level machine: §5 scopes
 * Kernel Reatom models to one Kernel process/context, and module-level state would let two
 * kernels — or two tests — share a phase and invalidate each other.
 */
export function reatomProjectStateMachine(): StateMachine<ProjectState, ProjectAction> {
  return createStateMachine<ProjectState, ProjectAction>({
    traceRoot: "kernel.project",
    initial: "closed",
    table: PROJECT_TRANSITION_TABLE,
    illegalCode: PROJECT_ILLEGAL_CODE,
  })
}
