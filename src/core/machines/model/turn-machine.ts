import { type StateMachine, type TransitionTable, createStateMachine } from "./state-machine";

/**
 * The Kernel turn model (kernel-command-contract §7.2, lines 230-270).
 *
 * A turn also carries UUIDv7 `turnId`, captured `targetChatId`, captured input context,
 * the complete send-time read set, sent pin ids, a 30-minute default absolute deadline,
 * and one random `leaseNonce` for the live backend attempt — none of that payload lives
 * here. This file is only the table §7.2 fixes: the legal `TurnState` graph, its named
 * actions, and the attempt/terminal-outcome vocabulary the table's own prose defines
 * alongside it.
 *
 * Table keys are bare verbs (`beginAdmission`, not `kernel.turn.beginAdmission`) per this
 * slice's naming convention; {@link TURN_ACTION_FULL_NAME} carries the full
 * `kernel.turn.<verb>` name §6/§7.2 use, for traceability without repeating the
 * `kernel.turn.` prefix on every table row.
 */

export type TurnState =
  | "idle"
  | "admitting"
  | "workspace-ready"
  | "running"
  | "stopping"
  | "snapshotting"
  | "validating"
  | "finalizing"
  | "committed"
  | "terminalizing"
  | "terminal"
  | "backend-unhealthy";

export type TurnAction =
  | "beginAdmission"
  | "finishAdmission"
  | "beginAttempt"
  | "beginStopping"
  | "beginSnapshot"
  | "beginTerminalization"
  | "markBackendUnhealthy"
  | "candidateCaptured"
  | "retryAfterGate"
  | "retryAfterSessionFallback"
  | "beginFinalization"
  | "markCommitted"
  | "settle"
  | "finishTerminalization"
  | "confirmBackendHealthy"
  | "requestCancel";

/** The full `kernel.turn.<verb>` name for every {@link TurnAction}, §7.2 verbatim. */
export const TURN_ACTION_FULL_NAME: Readonly<Record<TurnAction, string>> = {
  beginAdmission: "kernel.turn.beginAdmission",
  finishAdmission: "kernel.turn.finishAdmission",
  beginAttempt: "kernel.turn.beginAttempt",
  beginStopping: "kernel.turn.beginStopping",
  beginSnapshot: "kernel.turn.beginSnapshot",
  beginTerminalization: "kernel.turn.beginTerminalization",
  markBackendUnhealthy: "kernel.turn.markBackendUnhealthy",
  candidateCaptured: "kernel.turn.candidateCaptured",
  retryAfterGate: "kernel.turn.retryAfterGate",
  retryAfterSessionFallback: "kernel.turn.retryAfterSessionFallback",
  beginFinalization: "kernel.turn.beginFinalization",
  markCommitted: "kernel.turn.markCommitted",
  settle: "kernel.turn.settle",
  finishTerminalization: "kernel.turn.finishTerminalization",
  confirmBackendHealthy: "kernel.turn.confirmBackendHealthy",
  requestCancel: "kernel.turn.requestCancel",
};

/**
 * §7.2's table, transcribed row for row, PLUS the `requestCancel` edges from §7.2's own
 * prose paragraph (lines 266-270, restated as a permission matrix in §8.4) — that
 * paragraph names sources, an action, and targets exactly like a table row, just not in
 * table syntax.
 *
 * Two same-state edges are marked `noOp`: `requestCancel` while already `stopping` or
 * already `terminalizing`. §8.4 point 4 names these explicitly — "`stopping` or
 * `terminalizing` returns accepted `no-op` for the same turn" — unlike every other
 * same-phase edge in this file, which is a real transition that just does not happen to
 * move the discrete phase (none of §7.2's other same-state edges exist; every other row
 * moves to a different phase).
 *
 * `retryAfterGate`'s "legal only while `attempt < 4`" precondition and `requestCancel`'s
 * finalizing-specific "after durable intent" pre/post-intent split are both preconditions
 * on data this coarse phase table cannot see (attempt count; intent-recorded flag) — the
 * table only proves the phase-level edge exists, exactly as `beginPageRemovePlan`'s
 * precondition does in the project machine. {@link canRetryAfterGate} is the attempt-side
 * helper; the intent-side check belongs to the guard/service layer, not this file.
 */
