import type { CommandKindV1, UnavailableReason } from "core/protocol";

import type { KernelStateSnapshot } from "../types";

/**
 * kernel-command-contract §10.4 (lines 954-976), "Required turn-time capability matrix" —
 * the exact set of `CommandKindV1` members that become `unavailable: TURN_RUNNING` for
 * every moment `TurnState` is non-idle.
 *
 * Deliberately excludes:
 * - `turn.start` — §7.2 gives it its own specific code, `TURN_ALREADY_ACTIVE`
 *   ("`turn.start` is rejected with `TURN_ALREADY_ACTIVE` in every non-idle state"),
 *   produced directly by `model/guards.ts`'s turn family. Folding `turn.start` into this
 *   matrix too would add a second, lower-priority reason for the identical fact —
 *   `primaryReason` would pick `TURN_ALREADY_ACTIVE` over `TURN_RUNNING` anyway (§11.1's
 *   priority table ranks it first in the same tier), so the extra entry would be inert,
 *   not just redundant.
 * - `turn.cancel` — §10.4: "available for the exact active turn before commit intent,
 *   with the permissive revision rule." Explicitly not locked.
 * - `commit.plan`/`commit.confirm`/`commit.discardPlan` — §10.4: "The commit guards do
 *   NOT include `TURN_RUNNING`."
 * - `restore.discardPlan` — §10.4 names only "Restore planning, confirmation, and
 *   execution"; discarding an obsolete plan is a cleanup action, not a mutation, the same
 *   reason `turn.cancel` and the commit family stay unlocked.
 * - Read-only page-tab preview switching and local slash-command mode — §10.4: available
 *   when the preview/page guard permits it, or no Kernel command at all.
 */
export const TURN_LOCKED_KINDS: readonly CommandKindV1[] = [
  "chat.create",
  "chat.switch",
  "export.start",
  "model.select",
  "page.renameTitle",
  "page.removePlan",
  "page.removeConfirm",
  "page.removeDiscardPlan",
  "page.reorder",
  "restore.plan",
  "restore.confirm",
  "restore.retryRecord",
];

const TURN_LOCKED_KIND_SET: ReadonlySet<CommandKindV1> = new Set(TURN_LOCKED_KINDS);

/** True when `kind` is subject to §10.4's turn-time lock. */
export function isTurnLockedKind(kind: CommandKindV1): boolean {
  return TURN_LOCKED_KIND_SET.has(kind);
}

/**
 * `kind`'s §10.4 reason given `state`, or `null` when the matrix does not block it right
 * now — either because `kind` is not turn-locked at all, or because `TurnState` is
 * currently `idle`.
 *
 * A non-idle `TurnState` with a `null` `activeTurnId` is a broken snapshot invariant (every
 * non-idle phase implies an active turn — see `KernelStateSnapshot`'s own field comment).
 * Per the project's errore convention against silently swallowing an unexpected condition,
 * this is logged rather than treated as "unlocked" (which would let a turn-locked command
 * through while a turn is genuinely running) or crashing the guard (which must stay pure
 * and total): it still blocks, using §11.1's typed fallback `CAPABILITY_UNAVAILABLE`
 * instead of fabricating a `turnId` the snapshot does not actually have.
 */
export function turnLockedReason(
  kind: CommandKindV1,
  state: KernelStateSnapshot,
): UnavailableReason | null {
  if (!isTurnLockedKind(kind)) return null;
  if (state.turn.phase === "idle") return null;

  const { activeTurnId } = state.turn;
  if (activeTurnId === null) {
    console.warn(
      `turnLockedReason: turn.phase is "${state.turn.phase}" (non-idle) but activeTurnId is null; ` +
        `locking "${kind}" with CAPABILITY_UNAVAILABLE instead of a fabricated turnId`,
    );
    return { code: "CAPABILITY_UNAVAILABLE" };
  }

  return { code: "TURN_RUNNING", turnId: activeTurnId };
}
