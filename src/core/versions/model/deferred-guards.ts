import type { CommandKindV1, UnavailableReason } from "core/protocol";

/**
 * The SINGLE home of the MVP Tier-C "deferred family" decision
 * (`docs/superpowers/plans/2026-07-21-mvp-phase-6-core.md` Decision D1, lines 75-83).
 *
 * KCC §10.2 fixes capability/guard parity as an invariant: "for the same state and target,
 * a published available capability must let a direct current-revision command pass the
 * guard, and an unavailable capability must reject it with the same primary code." That
 * invariant is only mechanically guaranteed if both the capability projector (6C's
 * `core/capabilities/model/projector.ts`) and the dispatch-time guard route through the
 * exact same function for the "no service exists yet" decision — two independently
 * hand-written `CAPABILITY_UNAVAILABLE` literals could drift (a typo, a forgotten kind, a
 * later swap to a different code on only one path) without any type system catching it.
 * This file is that one function.
 *
 * Ten of the 43 `CommandKindV1` members have a complete transition table and a complete
 * guard (KCC §7.3/§7.4/§7.6, §13.1), but MVP phase 6 builds no adapter behind them — no
 * Git executable integration for Restore/commit, no page-history reader, no live
 * interactive-forwarding/Tweaks channel. Tier C's own description names the consequence
 * directly: "their guards return `available: false` with a typed reason, so no service is
 * ever reached." `deferredCapabilityReason` is that typed reason, always, regardless of
 * what the seven state machines currently say — the whole point is that these kinds never
 * become reachable by getting the machine into some particular phase.
 *
 * `CAPABILITY_UNAVAILABLE` was chosen over `GIT_UNAVAILABLE` deliberately. §11.1 defines
 * `GIT_UNAVAILABLE` as "Installed Git cannot be used" — a claim about the user's Git
 * installation, which the MVP has no way to know and, for most users, is simply false: Git
 * is very likely installed and perfectly usable. termcraft just has not shipped a Git
 * adapter to call it with yet. Reporting `GIT_UNAVAILABLE` would tell the user to go fix a
 * problem that does not exist. `CAPABILITY_UNAVAILABLE` is §11.1's own designated escape
 * hatch for exactly this situation: "Typed fallback for a guard reason that has no more
 * specific public code." `history.open` and `preview.forwardInput`/`preview.setTweak`
 * are not Git-related at all, which independently rules out `GIT_UNAVAILABLE` for them —
 * one shared code across all ten kinds is the only choice that is honest for every one of
 * them at once.
 */

/** The exact 10 Tier-C `CommandKindV1` members this MVP phase never routes to a service. */
export const DEFERRED_CAPABILITY_KINDS: readonly CommandKindV1[] = [
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
];

const DEFERRED_CAPABILITY_KIND_SET: ReadonlySet<CommandKindV1> = new Set(DEFERRED_CAPABILITY_KINDS);

/** True when `kind` is one of the 10 Tier-C kinds with no MVP service behind its guard. */
export function isDeferredCapabilityKind(kind: CommandKindV1): boolean {
  return DEFERRED_CAPABILITY_KIND_SET.has(kind);
}

/**
 * §11.1's typed fallback, as a fixed value: no code-specific detail, per
 * `detailsFreeReason("CAPABILITY_UNAVAILABLE")` in `core/protocol`'s own
 * `unavailable-reason.ts`.
 */
// Frozen because one object is handed to every caller for all ten deferred kinds. §11.1
// calls user-facing prose "presentation data", so a consumer decorating a reason with a
// display message is a plausible thing to write — and against a shared mutable singleton
// that decoration would leak process-wide into every other kind's reason, permanently.
const CAPABILITY_UNAVAILABLE_REASON: UnavailableReason = Object.freeze({
  code: "CAPABILITY_UNAVAILABLE",
});

/**
 * `kind`'s Tier-C reason, or `null` when `kind` has a real MVP service and this file has
 * nothing to say about it. Both `core/capabilities/model/guards.ts` (the dispatch-time
 * guard) and `core/capabilities/model/projector.ts` (via that same guard) call this, which
 * is what makes the primary code identical on both paths.
 */
export function deferredCapabilityReason(kind: CommandKindV1): UnavailableReason | null {
  if (!isDeferredCapabilityKind(kind)) return null;
  return CAPABILITY_UNAVAILABLE_REASON;
}
