import { DEFERRED_CAPABILITY_KINDS } from "core/versions";

import { type CommandHandlerMap, type DeferredHandlerKind, noOpOutcome } from "./types";

/**
 * The Tier-C deferred family's rejection handler (kernel-assembly WP-1 task 9, STEP A).
 *
 * These are EXACTLY the 10 kinds `core/versions`'s `DEFERRED_CAPABILITY_KINDS` names —
 * `deferredCapabilityReason` returns `CAPABILITY_UNAVAILABLE` for every one of them
 * UNCONDITIONALLY, regardless of any machine's phase (`deferred-guards.ts`'s own
 * `isDeferredCapabilityKind` check has no state parameter at all). Because
 * `evaluateCapabilityGuard` runs `deferredCapabilityReason(kind)` as one of its
 * unconditional `collectReasons` checks (`capabilities/model/guards.ts:56`), the guard
 * ALWAYS returns `available: false` for these 10 kinds, and `dispatch.ts`'s own §12.1
 * step 3 ("A failure records and returns Rejected without a model transition") means the
 * handler below is NEVER actually invoked by a correctly-wired Kernel — the rejection
 * happens at the guard, before `handle()` is ever called.
 *
 * So `rejectDeferred` is a DEFENSIVE backstop, not the rejection mechanism itself: it
 * exists only so `createHandlerRegistry`'s total map has something well-formed to call if
 * that invariant is ever violated (a future guard change, a direct unit-test bypass of
 * the guard layer). It deliberately does NOT reconstruct or reference an
 * `UnavailableReason` itself — `HandlerOutcome` (`core/mailbox`) has no field to carry one
 * (a handler is never the layer that reports "rejected"; see `types.ts`'s own
 * `CommandHandler` doc) — so there is no reason shape to invent here. The REAL rejection
 * reason lives solely in `core/versions`'s `deferredCapabilityReason`, consumed by the
 * guard; this file's own test proves that mechanism for all 10 kinds directly, which is
 * what "do not invent a reason shape" (Task 9 brief) requires: not a second, handler-side
 * echo of `CAPABILITY_UNAVAILABLE`, just a no-op that never drives a machine.
 *
 * `migration.*` is DELIBERATELY ABSENT from this file, despite the kernel-assembly plan's
 * Global Constraints text grouping "restore/commit/migration" as one Tier-C group. Checked
 * against the real guard (`capabilities/model/guards.ts`):
 * - `DEFERRED_CAPABILITY_KINDS` (`core/versions`) lists exactly `restore.plan/confirm/
 *   discardPlan/retryRecord`, `commit.plan/confirm/discardPlan`, `history.open`,
 *   `preview.forwardInput`, `preview.setTweak` — 4 + 3 + 1 + 2 = 10 kinds. No
 *   `migration.*` member is in that list.
 * - `familySpecificReason`'s `migration.plan | migration.confirm | migration.discardPlan
 *   | migration.retryRecovery` case (`guards.ts:400-404`) calls `migrationFamilyReason`,
 *   which evaluates REAL phase legality against `MIGRATION_TRANSITION_TABLE`
 *   (`core/machines/model/migration-machine.ts`) — e.g. `kernel.migration.beginPlan` IS
 *   legal from the machine's own `idle` initial phase. `projectNotReadyReason` also
 *   carves out `migration.plan`/`migration.confirm`'s own §7.1 "trusted pre-Workspace"
 *   exception (`guards.ts:105-110`) — a state-dependent carve-out that would be
 *   meaningless for a kind the guard rejects unconditionally anyway.
 * - So `migration.*` commands CAN pass the guard today, under a legal state — they are
 *   NOT unconditionally Tier-C-deferred the way this file's 10 kinds are.
 *
 * Given that, routing `migration.*` through THIS handler (silently no-op-ing a
 * guard-accepted command) would misrepresent what the guard actually decided, and forging
 * a `deferredCapabilityReason`-shaped rejection for a kind `core/versions` does not cover
 * would be inventing a reason shape this file is explicitly told not to invent. `migration.*`
 * has no owning family module yet either (Task 9's Step B family list — project, chat,
 * page, pin, selection, turn, preview, export, model — does not include it). Until a
 * "migration" family lands (or a deliberate decision extends `core/versions` to cover it
 * for real), its four kinds get the SAME well-formed not-yet-implemented no-op the other
 * nine unbuilt families get — see `./index.ts`'s own header comment — never this file's
 * handler. See the task report for the full writeup; this is a flagged, non-blocking gap
 * for whoever picks up `migration` next, not a silent guess.
 */

/**
 * Re-exported from `./types` (fix round 2) — `DeferredHandlerKind` now has exactly ONE
 * declaration site (`types.ts`), so `FamilyHandlerMap` (`./types.ts`) can `Exclude` it from
 * every family's contract without `types.ts` importing FROM this file (see that type's own
 * comment for why the direction matters — this file already imports `CommandHandlerMap`/
 * `noOpOutcome` from `./types`, so a reverse import back into `./types` would be circular).
 * This file still owns the runtime tuple below and the `migration.*` investigation in the
 * header comment above; only the bare literal-union type moved.
 */
export type { DeferredHandlerKind };

/** The literal tuple this file's own test cross-checks against `core/versions`'s runtime list. */
export const DEFERRED_HANDLER_KINDS = [
  "restore.plan",
  "restore.confirm",
  "restore.discardPlan",
  "restore.retryRecord",
  "commit.plan",
  "commit.confirm",
  "commit.discardPlan",
  "history.open",
  "preview.forwardInput",
  "preview.setTweak",
] as const satisfies readonly DeferredHandlerKind[];

/** Re-exported so a consistency test can compare this file's own list against `core/versions`'s. */
export { DEFERRED_CAPABILITY_KINDS };

/**
 * The one shared handler for all 10 deferred kinds — see this file's header for why it
 * never inspects `payload`/`context` and always returns the same well-formed no-op.
 */
function rejectDeferred(): ReturnType<typeof noOpOutcome> {
  return noOpOutcome();
}

export const deferredHandlers: CommandHandlerMap<DeferredHandlerKind> = {
  "restore.plan": rejectDeferred,
  "restore.confirm": rejectDeferred,
  "restore.discardPlan": rejectDeferred,
  "restore.retryRecord": rejectDeferred,
  "commit.plan": rejectDeferred,
  "commit.confirm": rejectDeferred,
  "commit.discardPlan": rejectDeferred,
  "history.open": rejectDeferred,
  "preview.forwardInput": rejectDeferred,
  "preview.setTweak": rejectDeferred,
};
