import { describe, expect, test } from "bun:test";

import type { Clock } from "infrastructure/clock";

import { ABSOLUTE_TURN_DEADLINE_MS, STREAM_SILENCE_MS, createTurnDeadlines } from "./deadlines";

/** A clock whose reading the test moves by hand — never wall time. */
function manualClock(startMs: number): Clock & { advance: (ms: number) => void } {
  let now = startMs;
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const T0 = 1_700_000_000_000;

describe("createTurnDeadlines", () => {
  test("the two bounds are the spec's values", () => {
    // §7.2 gives the turn "a 30-minute default absolute deadline"; the roadmap fixes the
    // stream-silence watchdog at 120 s.
    expect(ABSOLUTE_TURN_DEADLINE_MS).toBe(30 * 60 * 1000);
    expect(STREAM_SILENCE_MS).toBe(120 * 1000);
  });

  test("neither bound has expired at the moment the turn starts", () => {
    const clock = manualClock(T0);
    const deadlines = createTurnDeadlines({ clock });
    expect(deadlines.check()).toEqual({ kind: "ok" });
  });

  describe("the stream-silence watchdog", () => {
    test("expires after 120s of silence", () => {
      const clock = manualClock(T0);
      const deadlines = createTurnDeadlines({ clock });
      clock.advance(STREAM_SILENCE_MS);
      expect(deadlines.check()).toEqual({ kind: "expired", bound: "stream-silence" });
    });

    test("does not expire one millisecond early", () => {
      const clock = manualClock(T0);
      const deadlines = createTurnDeadlines({ clock });
      clock.advance(STREAM_SILENCE_MS - 1);
      expect(deadlines.check()).toEqual({ kind: "ok" });
    });

    test("RESETS on a valid fenced event", () => {
      const clock = manualClock(T0);
      const deadlines = createTurnDeadlines({ clock });

      clock.advance(STREAM_SILENCE_MS - 1);
      deadlines.noteEvent();
      // The full window is available again from the event, not from the turn start.
      clock.advance(STREAM_SILENCE_MS - 1);
      expect(deadlines.check()).toEqual({ kind: "ok" });

      clock.advance(1);
      expect(deadlines.check()).toEqual({ kind: "expired", bound: "stream-silence" });
    });

    test("resets on each attempt start, since a new attempt is fresh activity", () => {
      const clock = manualClock(T0);
      const deadlines = createTurnDeadlines({ clock });
      clock.advance(STREAM_SILENCE_MS - 1);
      deadlines.noteAttemptStarted();
      clock.advance(STREAM_SILENCE_MS - 1);
      expect(deadlines.check()).toEqual({ kind: "ok" });
    });
  });

  describe("the absolute deadline is NON-RESETTABLE", () => {
    test("expires 30 minutes after the turn started", () => {
      const clock = manualClock(T0);
      const deadlines = createTurnDeadlines({ clock });
      clock.advance(ABSOLUTE_TURN_DEADLINE_MS);
      expect(deadlines.check()).toEqual({ kind: "expired", bound: "absolute" });
    });

    test("event noise cannot push it out", () => {
      // §11.2: TURN_DEADLINE_EXCEEDED is the "Absolute turn deadline, unaffected by event
      // noise." A chatty backend must not be able to run forever by staying just under the
      // silence window — which is exactly what a single resettable deadline would allow.
      const clock = manualClock(T0);
      const deadlines = createTurnDeadlines({ clock });

      // Chatter every 60s for the whole 30 minutes: the silence watchdog never fires...
      for (let elapsed = 0; elapsed < ABSOLUTE_TURN_DEADLINE_MS; elapsed += 60_000) {
        clock.advance(60_000);
        expect(deadlines.check()).not.toEqual({ kind: "expired", bound: "stream-silence" });
        deadlines.noteEvent();
      }

      // ...and the absolute bound still fires on time.
      expect(deadlines.check()).toEqual({ kind: "expired", bound: "absolute" });
    });

    test("a retry cannot push it out — it covers the initial attempt plus all retries", () => {
      const clock = manualClock(T0);
      const deadlines = createTurnDeadlines({ clock });

      clock.advance(ABSOLUTE_TURN_DEADLINE_MS - 1);
      deadlines.noteAttemptStarted(); // attempt 2, 3, 4...
      deadlines.noteEvent();
      clock.advance(1);

      expect(deadlines.check()).toEqual({ kind: "expired", bound: "absolute" });
    });

    test("a session fallback cannot push it out", () => {
      // A resume that fails and falls back to a fresh session is still the same turn.
      const clock = manualClock(T0);
      const deadlines = createTurnDeadlines({ clock });

      clock.advance(ABSOLUTE_TURN_DEADLINE_MS - 1);
      deadlines.noteSessionFallback();
      clock.advance(1);

      expect(deadlines.check()).toEqual({ kind: "expired", bound: "absolute" });
    });

    test("no method on the handle can move the absolute start", () => {
      // A structural guard: if a future edit adds a reset path, this fails loudly rather
      // than silently uncapping the only bound on a runaway turn.
      const clock = manualClock(T0);
      const deadlines = createTurnDeadlines({ clock });
      const before = deadlines.absoluteDeadlineAt();

      deadlines.noteEvent();
      deadlines.noteAttemptStarted();
      deadlines.noteSessionFallback();
      clock.advance(5 * 60 * 1000);
      deadlines.noteEvent();

      expect(deadlines.absoluteDeadlineAt()).toBe(before);
    });
  });

  describe("precedence", () => {
    test("the absolute bound is reported when both have expired", () => {
      // Both are terminal, but they carry different meanings downstream: silence means the
      // backend went quiet, absolute means the turn overran. Reporting the absolute one is
      // the honest description of a turn that has been running for half an hour.
      const clock = manualClock(T0);
      const deadlines = createTurnDeadlines({ clock });
      clock.advance(ABSOLUTE_TURN_DEADLINE_MS);
      expect(deadlines.check()).toEqual({ kind: "expired", bound: "absolute" });
    });
  });

  test("bounds are configurable so tests need no real elapsed time", () => {
    const clock = manualClock(T0);
    const deadlines = createTurnDeadlines({ clock, absoluteMs: 10, silenceMs: 5 });
    clock.advance(5);
    expect(deadlines.check()).toEqual({ kind: "expired", bound: "stream-silence" });
  });
});
