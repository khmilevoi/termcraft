/**
 * `core/machines`'s public entry point: the shared state-machine factory plus the seven
 * `reatom*StateMachine` factories it builds (kernel-command-contract §6's table, §7.1-§7.7).
 * Every export here is a pure re-export of an already-landed `model/*.ts` file — this
 * module contributes no new logic, only the barrel the project's module shape requires
 * (see the repo's CLAUDE.md "Code style" section: every module gets a root `types.ts` and
 * `index.ts`).
 */

export { createStateMachine } from "./model/state-machine";
export type {
  StateMachine,
  StateMachineConfig,
  Transition,
  TransitionOutcome,
  TransitionTable,
} from "./types";

// --- §7.1 Project model --------------------------------------------------------------
export type { ProjectAction, ProjectState } from "./model/project-machine";
export {
  PROJECT_ACTION_FULL_NAME,
  PROJECT_TRANSITION_TABLE,
  reatomProjectStateMachine,
} from "./model/project-machine";

// --- §7.2 Turn model -------------------------------------------------------------------
export type { TurnAction, TurnAttempt, TurnState, TurnTerminalOutcome } from "./model/turn-machine";
export {
  MAX_TURN_ATTEMPT,
  MIN_TURN_ATTEMPT,
  TURN_ACTION_FULL_NAME,
  TURN_TERMINAL_OUTCOMES,
  TURN_TRANSITION_TABLE,
  canRetryAfterGate,
  isTurnAttempt,
  reatomTurnStateMachine,
} from "./model/turn-machine";

// --- §7.3 Restore model ------------------------------------------------------------------
export type { RestoreAction, RestoreState } from "./model/restore-machine";
export { RESTORE_TRANSITION_TABLE, reatomRestoreStateMachine } from "./model/restore-machine";

// --- §7.4 Commit model -------------------------------------------------------------------
export type { CommitAction, CommitState } from "./model/commit-machine";
export { COMMIT_TRANSITION_TABLE, reatomCommitStateMachine } from "./model/commit-machine";

// --- §7.5 Export model -------------------------------------------------------------------
export type { ExportAction, ExportState } from "./model/export-machine";
export { EXPORT_TRANSITION_TABLE, reatomExportStateMachine } from "./model/export-machine";

// --- §7.6 Preview model ------------------------------------------------------------------
export type { PreviewAction, PreviewState } from "./model/preview-machine";
export { PREVIEW_TRANSITION_TABLE, reatomPreviewStateMachine } from "./model/preview-machine";

// --- §7.7 Migration model ----------------------------------------------------------------
export type { MigrationAction, MigrationState } from "./model/migration-machine";
export { MIGRATION_TRANSITION_TABLE, reatomMigrationStateMachine } from "./model/migration-machine";
