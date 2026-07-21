import type { Clock } from "infrastructure/clock";

/**
 * The two independent time bounds on one turn (kernel-command-contract §7.2, §11.2, and
 * the MVP roadmap's phase-6 sentence).
 *
 * They are deliberately NOT one timer with two reset paths, because they answer different
 * questions and only one of them may be extended:
 *
 * - The **stream-silence watchdog** asks "is the backend still producing anything?" It
 *   RESETS on every valid fenced event, because activity is exactly what it measures.
 * - The **absolute deadline** asks "has this turn overrun?" It is NON-RESETTABLE and spans
 *   the initial attempt plus every retry. §11.2 defines `TURN_DEADLINE_EXCEEDED` as the
 *   "Absolute turn deadline, unaffected by event noise."
 *
 * Collapsing them into a single resettable timer is the failure this split exists to
 * prevent: a backend chattering just under the silence window would keep the turn alive
 * forever, and the absolute bound is the ONLY thing standing between that and a runaway
 * turn holding a workspace and a lease indefinitely.
 *
 * There are no timers here. The bounds are evaluated on demand against an injected clock,
 * so a caller decides when to check and a test drives time by hand — no timer to leak, no
 * connect hook owning a lifetime (KCC §5 forbids that), and no test that waits 120 real
 * seconds.
 */

/** §7.2: a turn carries "a 30-minute default absolute deadline". */
export const ABSOLUTE_TURN_DEADLINE_MS = 30 * 60 * 1000;

/** The roadmap's "kernel-owned 120 s stream-silence watchdog". */
export const STREAM_SILENCE_MS = 120 * 1000;

/** Which bound expired. The two map to different outcomes downstream, so they stay distinct. */
export type TurnDeadlineBound = "stream-silence" | "absolute";

export type TurnDeadlineCheckV1 =
  | { readonly kind: "ok" }
  | { readonly kind: "expired"; readonly bound: TurnDeadlineBound };

export interface TurnDeadlinesDeps {
  readonly clock: Clock;
  /** Overridable so tests need no real elapsed time; production uses the constants above. */
  readonly absoluteMs?: number;
  readonly silenceMs?: number;
}

export interface TurnDeadlines {
  /** Records backend activity, resetting ONLY the silence watchdog. */
  readonly noteEvent: () => void;
  /** A new attempt is fresh activity, so it resets silence — but never the absolute bound. */
  readonly noteAttemptStarted: () => void;
  /** A resume that fell back to a fresh session is still the same turn. Silence only. */
  readonly noteSessionFallback: () => void;
  /** Evaluates both bounds against the current clock reading. */
  readonly check: () => TurnDeadlineCheckV1;
  /** The fixed instant the turn overruns, in epoch milliseconds. Never moves. */
  readonly absoluteDeadlineAt: () => number;
}

/**
 * Starts both bounds from "now". A factory per turn, not module-level state: two turns in
 * one process — or two tests — must never share a deadline.
 */
export function createTurnDeadlines(deps: TurnDeadlinesDeps): TurnDeadlines {
  const absoluteMs = deps.absoluteMs ?? ABSOLUTE_TURN_DEADLINE_MS;
  const silenceMs = deps.silenceMs ?? STREAM_SILENCE_MS;

  // Captured ONCE, at construction, and never assigned again. That single `const` is what
  // makes the absolute bound non-resettable — there is no code path, public or private,
  // that can move it.
  const absoluteDeadlineAt = deps.clock.now().getTime() + absoluteMs;

  // The only mutable instant. Every `note*` below touches this and nothing else.
  let lastActivityAt = deps.clock.now().getTime();

  function markActivity(): void {
    lastActivityAt = deps.clock.now().getTime();
  }

  function check(): TurnDeadlineCheckV1 {
    const now = deps.clock.now().getTime();
    // Absolute first: when a turn has both gone quiet AND overrun, "it overran" is the
    // honest description, and it is the one that forbids any further attempt.
    if (now >= absoluteDeadlineAt) return { kind: "expired", bound: "absolute" };
    if (now - lastActivityAt >= silenceMs) return { kind: "expired", bound: "stream-silence" };
    return { kind: "ok" };
  }

  return {
    noteEvent: markActivity,
    noteAttemptStarted: markActivity,
    noteSessionFallback: markActivity,
    check,
    absoluteDeadlineAt: () => absoluteDeadlineAt,
  };
}