export const TURN_TRANSITION_TABLE: TransitionTable<TurnState, TurnAction> = {
  // `idle | beginAdmission | admitting`
  beginAdmission: [{ from: "idle", to: "admitting" }],
  // `admitting | finishAdmission | workspace-ready`
  finishAdmission: [{ from: "admitting", to: "workspace-ready" }],
  // `workspace-ready | beginAttempt | running`
  beginAttempt: [{ from: "workspace-ready", to: "running" }],
  // `running | beginStopping | stopping`
  beginStopping: [{ from: "running", to: "stopping" }],
  // `stopping | beginSnapshot | snapshotting`
  beginSnapshot: [{ from: "stopping", to: "snapshotting" }],
  // `admitting | beginTerminalization | terminalizing` — ADDED (fix-bundle spec §1.1, and
  // kernel-command-contract §7.2's matching new row). §7.2's table shipped `admitting` with
  // exactly two exits, `finishAdmission` and `requestCancel`, and `requestCancel` needs a
  // `turnId` a rejected admission never surfaced — so a failed admission had no edge at all and
  // stranded the machine in `admitting` for the life of the process. This is the outcome that
  // happens most often on a real project, so the table has to model it.
  // `stopping | beginTerminalization | terminalizing`
  // `validating | beginTerminalization | terminalizing`
  // `finalizing | beginTerminalization | terminalizing`
  beginTerminalization: [
    { from: "admitting", to: "terminalizing" },
    { from: "stopping", to: "terminalizing" },
    { from: "validating", to: "terminalizing" },
    { from: "finalizing", to: "terminalizing" },
  ],
  // `stopping | markBackendUnhealthy | backend-unhealthy`
  markBackendUnhealthy: [{ from: "stopping", to: "backend-unhealthy" }],
  // ADDED (design-agent-feedback-loop repair, Task 9) — kernel-command-contract §7.2's
  // original table sent EVERY backend failure from `stopping` straight to `terminalizing`
  // ("Used for confirmed cancellation or backend failure; no candidate is copied") because the
  // spec predates a backend failure the turn can actually recover from. A resume the session
  // checkpoint judged legitimate but the vendor rejected (`AgentRunOutcome.backend-error.cause
  // === "resume-rejected"`, `agent/types.ts`) is exactly that case: `core/turns/model/
  // session-plan.ts`'s `fallbackToFreshSession` builds a fresh-session plan for a genuine retry,
  // not a terminal failure — but `attempt.ts`'s `finalizeOutcome` has already driven `running ->
  // stopping` (`beginStopping`) unconditionally by the time `run-turn.ts` ever sees the failed
  // outcome, and the ONLY pre-existing edge back to `workspace-ready` was `retryAfterGate`
  // (`validating -> workspace-ready`), reachable only after a COMPLETED attempt's own
  // freeze+validation — never after a `failed` one. Mirrors `retryAfterGate`'s own shape
  // (a dedicated retry action, not a repurposed one) for the identical reason: a session
  // fallback is not a Gate retry and must not share its name or its attempt-budget semantics
  // (`run-turn.ts`'s own comment at the call site).
  // `stopping | retryAfterSessionFallback | workspace-ready`
  retryAfterSessionFallback: [{ from: "stopping", to: "workspace-ready" }],
  // `snapshotting | candidateCaptured | validating`
  candidateCaptured: [{ from: "snapshotting", to: "validating" }],
  // `validating | retryAfterGate | workspace-ready` — legal only while attempt < 4; see
  // canRetryAfterGate below. The table cannot see attempt, so the edge is unconditional
  // here.
  retryAfterGate: [{ from: "validating", to: "workspace-ready" }],
  // `validating | beginFinalization | finalizing`
  beginFinalization: [{ from: "validating", to: "finalizing" }],
  // `finalizing | markCommitted | committed`
  markCommitted: [{ from: "finalizing", to: "committed" }],
  // `committed | settle | idle`
  // `terminal | settle | idle`
  settle: [
    { from: "committed", to: "idle" },
    { from: "terminal", to: "idle" },
  ],
  // `terminalizing | finishTerminalization | terminal`
  finishTerminalization: [{ from: "terminalizing", to: "terminal" }],
  // `backend-unhealthy | confirmBackendHealthy | idle`
  confirmBackendHealthy: [{ from: "backend-unhealthy", to: "idle" }],
  // requestCancel prose: "legal from any active pre-intent phase. It moves a running
  // attempt to `stopping`; phases with no process move to `terminalizing` after their
  // current bounded service call acknowledges cancellation." `idle` has no active turn;
  // `committed`/`terminal`/`backend-unhealthy` are outside the "active pre-intent" set
  // this paragraph describes, so no edge exists from them here — an unlisted pair from
  // those phases falls through to the table-wide illegal code below.
  requestCancel: [
    { from: "admitting", to: "terminalizing" },
    { from: "workspace-ready", to: "terminalizing" },
    { from: "running", to: "stopping" },
    // §8.4 point 4: accepted no-op for a repeated cancel of the same turn.
    { from: "stopping", to: "stopping", noOp: true },
    { from: "snapshotting", to: "terminalizing" },
    { from: "validating", to: "terminalizing" },
    // Phase-legal; the pre/post-intent CANCEL_TOO_LATE split is the guard layer's.
    { from: "finalizing", to: "terminalizing" },
    { from: "terminalizing", to: "terminalizing", noOp: true },
  ],
};

