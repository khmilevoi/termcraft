import {
  EXPORT_TRANSITION_TABLE,
  MIGRATION_TRANSITION_TABLE,
  type MigrationAction,
  PREVIEW_TRANSITION_TABLE,
  PROJECT_TRANSITION_TABLE,
  type TransitionTable,
} from "core/machines";
import type { CapabilityTargetByKindV1, CommandKindV1, UnavailableReason } from "core/protocol";
import { deferredCapabilityReason } from "core/versions";

import type { CapabilityState, KernelStateSnapshot } from "../types";
import { turnLockedReason } from "./turn-lock";

/**
 * The one pure guard implementation (kernel-command-contract §10.2, lines 905-921): "Each
 * command family owns a pure guard over exactly `(currentKernelState,
 * CapabilityTargetByKindV1[K])`, returning `available` or a non-empty typed reason list."
 * §10.2 continues: "The capability projector calls the SAME function over the current
 * state and the same normalized target" — `model/projector.ts` imports
 * {@link evaluateCapabilityGuard} rather than reimplementing any of the logic below, which
 * is what makes capability/guard parity a structural fact rather than something that has
 * to be kept in sync by hand.
 *
 * `target` is typed `unknown` (not generic over `K`) so this function's call signature
 * matches `core/mailbox/types.ts`'s injected `GuardRegistry` seam exactly —
 * `(kind: CommandKindV1, target: GuardTarget, state: KernelStateSnapshot) => GuardDecision`
 * — without an adapter. Every `target` this function ever actually receives has already
 * passed through `model/target.ts`'s `extractCapabilityTarget` (§10.1: "The extractor
 * first validates `CommandPayloadByKindV1`, then normalizes the listed fields"), so the
 * per-kind casts below are narrowing an already-validated shape, not re-validating one —
 * PURE means no I/O and no re-parsing here, only reading the two arguments.
 */
export function evaluateCapabilityGuard(
  kind: CommandKindV1,
  target: unknown,
  state: KernelStateSnapshot,
): CapabilityState {
  const reasons = dedupeByCode(collectReasons(kind, target, state));
  if (reasons.length === 0) return { available: true };
  return { available: false, reasons: reasons as [UnavailableReason, ...UnavailableReason[]] };
}

function collectReasons(
  kind: CommandKindV1,
  target: unknown,
  state: KernelStateSnapshot,
): UnavailableReason[] {
  const candidates: readonly (UnavailableReason | null)[] = [
    projectNotReadyReason(kind, state),
    projectUntrustedReason(kind, state),
    migrationNotIdleReason(kind, state),
    turnLockedReason(kind, state),
    historicalSourceReason(kind, state),
    familySpecificReason(kind, target, state),
    deferredCapabilityReason(kind),
  ];
  return candidates.filter((reason): reason is UnavailableReason => reason !== null);
}

function dedupeByCode(reasons: readonly UnavailableReason[]): UnavailableReason[] {
  const seenCodes = new Set<string>();
  const result: UnavailableReason[] = [];
  for (const reason of reasons) {
    if (seenCodes.has(reason.code)) continue;
    seenCodes.add(reason.code);
    result.push(reason);
  }
  return result;
}

function isLegalTransition<Phase extends string, Action extends string>(
  table: TransitionTable<Phase, Action>,
  from: Phase,
  action: Action,
): boolean {
  const edges = table[action];
  if (edges === undefined) return false;
  return edges.some((edge) => edge.from === from);
}

// --- §7.1 (lines 222-228): PROJECT_NOT_READY / PROJECT_UNTRUSTED -----------------------

/**
 * §7.1: "All project-scoped commands except open/create/retry/close/trust and a trusted
 * pre-Workspace migration plan/confirmation reject with `PROJECT_NOT_READY` unless the
 * model is `ready`." These five own the project state-machine transition itself, so they
 * are checked by {@link familySpecificReason} against `PROJECT_TRANSITION_TABLE` instead.
 */
const PROJECT_NOT_READY_EXEMPT_KINDS: ReadonlySet<CommandKindV1> = new Set([
  "project.create",
  "project.open",
  "project.retryOpen",
  "project.close",
  "project.setTrust",
]);

