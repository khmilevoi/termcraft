// `core/turns`'s public entry (CLAUDE.md "Code style": every module gets a root
// `index.ts`). The turn lifecycle (kernel-command-contract §7.2's full arc): admission
// mints a workspace, an attempt runs the backend, a completed attempt is frozen into an
// immutable Gate-facing candidate, Gate validates it (retrying with folded diagnostics or
// exhausting the attempt budget), and a passing candidate is committed through
// `finalizeTurn` — or any of those steps terminalizes the turn through `terminalizeTurn`.
//
// `runTurn` (`model/run-turn.ts`) is the composed driver most callers want — pure
// composition over every function below, never a machine transition of its own beyond the
// few phase-bridging edges those functions' own headers assign to "whichever caller
// decided" (see `run-turn.ts`'s own header). The six functions it composes, plus the
// session-resume and read-set-translation helpers those functions depend on, are exported
// individually too — a caller that only needs one phase (e.g. an orphan-recovery scan
// re-running just `terminalizeTurn`) should not have to go through the whole driver.

export type {
  AdmissionBlockedPhaseV1,
  AdmissionCandidatePinV1,
  AdmissionInputV1,
  AdmissionOutcomeV1,
  AdmissionWorkspaceMaterialV1,
  TurnContextV1,
} from "./types";

export { runAdmission } from "./model/admission";
export type { AdmissionDeps } from "./model/admission";

export { startTurnAttempt } from "./model/attempt";
export type {
  TurnAttemptDeps,
  TurnAttemptHandle,
  TurnAttemptInputV1,
  TurnAttemptOutcomeV1,
  TurnAttemptStartResultV1,
} from "./model/attempt";

export { diffTreeInventory, freezeTurnCandidate, selectChangedPages } from "./model/candidate";
export type {
  DesignFileChangeKindV1,
  DesignFileChangeV1,
  FreezeTurnCandidateDeps,
  FreezeTurnCandidateInputV1,
  FreezeTurnCandidateResultV1,
  TurnCandidateV1,
} from "./model/candidate";

export {
  ABSOLUTE_TURN_DEADLINE_MS,
  STREAM_SILENCE_MS,
  createTurnDeadlines,
} from "./model/deadlines";
export type {
  TurnDeadlineBound,
  TurnDeadlineCheckV1,
  TurnDeadlines,
  TurnDeadlinesDeps,
} from "./model/deadlines";

export { MAX_TURN_ATTEMPTS, TurnFenceError, createTurnFence } from "./model/fence";
export type { TurnFence } from "./model/fence";

export { finalizeTurn } from "./model/finalize";
export type { FinalizeTurnDeps, FinalizeTurnInputV1, FinalizeTurnResultV1 } from "./model/finalize";

export {
  StaleGateDiagnosticsError,
  appendPromptFold,
  foldGateDiagnosticsIntoPrompt,
} from "./model/prompt";
export type { TurnGateDiagnosticsV1, TurnGateFoldInputV1 } from "./model/prompt";

export { ReadSetTranslationError, toFinalizeReadSet } from "./model/read-set";

export { runTurn } from "./model/run-turn";
export type {
  RunTurnDeps,
  RunTurnFinalizeMaterialV1,
  RunTurnInputV1,
  RunTurnResultV1,
  RunTurnValidationMaterialV1,
} from "./model/run-turn";

export {
  advanceSessionCheckpoint,
  evaluateSessionPlan,
  fallbackToFreshSession,
} from "./model/session-plan";
export type {
  AdvanceSessionCheckpointDeps,
  AdvanceSessionCheckpointInputV1,
  EvaluateSessionPlanDeps,
  EvaluateSessionPlanInputV1,
  SessionFallbackDeps,
} from "./model/session-plan";

export { terminalizeTurn } from "./model/terminalize";
export type {
  TerminalizeTurnDeps,
  TerminalizeTurnInputV1,
  TerminalizeTurnResultV1,
} from "./model/terminalize";

export { runTurnValidation } from "./model/validation";
export type {
  RunTurnValidationInputV1,
  TurnValidationDeps,
  TurnValidationPageInputV1,
  TurnValidationResultV1,
} from "./model/validation";
