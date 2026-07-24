// `core/project`'s public entry (CLAUDE.md "Code style": every module gets a root
// `index.ts`) — kernel-assembly WP-1 Task 10. The project lifecycle's startup surface:
// TD §12's ordered open sequence, the KCC §7.1/§12.8 trust decision, the TD §7.7
// orphan/nonterminal-turn scan, the KCC §12.7 recovery routing `open-sequence.ts` composes,
// the `page.descriptorsChanged` diff/assembly, and the four page mutations plus the
// `PageRemovePlanV1` ledger `page.removePlan`/`page.removeConfirm`/`page.removeDiscardPlan`
// share. Every export here is a pure re-export of an already-landed `model/*.ts` file —
// this module contributes no new logic, only the barrel the project's module shape
// requires (matching `core/turns/index.ts`/`core/machines/index.ts`'s own precedent: every
// model file's full public surface, not a hand-picked subset).
//
// `core/kernel/model/handlers/project.ts` and `handlers/types.ts` previously deep-imported
// `core/project/model/*` directly as a documented stopgap awaiting exactly this file — both
// now import through this barrel instead.

// --- TD §12's ordered startup sequence -----------------------------------------------------
export type { OpenSequenceDeps, OpenSequenceOutcomeV1 } from "./model/open-sequence";
export { runOpenSequence } from "./model/open-sequence";

// --- KCC §7.1/§12.8 trust ------------------------------------------------------------------
export type { TrustResolutionDeps, TrustStatusV1 } from "./model/trust";
export { buildTrustStatus, grantImplicitTrust, resolveTrustDecision } from "./model/trust";

// --- TD §7.7 orphan/nonterminal-turn scan --------------------------------------------------
export type { OrphanTurnScanDeps } from "./model/orphan-turn-scan";
export { classifyOrphanTurns, scanOrphanTurns } from "./model/orphan-turn-scan";

// --- KCC §12.7 recovery routing ------------------------------------------------------------
export type { RecoveryRoutingMachines, RecoveryRoutingOutcomeV1 } from "./model/recovery-routing";
export { routeProjectRecovery } from "./model/recovery-routing";

// --- KCC §9 page.descriptorsChanged assembly -----------------------------------------------
export { PageDescriptorsAssemblyError } from "./model/descriptors";
export {
  computePageDescriptorChanges,
  buildPageDescriptorsChangedPayload,
} from "./model/descriptors";

// --- KCC §8.2 page mutations -----------------------------------------------------------------
export type {
  ConfirmPageRemoveDeps,
  ConfirmPageRemoveResultV1,
  DiscardPageRemovePlanDeps,
  DiscardPageRemovePlanResultV1,
  RenameTitleDeps,
  ReorderDeps,
  ReorderPagesResultV1,
} from "./model/page-mutations";
export {
  confirmPageRemove,
  discardPageRemovePlan,
  renameTitle,
  reorder,
} from "./model/page-mutations";

// --- KCC §7.1 page-remove-plan minting, drift detection, and its per-Kernel ledger ---------
export type {
  FreshPageRemoveFactsV1,
  MintPageRemovePlanInputV1,
  PageRemovePlanLedger,
  PlanDriftFieldV1,
} from "./model/page-remove-plan";
export {
  PageRemovePlanMintError,
  buildPageRemovePlan,
  computeFallbackPageSlug,
  computePageOrderHash,
  createPageRemovePlanLedger,
  detectPageRemovePlanDrift,
} from "./model/page-remove-plan";

// --- Shared vocabulary (`types.ts`) ---------------------------------------------------------
export type {
  IntendedRecoveryDomainV1,
  OpenSequenceBlockedV1,
  OpenSequenceStepV1,
  OrphanTurnCorruptReasonV1,
  OrphanTurnDecisionV1,
  TrustDecisionV1,
} from "./types";
