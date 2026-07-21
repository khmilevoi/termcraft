import { createStateMachine, type StateMachine, type TransitionTable } from "./state-machine"

/**
 * The Migration model (kernel-command-contract §7.7).
 *
 * "An immutable migration plan has one UUIDv7 `migrationPlanId`; accepting its
 * confirmation has one distinct UUIDv7 `migrationActionId` that remains stable through
 * backup, publication, and recovery." (§7.7) — plan/action identity, backup storage, and
 * `MigrationTransaction` mechanics are out of scope here; this file is only the
 * `MigrationState` graph.
 */

export type MigrationState =
  | "idle"
  | "planning"
  | "awaiting-confirmation"
  | "backing-up"
  | "transforming"
  | "publishing"
  | "recovering"
  | "blocked"

export type MigrationAction =
  | "kernel.migration.beginPlan"
  | "kernel.migration.planReady"
  | "kernel.migration.planFailed"
  | "kernel.migration.confirm"
  | "kernel.migration.discardPlan"
  | "kernel.migration.backupVerified"
  | "kernel.migration.failBeforeIntent"
  | "kernel.migration.beginPublication"
  | "kernel.migration.complete"
  | "kernel.migration.beginRecovery"
  | "kernel.migration.completeRecovery"
  | "kernel.migration.blockRecovery"
  | "kernel.migration.retryRecovery"

/** §7.7's table, transcribed row for row; a multi-source row becomes one edge per source. */
export const MIGRATION_TRANSITION_TABLE: TransitionTable<MigrationState, MigrationAction> = {
  "kernel.migration.beginPlan": [{ from: "idle", to: "planning" }],
  "kernel.migration.planReady": [{ from: "planning", to: "awaiting-confirmation" }],
  "kernel.migration.planFailed": [{ from: "planning", to: "idle" }],
  "kernel.migration.confirm": [{ from: "awaiting-confirmation", to: "backing-up" }],
  "kernel.migration.discardPlan": [{ from: "awaiting-confirmation", to: "idle" }],
  "kernel.migration.backupVerified": [{ from: "backing-up", to: "transforming" }],
  // §7.7: "No project target changed" for backing-up/transforming — always legal, no
  // precondition beyond the source state. `publishing -> failBeforeIntent -> idle` is
  // the one edge in this row that IS gated: §7.7 says it is "Legal only when journal
  // inspection proves no durable commit intent exists; canonical targets remain
  // unchanged" — and §13.1 repeats it: "Export and Migration permit
  // `publishing -> failBeforeIntent -> idle` only with a journal proof of no durable
  // intent." A transition table can only say the edge IS legal, not "only with proof" —
  // enforcing that proof before calling `apply` here is the caller's (orchestration
  // slice's) job, not this factory's.
  "kernel.migration.failBeforeIntent": [
    { from: "backing-up", to: "idle" },
    { from: "transforming", to: "idle" },
    { from: "publishing", to: "idle" },
  ],
  "kernel.migration.beginPublication": [{ from: "transforming", to: "publishing" }],
  "kernel.migration.complete": [{ from: "publishing", to: "idle" }],
  "kernel.migration.beginRecovery": [
    { from: "publishing", to: "recovering" },
    { from: "idle", to: "recovering" },
  ],
  "kernel.migration.completeRecovery": [{ from: "recovering", to: "idle" }],
  "kernel.migration.blockRecovery": [{ from: "recovering", to: "blocked" }],
  "kernel.migration.retryRecovery": [{ from: "blocked", to: "recovering" }],
}

/**
 * Builds one Kernel's Migration model. §11.1: `OPERATION_BUSY` is "The relevant
 * single-operation model is not idle" — Migration is exactly that kind of model, so
 * every unlisted (source, action) pair rejects with it.
 */
export function reatomMigrationStateMachine(): StateMachine<MigrationState, MigrationAction> {
  return createStateMachine<MigrationState, MigrationAction>({
    traceRoot: "kernel.migration",
    initial: "idle",
    table: MIGRATION_TRANSITION_TABLE,
    illegalCode: "OPERATION_BUSY",
  })
}