function projectNotReadyReason(
  kind: CommandKindV1,
  state: KernelStateSnapshot,
): UnavailableReason | null {
  if (PROJECT_NOT_READY_EXEMPT_KINDS.has(kind)) return null;
  if (state.project.phase === "ready") return null;

  // §7.1's own exception: "a trusted pre-Workspace migration plan/confirmation."
  const isPreWorkspaceMigrationException =
    (kind === "migration.plan" || kind === "migration.confirm") &&
    state.project.phase === "opening" &&
    state.project.trust === "trusted";
  if (isPreWorkspaceMigrationException) return null;

  return { code: "PROJECT_NOT_READY" };
}

/**
 * §7.1: "In `untrusted-read-only` state, the only Kernel commands that remain available
 * are `project.setTrust`, `project.close`, and read-only `history.open` ... Every command
 * that executes page code or writes project/local state rejects with
 * `PROJECT_UNTRUSTED`." — a closed exemption list, not a predicate over "would this write
 * state"; §7.1 states the three survivors by name.
 */
const PROJECT_UNTRUSTED_EXEMPT_KINDS: ReadonlySet<CommandKindV1> = new Set([
  "project.setTrust",
  "project.close",
  "history.open",
]);

function projectUntrustedReason(
  kind: CommandKindV1,
  state: KernelStateSnapshot,
): UnavailableReason | null {
  if (state.project.trust !== "untrusted-read-only") return null;
  if (PROJECT_UNTRUSTED_EXEMPT_KINDS.has(kind)) return null;
  return { code: "PROJECT_UNTRUSTED" };
}

// --- §7.7 (lines 401-412): MigrationState === idle requirement -------------------------

/**
 * §7.7: "All ordinary project-mutation, turn, Restore, export, and commit guards require
 * `MigrationState === idle`; read-only diagnosis may remain available." `turn.cancel` is
 * excluded deliberately — §10.4 already marks it "permissive", and being unable to cancel
 * a running turn because an unrelated migration is mid-flight would be actively harmful.
 * No §11.1 code names "a migration is in progress" specifically, so this reuses
 * `CAPABILITY_UNAVAILABLE`, §11.1's own designated fallback "for a guard reason that has
 * no more specific public code" — the same reasoning `core/versions`'s Tier-C decision
 * documents for the deferred families.
 */
const MIGRATION_IDLE_REQUIRED_KINDS: ReadonlySet<CommandKindV1> = new Set([
  "page.renameTitle",
  "page.removePlan",
  "page.removeConfirm",
  "page.removeDiscardPlan",
  "page.reorder",
  "turn.start",
  "restore.plan",
  "restore.confirm",
  "restore.discardPlan",
  "restore.retryRecord",
  "export.start",
  "commit.plan",
  "commit.confirm",
  "commit.discardPlan",
]);

function migrationNotIdleReason(
  kind: CommandKindV1,
  state: KernelStateSnapshot,
): UnavailableReason | null {
  if (!MIGRATION_IDLE_REQUIRED_KINDS.has(kind)) return null;
  if (state.migration.phase === "idle") return null;
  return { code: "CAPABILITY_UNAVAILABLE" };
}

// --- §7.2 (lines 230-270): the turn family's own state-machine-derived reasons ----------

/**
 * §7.2: "`turn.start` is rejected with `TURN_ALREADY_ACTIVE` in every non-idle state."
 * Kept separate from §10.4's generic `turnLockedReason` matrix (see that file's header
 * comment) because this is the more specific code the same fact deserves.
 */
function turnStartReason(state: KernelStateSnapshot): UnavailableReason | null {
  if (state.turn.phase === "idle") return null;
  if (state.turn.activeTurnId === null) {
    console.warn(
      `evaluateCapabilityGuard: turn.phase is "${state.turn.phase}" (non-idle) but activeTurnId is null; ` +
        `rejecting turn.start with CAPABILITY_UNAVAILABLE instead of a fabricated turnId`,
    );
    return { code: "CAPABILITY_UNAVAILABLE" };
  }
  return { code: "TURN_ALREADY_ACTIVE", turnId: state.turn.activeTurnId };
}

/**
 * §7.2's `turn.cancel` prose (lines 265-269): "legal from any active pre-intent phase ...
 * A repeated request for the same turn while stopping/terminalizing is an accepted no-op.
 * In `finalizing` after durable intent it is rejected with `CANCEL_TOO_LATE`." §11.1 adds
 * `TURN_NOT_ACTIVE` ("No turn exists for cancellation") and `TURN_ID_MISMATCH` ("Cancel
 * names a different turn").
 */