/**
 * §7.2: "`turn.start` is rejected with `TURN_ALREADY_ACTIVE` in every non-idle state."
 * `beginAdmission` is the sole idle-entry action (the state machine's equivalent of
 * `turn.start`), listed only from `idle` above — so calling it from any other phase falls
 * through to this table-wide fallback and reads exactly as the spec's rule. As with the
 * project machine, this single code cannot be right for every OTHER unlisted pair too
 * (e.g. `settle` from `running` has no natural "already active" reading); selecting a more
 * specific code per command for those cases is the guard layer's job, not this machine's.
 */
const TURN_ILLEGAL_CODE = "TURN_ALREADY_ACTIVE";

/**
 * Builds one Kernel's turn model. A factory, not a module-level machine: §5 scopes Kernel
 * Reatom models to one Kernel process/context, and module-level state would let two
 * kernels — or two tests — share a phase and invalidate each other.
 */
export function reatomTurnStateMachine(): StateMachine<TurnState, TurnAction> {
  return createStateMachine<TurnState, TurnAction>({
    traceRoot: "kernel.turn",
    initial: "idle",
    table: TURN_TRANSITION_TABLE,
    illegalCode: TURN_ILLEGAL_CODE,
  });
}

// --- Attempt bookkeeping (§7.2: "Attempts are integers 1 through 4; every retry
// increments `attempt` and replaces `leaseNonce` before the next process starts.") -------

export const MIN_TURN_ATTEMPT = 1;
export const MAX_TURN_ATTEMPT = 4;

export type TurnAttempt = 1 | 2 | 3 | 4;

/** True when `value` is one of the four legal §7.2 attempt numbers. */
export function isTurnAttempt(value: number): value is TurnAttempt {
  return Number.isInteger(value) && value >= MIN_TURN_ATTEMPT && value <= MAX_TURN_ATTEMPT;
}

/**
 * §7.2: "`kernel.turn.retryAfterGate` is legal only while `attempt < 4`." The phase table
 * above cannot express this — `validating -> workspace-ready` is phase-legal regardless of
 * attempt — so the guard layer must call this helper before invoking `retryAfterGate`.
 */
export function canRetryAfterGate(attempt: TurnAttempt): boolean {
  return attempt < MAX_TURN_ATTEMPT;
}

// --- Terminal outcome (§7.2: "`terminal` carries `failed | cancelled | stale |
// interrupted`.") --------------------------------------------------------------------

export type TurnTerminalOutcome = "failed" | "cancelled" | "stale" | "interrupted";

/** The four §7.2 terminal outcomes, in spec order. */
export const TURN_TERMINAL_OUTCOMES: readonly TurnTerminalOutcome[] = [
  // §7.2 order, verbatim: "`terminal` carries `failed | cancelled | stale | interrupted`".
  "failed",
  "cancelled",
  "stale",
  "interrupted",
];
