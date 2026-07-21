import type { CommandKindV1, CommandRejectionCode, UInt64String, UUIDv7 } from "core/protocol"

/**
 * The revision check and its sole exception (kernel-command-contract §8.4).
 *
 * §8.4: "Normal dispatch requires `expectedRevision === stateRevision` before evaluating
 * the domain guard. Mismatch returns `STALE_REVISION`, the current revision, and no state
 * change." Every command except `turn.cancel` is checked that way, full stop.
 *
 * `turn.cancel` is carved out because an `Esc` keypress is generated from whatever
 * revision the UI last mirrored, which is very often already one frame stale by the time
 * it reaches the Kernel — see §8.4's own rationale: "This guard lets an `Esc` generated
 * from a slightly stale UI stop the intended run without ever cancelling a newer turn."
 * Tolerating staleness is safe only because the payload still has to name the exact
 * turn being cancelled — a stale revision never lets a command reach past the turn the
 * UI actually meant.
 *
 * This module knows nothing about the turn state machine itself (6C's
 * `reatomTurnStateMachine`, not yet built) beyond the narrow slice of fact §8.4's six
 * rules need: whether a turn is active, its id, its `TurnState` phase, and whether
 * finalizing has durably recorded commit intent. That slice is the injected
 * {@link TurnCancelProbe} below; 6C supplies the real implementation once the state
 * machine exists.
 */

/**
 * The closed set of `TurnState` phases (§7.2) that §8.4's six cancel rules distinguish.
 * Deliberately narrower than the full `TurnState` union: `idle` is represented by
 * {@link TurnCancelProbe.activeTurn} returning `null` (no active turn to name), and the
 * settle-only post-cancel states `committed` / `terminal` / `backend-unhealthy` are not
 * turn cancel targets — cancellation is never legal once a turn has left "active" for a
 * settle phase, so the probe simply reports no active turn there.
 *
 * `finalizing` covers both sides of rule 6's split: §7.2's `finalizing -> committed` row
 * is "legal only after durable committed marker; after intent, cancellation is forbidden",
 * while `finalizing -> terminalizing` is "legal only before intent". Both are the same
 * `TurnState` name, so the durable-intent boolean on {@link ActiveTurnCancelState} (not a
 * second phase value) is what §8.4 rule 6 actually keys on — inventing a fake phase name
 * like `"finalizing-committed"` would not be faithful to §7.2's vocabulary.
 */
export type TurnCancelPhase =
  | "admitting"
  | "workspace-ready"
  | "running"
  | "stopping"
  | "snapshotting"
  | "validating"
  | "finalizing"
  | "terminalizing"

/** The active turn's identity and cancel-relevant phase, as §8.4's rules need it. */
export interface ActiveTurnCancelState {
  readonly turnId: UUIDv7
  readonly phase: TurnCancelPhase
  /**
   * True once `finalizing` has durably recorded commit intent (§7.2's `finalizing ->
   * committed` transition rule: "Legal only after durable committed marker"). Only
   * meaningful when `phase` is `"finalizing"` — every other phase runs before any commit
   * intent could exist and this field is ignored there.
   */
  readonly durableIntentRecorded: boolean
}

/**
 * The narrow fact the cancel guard needs from the turn state machine: is a turn active,
 * and if so, which one and in what cancel-relevant phase. Injected rather than imported —
 * the turn state machine (6C) does not exist yet, and even once it does, this module must
 * not import it: the revision guard has to stay testable in isolation from turn lifecycle
 * wiring, matching how `KernelCounters` in `core/kernel` is injected into its callers
 * rather than reached for globally.
 */
export interface TurnCancelProbe {
  readonly activeTurn: () => ActiveTurnCancelState | null
}

/** The subset of §11.1's rejection codes this guard can produce. */
export type RevisionGuardRejectionCode = Extract<
  CommandRejectionCode,
  "STALE_REVISION" | "TURN_NOT_ACTIVE" | "TURN_ID_MISMATCH" | "CANCEL_TOO_LATE"
>

/**
 * A command as the guard needs to see it: every kind except `turn.cancel` is checked by
 * plain revision equality, while `turn.cancel` additionally carries the `turnId` its
 * payload names (§8.2: `turn.cancel`'s payload is `{ turnId }`) so rule 1 can be checked.
 */
