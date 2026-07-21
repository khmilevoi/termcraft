import { createStateMachine, type StateMachine, type TransitionTable } from "./state-machine"

/**
 * The Export model (kernel-command-contract §7.5).
 *
 * "Export uses [`ProjectWritePermit`] only to capture one coherent source/settings
 * snapshot, releases it before rendering, and reacquires the full transaction boundary
 * for publication." (§4/§5) — none of that permit/mutex/transaction machinery lives
 * here. This file is only the table §7.5 fixes: the legal `ExportState` graph and its
 * named actions. The service that actually renders and publishes (out of scope for 6C)
 * drives this machine; it does not reimplement its legality.
 */

export type ExportState = "idle" | "preparing" | "rendering" | "publishing" | "recovering" | "blocked"

export type ExportAction =
  | "kernel.export.begin"
  | "kernel.export.beginRendering"
  | "kernel.export.beginPublication"
  | "kernel.export.complete"
  | "kernel.export.fail"
  | "kernel.export.failBeforeIntent"
  | "kernel.export.beginRecovery"
  | "kernel.export.completeRecovery"
  | "kernel.export.blockRecovery"
  | "kernel.export.retryRecovery"

/** §7.5's table, transcribed row for row; a multi-source row becomes one edge per source. */
export const EXPORT_TRANSITION_TABLE: TransitionTable<ExportState, ExportAction> = {
  "kernel.export.begin": [{ from: "idle", to: "preparing" }],
  "kernel.export.beginRendering": [{ from: "preparing", to: "rendering" }],
  "kernel.export.beginPublication": [{ from: "rendering", to: "publishing" }],
  "kernel.export.complete": [{ from: "publishing", to: "idle" }],
  "kernel.export.fail": [
    { from: "preparing", to: "idle" },
    { from: "rendering", to: "idle" },
  ],
  // §7.5: "Legal only when journal inspection proves no durable commit intent exists;
  // candidate artifacts remain unreachable and no publication becomes visible." A
  // transition table can only express which (source, action) pairs are LEGAL, not a
  // precondition external to Kernel state — the journal-proof check is the caller's
  // (the orchestration/service slice's) job before it ever calls `apply` with this
  // action; §13.1 makes the same point: "Export and Migration permit
  // `publishing -> failBeforeIntent -> idle` only with a journal proof of no durable
  // intent."
  "kernel.export.failBeforeIntent": [{ from: "publishing", to: "idle" }],
  "kernel.export.beginRecovery": [
    { from: "publishing", to: "recovering" },
    { from: "idle", to: "recovering" },
  ],
  "kernel.export.completeRecovery": [{ from: "recovering", to: "idle" }],
  "kernel.export.blockRecovery": [{ from: "recovering", to: "blocked" }],
  "kernel.export.retryRecovery": [{ from: "blocked", to: "recovering" }],
}

/**
 * Builds one Kernel's Export model. §11.1: `OPERATION_BUSY` is "The relevant
 * single-operation model is not idle" — Export is exactly that kind of model, so every
 * unlisted (source, action) pair rejects with it.
 */
export function reatomExportStateMachine(): StateMachine<ExportState, ExportAction> {
  return createStateMachine<ExportState, ExportAction>({
    traceRoot: "kernel.export",
    initial: "idle",
    table: EXPORT_TRANSITION_TABLE,
    illegalCode: "OPERATION_BUSY",
  })
}