function turnCancelReason(target: unknown, state: KernelStateSnapshot): UnavailableReason | null {
  const { turnId } = target as CapabilityTargetByKindV1["turn.cancel"];
  const { phase, activeTurnId, commitIntentRecorded } = state.turn;

  if (phase === "idle") return { code: "TURN_NOT_ACTIVE" };
  if (phase === "committed" || phase === "terminal" || phase === "backend-unhealthy") {
    return { code: "TURN_NOT_ACTIVE" };
  }
  if (activeTurnId === null) {
    console.warn(
      `evaluateCapabilityGuard: turn.phase is "${phase}" (active) but activeTurnId is null; ` +
        `rejecting turn.cancel with TURN_NOT_ACTIVE instead of comparing against a fabricated turnId`,
    );
    return { code: "TURN_NOT_ACTIVE" };
  }
  if (turnId !== activeTurnId) return { code: "TURN_ID_MISMATCH", turnId: activeTurnId };
  if (phase === "finalizing" && commitIntentRecorded)
    return { code: "CANCEL_TOO_LATE", turnId: activeTurnId };
  return null;
}

// --- Preview family: §7.6 phase legality plus the historical-source rule ---------------

const PREVIEW_HISTORICAL_BLOCKED_MODE = "interactive";

/** §7.6: "Tweaks and interactive mutation are unavailable on historical source." */
function previewHistoricalReason(
  target: unknown,
  state: KernelStateSnapshot,
): UnavailableReason | null {
  const { mode } = target as CapabilityTargetByKindV1["preview.setMode"];
  if (mode !== PREVIEW_HISTORICAL_BLOCKED_MODE) return null;
  if (state.preview.sourceKind !== "historical") return null;
  return { code: "HISTORICAL_PREVIEW_READ_ONLY" };
}

/**
 * The kinds §11.1 names verbatim for `HISTORICAL_PREVIEW_READ_ONLY`: "**Send**, Tweaks,
 * or **pin mutation** was requested on a historical source."
 *
 * `preview.setTweak` is absent from this set only because it is Tier-C deferred and never
 * reaches a source check — the code it would produce here is unreachable, not omitted.
 * `pin.setStatus` counts as pin mutation: §12.6 calls it a "user-action pin-status event",
 * i.e. a durable append, not a read.
 *
 * §10.2 makes this the Kernel's job specifically — "No UI predicate duplicates ...
 * historical-source checks" — so leaving it to the UI would be a contract violation, not
 * a division of labour.
 */
const HISTORICAL_SOURCE_BLOCKED_KINDS: ReadonlySet<CommandKindV1> = new Set([
  "turn.start",
  "pin.create",
  "pin.setStatus",
  "preview.setTweak",
]);

/** Blocks mutation of a historical source for the kinds §11.1 lists. */
function historicalSourceReason(
  kind: CommandKindV1,
  state: KernelStateSnapshot,
): UnavailableReason | null {
  if (!HISTORICAL_SOURCE_BLOCKED_KINDS.has(kind)) return null;
  if (state.preview.sourceKind !== "historical") return null;
  return { code: "HISTORICAL_PREVIEW_READ_ONLY" };
}

function previewFamilyReason(
  kind: Extract<CommandKindV1, `preview.${string}`>,
  target: unknown,
  state: KernelStateSnapshot,
): UnavailableReason | null {
  const phase = state.preview.phase;

  switch (kind) {
    case "preview.selectPage":
    case "preview.selectHistorical":
    case "preview.selectCurrent": {
      const legal =
        isLegalTransition(PREVIEW_TRANSITION_TABLE, phase, "kernel.preview.beginStart") ||
        isLegalTransition(PREVIEW_TRANSITION_TABLE, phase, "kernel.preview.beginSwitch");
      return legal ? null : { code: "OPERATION_BUSY" };
    }
    case "preview.resize":
      return isLegalTransition(PREVIEW_TRANSITION_TABLE, phase, "kernel.preview.resize")
        ? null
        : { code: "OPERATION_BUSY" };
    case "preview.setThemeCapabilities":
      return isLegalTransition(
        PREVIEW_TRANSITION_TABLE,
        phase,
        "kernel.preview.setThemeCapabilities",
      )
        ? null
        : { code: "OPERATION_BUSY" };
    case "preview.setMode": {
      if (!isLegalTransition(PREVIEW_TRANSITION_TABLE, phase, "kernel.preview.setMode")) {
        return { code: "OPERATION_BUSY" };
      }
      return previewHistoricalReason(target, state);
    }
    case "preview.retry":
      return isLegalTransition(PREVIEW_TRANSITION_TABLE, phase, "kernel.preview.retryCircuit")
        ? null
        : { code: "OPERATION_BUSY" };
    case "preview.close":
      return isLegalTransition(PREVIEW_TRANSITION_TABLE, phase, "kernel.preview.disable")
        ? null
        : { code: "OPERATION_BUSY" };
    case "preview.queryGeometry":
      return isLegalTransition(PREVIEW_TRANSITION_TABLE, phase, "kernel.preview.queryGeometry")
        ? null
        : { code: "OPERATION_BUSY" };
    // preview.forwardInput/setTweak are Tier-C deferred (core/versions); this family
    // function has nothing further to say about their phase legality.
    case "preview.forwardInput":
    case "preview.setTweak":
      return null;
  }
}

