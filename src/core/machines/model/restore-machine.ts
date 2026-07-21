import { type StateMachine, type TransitionTable, createStateMachine } from "./state-machine";

/**
 * The Restore model (kernel-command-contract §7.3).
 *
 * TIER C FOR THE MVP: no service drives this machine yet — the roadmap defers Git
 * history / Restore to a later phase. The transition table below is nonetheless the
 * complete §7.3 graph, fully tested: §13.1 requires every state/action pair be
 * enumerable, and a partial table here would only have to be reopened once Restore
 * actually lands. Nothing outside this file references it yet.
 *
 * "A plan is immutable and contains a UUIDv7 `restorePlanId`, page slug, full source
 * commit id, pre-Restore source hash, index state, immutable source/blob hash, a full
 * current-Gate attestation..." (§7.3) — plan contents, the transaction journal, and Gate
 * attestation are out of scope here; this file is only the `RestoreState` graph.
 */

export type RestoreState =
  | "idle"
  | "planning"
  | "awaiting-confirmation"
  | "executing"
  | "record-pending"
  | "recovering"
  | "blocked";

export type RestoreAction =
  | "kernel.restore.beginPlan"
  | "kernel.restore.planReady"
  | "kernel.restore.planFailed"
  | "kernel.restore.confirm"
  | "kernel.restore.discardPlan"
  | "kernel.restore.markRecordPending"
  | "kernel.restore.complete"
  | "kernel.restore.failBeforeIntent"
  | "kernel.restore.beginRecovery"
  | "kernel.restore.retryRecord"
  | "kernel.restore.blockRecovery"
  | "kernel.restore.retryRecovery";

/** §7.3's table, transcribed row for row; a multi-source row becomes one edge per source. */
export const RESTORE_TRANSITION_TABLE: TransitionTable<RestoreState, RestoreAction> = {
  "kernel.restore.beginPlan": [{ from: "idle", to: "planning" }],
  "kernel.restore.planReady": [{ from: "planning", to: "awaiting-confirmation" }],
  "kernel.restore.planFailed": [{ from: "planning", to: "idle" }],
  "kernel.restore.confirm": [{ from: "awaiting-confirmation", to: "executing" }],
  "kernel.restore.discardPlan": [{ from: "awaiting-confirmation", to: "idle" }],
  "kernel.restore.markRecordPending": [{ from: "executing", to: "record-pending" }],
  "kernel.restore.complete": [
    { from: "executing", to: "idle" },
    { from: "record-pending", to: "idle" },
    { from: "recovering", to: "idle" },
  ],
  // §7.3: "Under-mutex source/index/object/attestation-binding revalidation failed
  // before commit intent; no write occurred." Unlike Export/Migration's post-intent
  // `failBeforeIntent`, this one is PRE-intent and carries no journal-proof gate of its
  // own beyond the source state being `executing`.
  "kernel.restore.failBeforeIntent": [{ from: "executing", to: "idle" }],
  "kernel.restore.beginRecovery": [
    { from: "executing", to: "recovering" },
    { from: "idle", to: "recovering" },
  ],
  "kernel.restore.retryRecord": [{ from: "record-pending", to: "recovering" }],
  "kernel.restore.blockRecovery": [{ from: "recovering", to: "blocked" }],
  "kernel.restore.retryRecovery": [{ from: "blocked", to: "recovering" }],
};

/**
 * Builds one Kernel's Restore model. §11.1: `OPERATION_BUSY` is "The relevant
 * single-operation model is not idle" — Restore is exactly that kind of model, so every
 * unlisted (source, action) pair rejects with it.
 */
export function reatomRestoreStateMachine(): StateMachine<RestoreState, RestoreAction> {
  return createStateMachine<RestoreState, RestoreAction>({
    traceRoot: "kernel.restore",
    initial: "idle",
    table: RESTORE_TRANSITION_TABLE,
    illegalCode: "OPERATION_BUSY",
  });
}