export type RevisionGuardCommand =
  | {
      readonly kind: Exclude<CommandKindV1, "turn.cancel">
      readonly expectedRevision: UInt64String
    }
  | {
      readonly kind: "turn.cancel"
      readonly expectedRevision: UInt64String
      readonly turnId: UUIDv7
    }

/**
 * The guard's outcome. Three shapes, not a boolean, because the mailbox pipeline (§12.1)
 * needs to take three different next steps: continue on to the domain guard, stop and
 * publish an `Accepted` no-op result without calling any model action, or stop and publish
 * a `Rejected` result with a specific code and the current revision.
 */
export type RevisionGuardDecision =
  | { readonly kind: "proceed" }
  | { readonly kind: "accepted-no-op" }
  | {
      readonly kind: "rejected"
      readonly code: RevisionGuardRejectionCode
      readonly currentRevision: UInt64String
    }

/** Phases in which a repeated cancel for the same turn is already underway (§8.4 rule 4). */
const CANCEL_IN_PROGRESS_PHASES: ReadonlySet<TurnCancelPhase> = new Set(["stopping", "terminalizing"])

/**
 * Checks the revision guard for one command against the Kernel's current `stateRevision`.
 * Pure and side-effect free: `currentRevision` and the probe's snapshot are read exactly
 * once each, so the same inputs always produce the same decision.
 */
export function checkRevisionGuard(args: {
  readonly command: RevisionGuardCommand
  readonly currentRevision: UInt64String
  readonly cancelProbe: TurnCancelProbe
}): RevisionGuardDecision {
  const { command, currentRevision, cancelProbe } = args

  if (command.kind !== "turn.cancel") {
    return checkOrdinaryRevision({ expectedRevision: command.expectedRevision, currentRevision })
  }

  return checkCancelGuard({ turnId: command.turnId, currentRevision, cancelProbe })
}

/** §8.4's normal rule: exact equality or `STALE_REVISION`, nothing else considered. */
function checkOrdinaryRevision(args: {
  readonly expectedRevision: UInt64String
  readonly currentRevision: UInt64String
}): RevisionGuardDecision {
  if (args.expectedRevision === args.currentRevision) return { kind: "proceed" }
  return { kind: "rejected", code: "STALE_REVISION", currentRevision: args.currentRevision }
}

/** §8.4's `turn.cancel` exception, transcribing its six numbered rules in order. */
function checkCancelGuard(args: {
  readonly turnId: UUIDv7
  readonly currentRevision: UInt64String
  readonly cancelProbe: TurnCancelProbe
}): RevisionGuardDecision {
  const { turnId, currentRevision, cancelProbe } = args
  const active = cancelProbe.activeTurn()

  // Rule 5 (no active turn): nothing to cancel.
  if (active === null) return { kind: "rejected", code: "TURN_NOT_ACTIVE", currentRevision }

  // Rules 1 + 5 (different turn): the payload must name the exact current turnId. Checked
  // before anything else so a stale-revision cancel can never reach past the turn it
  // actually names, however the active turn's phase, into cancelling a newer one.
  if (active.turnId !== turnId) return { kind: "rejected", code: "TURN_ID_MISMATCH", currentRevision }

  // Rule 4: a repeat cancel for the same turn while already stopping/terminalizing is an
  // accepted no-op, not a fresh rejection or a fresh state transition.
  if (CANCEL_IN_PROGRESS_PHASES.has(active.phase)) return { kind: "accepted-no-op" }

  // Rule 6: once finalizing has durably recorded commit intent, cancellation is forbidden
  // and roll-forward must finish instead.
  if (active.phase === "finalizing" && active.durableIntentRecorded) {
    return { kind: "rejected", code: "CANCEL_TOO_LATE", currentRevision }
  }

  // Rules 2 + 3: the turn is active and still pre-intent — proceed regardless of how stale
  // `expectedRevision` was. Which target state this lands on (`stopping` for the running
  // cancellable phase, `terminalizing` for any other active pre-intent phase) is the turn
  // state machine's own transition (6C), not this guard's decision — the guard's only job
  // is deciding whether the command may reach that transition at all.
  return { kind: "proceed" }
}