// --- Migration family: §7.7 phase legality (the machine's own transition table) --------

function migrationFamilyReason(
  kind: Extract<CommandKindV1, `migration.${string}`>,
  state: KernelStateSnapshot,
): UnavailableReason | null {
  const phase = state.migration.phase;
  const legalByAction: Readonly<Record<typeof kind, MigrationAction>> = {
    "migration.plan": "kernel.migration.beginPlan",
    "migration.confirm": "kernel.migration.confirm",
    "migration.discardPlan": "kernel.migration.discardPlan",
    "migration.retryRecovery": "kernel.migration.retryRecovery",
  };
  const legal = isLegalTransition(MIGRATION_TRANSITION_TABLE, phase, legalByAction[kind]);
  return legal ? null : { code: "CAPABILITY_UNAVAILABLE" };
}

// --- The per-kind dispatch table ---------------------------------------------------------

/**
 * Everything §10.2's guard needs beyond the three cross-cutting rules above
 * (PROJECT_NOT_READY/PROJECT_UNTRUSTED/MigrationState-idle) and §10.4's turn lock: the
 * seven state machines' OWN phase legality, expressed per kind. Kinds with no entry here
 * (`chat.*`, `model.select`, `page.*`, `selection.*`, `pin.*`, `history.open`) have no
 * machine of their own among the seven — §10.2's own next sentence is exactly why: "
 * Payload-only content/schema, freshness, token-ledger, and operation-specific mutex
 * checks run after the guard and are not capability inputs" — so nothing beyond the
 * cross-cutting rules applies to them at the guard layer.
 */
function familySpecificReason(
  kind: CommandKindV1,
  target: unknown,
  state: KernelStateSnapshot,
): UnavailableReason | null {
  switch (kind) {
    case "project.create":
      return isLegalTransition(PROJECT_TRANSITION_TABLE, state.project.phase, "beginCreate")
        ? null
        : { code: "CAPABILITY_UNAVAILABLE" };
    case "project.open":
      return isLegalTransition(PROJECT_TRANSITION_TABLE, state.project.phase, "beginOpen")
        ? null
        : { code: "CAPABILITY_UNAVAILABLE" };
    case "project.retryOpen":
      return isLegalTransition(PROJECT_TRANSITION_TABLE, state.project.phase, "retryOpen")
        ? null
        : { code: "CAPABILITY_UNAVAILABLE" };
    case "project.close":
      return isLegalTransition(PROJECT_TRANSITION_TABLE, state.project.phase, "beginClose")
        ? null
        : { code: "CAPABILITY_UNAVAILABLE" };
    case "project.setTrust":
      return isLegalTransition(PROJECT_TRANSITION_TABLE, state.project.phase, "setTrust")
        ? null
        : { code: "CAPABILITY_UNAVAILABLE" };

    case "turn.start":
      return turnStartReason(state);
    case "turn.cancel":
      return turnCancelReason(target, state);

    case "export.start":
      return isLegalTransition(EXPORT_TRANSITION_TABLE, state.export.phase, "kernel.export.begin")
        ? null
        : { code: "OPERATION_BUSY" };

    case "preview.selectPage":
    case "preview.selectHistorical":
    case "preview.selectCurrent":
    case "preview.resize":
    case "preview.setThemeCapabilities":
    case "preview.setMode":
    case "preview.forwardInput":
    case "preview.setTweak":
    case "preview.queryGeometry":
    case "preview.retry":
    case "preview.close":
      return previewFamilyReason(kind, target, state);

    case "migration.plan":
    case "migration.confirm":
    case "migration.discardPlan":
    case "migration.retryRecovery":
      return migrationFamilyReason(kind, state);

    default:
      return null;
  }
}
