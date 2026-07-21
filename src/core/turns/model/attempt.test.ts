import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import {
  type StateMachine,
  type TurnAction,
  type TurnState,
  reatomTurnStateMachine,
} from "core/machines";
import type { AgentTask } from "core/ports";
import { type FakeAgentBackend, createFakeAgentBackend } from "core/ports/fakes";
import type { Clock } from "infrastructure/clock";

import {
  type TurnAttemptDeps,
  type TurnAttemptHandle,
  type TurnAttemptOutcomeV1,
  startTurnAttempt,
} from "./attempt";
import { STREAM_SILENCE_MS, type TurnDeadlines, createTurnDeadlines } from "./deadlines";
import { type TurnFence, createTurnFence } from "./fence";

/**
 * `startTurnAttempt` end to end against 6D's fakes only, matching `admission.test.ts`'s
 * own harness style — no real process, no real disk, no real clock. Every test body lives
 * inside one `context.start(async () => {...})` call; every promise this file's own code
 * hands back is `await wrap(...)`-ed, for the identical reason `admission.test.ts`'s header
 * documents.
 */

const TURN_ID = "0192f6f0-0000-7000-8000-00000000aaaa";
const T0 = 1_700_000_000_000;

/**
 * An ADVANCING clock. A frozen one (`now: () => new Date(startMs)`) makes every
 * `deadlines.check()` return `{kind:"ok"}` unconditionally, so assertions built on it are
 * tautologies — deleting the whole `noteEvent`/`noteAttemptStarted` wiring from attempt.ts
 * then passes the suite, and nothing proves the Kernel feeds the silence watchdog at all.
 */
function manualClock(startMs: number): Clock & { advance: (ms: number) => void } {
  let now = startMs;
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function machineAtWorkspaceReady(): StateMachine<TurnState, TurnAction> {
  const m = reatomTurnStateMachine();
  m.apply("beginAdmission");
  m.apply("finishAdmission");
  return m;
}

function openFence(turnId: string = TURN_ID): TurnFence {
  const fence = createTurnFence(turnId);
  if (fence instanceof Error) throw fence;
  return fence;
}

function baseTask(): Omit<AgentTask, "fence"> {
  return {
    workspacePath: "/fake/workspace",
    systemPrompt: "system",
    userMessage: "hello",
    model: "fake-model",
    effort: "medium",
    session: { kind: "fresh", seed: [] },
  };
}

type PublishedEvent = Parameters<TurnAttemptDeps["publish"]>[0];

function harness(clock: Clock & { advance: (ms: number) => void } = manualClock(T0)) {
  const machine = machineAtWorkspaceReady();
  const agentBackend = createFakeAgentBackend();
  const deadlines = createTurnDeadlines({ clock });
  const fence = openFence();
  const published: PublishedEvent[] = [];
  const deps: TurnAttemptDeps = {
    machine,
    agentBackend,
    deadlines,
    publish: (event) => published.push(event),
  };
  return { deps, machine, agentBackend, deadlines, fence, published, clock };
}

/** Narrows the `TurnFenceError | TurnAttemptStartResultV1` union down to a live handle. */
function begin(deps: TurnAttemptDeps, fence: TurnFence): TurnAttemptHandle {
  const result = startTurnAttempt(deps, { turnId: TURN_ID, fence, task: baseTask() });
  if (result instanceof Error) throw result;
  if (result.kind === "illegal") throw new Error(`unexpected illegal: ${result.code}`);
  return result.handle;
}

describe("startTurnAttempt — workspace-ready -> running -> stopping", () => {
  test("illegal from a non-workspace-ready phase: returns illegal, mints no lease, starts nothing", async () => {
    await context.start(async () => {
      const h = harness();
      h.machine.apply("beginAttempt"); // already "running" before this call

      const result = startTurnAttempt(h.deps, {
        turnId: TURN_ID,
        fence: h.fence,
        task: baseTask(),
      });

      expect(result).toEqual({ kind: "illegal", code: "TURN_ALREADY_ACTIVE" });
      expect(h.fence.currentLease()).toBeNull();
      expect(h.agentBackend.calls).toEqual([]);
    });
  });

  test("mints attempt 1's lease, starts the backend with it, and moves running", async () => {
    await context.start(async () => {
      const h = harness();
      begin(h.deps, h.fence);

      expect(h.machine.phase()).toBe("running");
      const lease = h.fence.currentLease();
      if (lease === null) throw new Error("expected a live lease");
      expect(lease).toEqual({ turnId: TURN_ID, attempt: 1, leaseNonce: expect.any(String) });
      expect(h.agentBackend.calls).toEqual([{ method: "startTurn", fence: lease }]);
    });
  });

  test("emits turn.attemptStarted with turnId/attempt/the ABSOLUTE deadline before any progress event", async () => {
    await context.start(async () => {
      const h = harness(manualClock(T0));
      begin(h.deps, h.fence);

      expect(h.published).toEqual([
        {
          kind: "turn.attemptStarted",
          payload: {
            turnId: TURN_ID,
            attempt: 1,
            deadline: new Date(h.deadlines.absoluteDeadlineAt()).toISOString(),
          },
          correlation: { turnId: TURN_ID },
        },
      ]);
    });
  });

  test("starting an attempt resets the silence watchdog", async () => {
    // Asserted by MOVING the clock: the bound must actually shift, which is the only thing
    // a frozen clock could never show. Without noteAttemptStarted, the silence window would
    // still be counted from the harness's construction and would expire here.
    await context.start(async () => {
      const h = harness();
      h.clock.advance(STREAM_SILENCE_MS - 1);

      begin(h.deps, h.fence);

      // Almost a full window has passed since construction, so only a reset can keep this ok.
      h.clock.advance(STREAM_SILENCE_MS - 1);
      expect(h.deadlines.check()).toEqual({ kind: "ok" });

      h.clock.advance(1);
      expect(h.deadlines.check()).toEqual({ kind: "expired", bound: "stream-silence" });
    });
  });

  test("a valid fenced event resets the silence watchdog; a STALE one does not", async () => {
    // The real negative: a stale event must not keep a silent turn alive. With a frozen
    // clock both halves were vacuous.
    await context.start(async () => {
      const h = harness();
      const handle = begin(h.deps, h.fence);
      const lease = h.fence.currentLease();
      if (lease === null) throw new Error("expected a live lease");

      h.clock.advance(STREAM_SILENCE_MS - 1);
      h.agentBackend.emitEvent(lease, { kind: "reasoning", text: "still working" });
      await wrap(Bun.sleep(0));
      h.clock.advance(STREAM_SILENCE_MS - 1);
      expect(h.deadlines.check()).toEqual({ kind: "ok" });

      // A stale lease: same turn, wrong attempt. It must be dropped, so silence keeps running.
      const stale = { ...lease, attempt: lease.attempt + 1 };
      h.agentBackend.emitEvent(stale, { kind: "reasoning", text: "from a dead attempt" });
      await wrap(Bun.sleep(0));
      h.clock.advance(1);
      expect(h.deadlines.check()).toEqual({ kind: "expired", bound: "stream-silence" });

      void handle;
    });
  });

  test("a valid fenced event notes deadlines.noteEvent and emits turn.progress", async () => {
    await context.start(async () => {
      const h = harness();
      const handle = begin(h.deps, h.fence);
      const lease = h.fence.currentLease();
      if (lease === null) throw new Error("expected a live lease");

      h.agentBackend.emitEvent(lease, { kind: "reasoning", text: "thinking" });
      await Bun.sleep(0);

      expect(h.published).toEqual([
        expect.anything(), // turn.attemptStarted
        {
          kind: "turn.progress",
          payload: {
            turnId: TURN_ID,
            attempt: 1,
            content: { kind: "reasoning", text: "thinking" },
          },
          correlation: { turnId: TURN_ID },
        },
      ]);

      h.agentBackend.completeRun(lease, {
        kind: "completed",
        finalText: "done",
        usage: null,
        sessionId: "s1",
      });
      await wrap(handle.outcome);
    });
  });

  test("an event carrying a stale fence is dropped: no deadlines.noteEvent, no turn.progress", async () => {
    await context.start(async () => {
      const h = harness();
      const handle = begin(h.deps, h.fence);
      const staleLease = h.fence.currentLease();
      if (staleLease === null) throw new Error("expected a live lease");

      // Simulate the turn having moved on to a second attempt while this run's stream is
      // still delivering an in-flight event from the FIRST attempt (§12.2 item 4: "An event
      // from any earlier attempt is stale even if it arrives before cancellation cleanup").
      h.fence.beginAttempt();

      h.agentBackend.emitEvent(staleLease, { kind: "reasoning", text: "late" });
      await Bun.sleep(0);

      expect(h.published).toEqual([expect.anything()]); // only turn.attemptStarted
      expect(h.deadlines.check()).toEqual({ kind: "ok" });

      h.agentBackend.completeRun(staleLease, {
        kind: "completed",
        finalText: "done",
        usage: null,
        sessionId: "s1",
      });
      await wrap(handle.outcome);
    });
  });

  test("natural completion: calls beginStopping, retires the fence, and resolves outcome — in that order", async () => {
    await context.start(async () => {
      const h = harness();
      const handle = begin(h.deps, h.fence);
      const lease = h.fence.currentLease();
      if (lease === null) throw new Error("expected a live lease");

      h.agentBackend.completeRun(lease, {
        kind: "completed",
        finalText: "done",
        usage: null,
        sessionId: "s1",
      });
      const outcome = await wrap(handle.outcome);

      expect(outcome).toEqual({
        kind: "completed",
        finalText: "done",
        usage: null,
        sessionId: "s1",
      });
      expect(h.machine.phase()).toBe("stopping");
      // §12.2 item 5 / TD §6.4: retired strictly before the caller could ever freeze a
      // candidate for this attempt.
      expect(h.fence.currentLease()).toBeNull();
    });
  });

  test("CRITICAL ORDERING (a): cancellation enters stopping, asks the backend to terminate the leased run, and its promise remains unsettled until exit is confirmed", async () => {
    await context.start(async () => {
      const h = harness();
      const handle = begin(h.deps, h.fence);
      const lease = h.fence.currentLease();
      if (lease === null) throw new Error("expected a live lease");

      let cancelSettled = false;
      // `requestCancel()` is ALREADY the reatom-wrapped function `attempt.ts` built (called
      // directly, unwrapped, per `dispatch.ts`'s own "an already-wrapped boundary" idiom); it
      // executes synchronously up to its own first await (calling the fake's `cancel`,
      // itself an async function whose body runs synchronously up to ITS own first await) —
      // so everything up to and including the fake's call-log push has already happened by
      // the time this line returns. The settled-flag continuation is `.then(wrap(cb))`, the
      // exact chained-continuation shape the binding Reatom rule requires (never
      // `wrap(promise).then(cb)`, which leaves the LATER `.then`'s own callback unwrapped).
      const cancelPromise = handle.requestCancel();
      void cancelPromise.then(
        wrap(() => {
          cancelSettled = true;
        }),
      );

      // Drain the microtask queue BEFORE asserting the negative. Without this, the
      // `cancelSettled === false` check below runs synchronously, when NO promise —
      // including an already-resolved one — has had its `.then` callback run yet. A
      // fire-and-forget `requestCancel` that returns `Promise.resolve()` would therefore
      // pass, which is exactly the defect §12.2 item 5 forbids: "remains there until exit
      // is confirmed before terminalization". The `wrap` is load-bearing too — a bare
      // `await Bun.sleep(0)` loses the Reatom context, and `machine.phase()` then reads the
      // atom's initial value instead of the live one.
      await wrap(Bun.sleep(0));

      // Entered stopping immediately, and asked the exact leased run to terminate —
      // BEFORE exit is confirmed.
      expect(h.machine.phase()).toBe("stopping");
      expect(h.agentBackend.calls).toContainEqual({ method: "cancel", fence: lease });
      expect(cancelSettled).toBe(false);
      expect(h.fence.currentLease()).not.toBeNull(); // not retired yet

      h.agentBackend.completeRun(lease, { kind: "cancelled", exitConfirmed: true });
      await wrap(cancelPromise);
      const outcome = await wrap(handle.outcome);

      expect(cancelSettled).toBe(true);
      expect(outcome).toEqual({ kind: "cancelled" });
      expect(h.fence.currentLease()).toBeNull();
      // beginStopping must NOT run a second time on top of requestCancel's own transition —
      // the machine would reject it, and it must still land in "stopping", not throw.
      expect(h.machine.phase()).toBe("stopping");
    });
  });

  test("backend-error maps to a failed outcome and enters stopping", async () => {
    await context.start(async () => {
      const h = harness();
      const handle = begin(h.deps, h.fence);
      const lease = h.fence.currentLease();
      if (lease === null) throw new Error("expected a live lease");

      h.agentBackend.completeRun(lease, {
        kind: "backend-error",
        message: "boom",
        sessionId: "s1",
      });
      const outcome: TurnAttemptOutcomeV1 = await wrap(handle.outcome);

      expect(outcome).toEqual({ kind: "failed", message: "boom", sessionId: "s1" });
      expect(h.machine.phase()).toBe("stopping");
    });
  });

  test("unconfirmed-exit maps to backend-unhealthy", async () => {
    await context.start(async () => {
      const h = harness();
      const handle = begin(h.deps, h.fence);
      const lease = h.fence.currentLease();
      if (lease === null) throw new Error("expected a live lease");

      h.agentBackend.completeRun(lease, { kind: "unconfirmed-exit" });
      const outcome = await wrap(handle.outcome);

      expect(outcome).toEqual({ kind: "backend-unhealthy" });
    });
  });

  test("a retry mints attempt 2 with a fresh nonce, keeping the same turnId", async () => {
    await context.start(async () => {
      const h = harness();
      const first = begin(h.deps, h.fence);
      const firstLease = h.fence.currentLease();
      if (firstLease === null) throw new Error("expected a live lease");
      h.agentBackend.completeRun(firstLease, {
        kind: "completed",
        finalText: "done",
        usage: null,
        sessionId: "s1",
      });
      await wrap(first.outcome);

      // The caller drives the machine back to workspace-ready (snapshotting -> validating
      // -> workspace-ready, `candidate.ts`'s/`validation.ts`'s own jobs) before a retry's
      // own beginAttempt is legal again — this test only proves the fence side of a retry.
      h.machine.apply("beginSnapshot");
      h.machine.apply("candidateCaptured");
      h.machine.apply("retryAfterGate");
      const second = begin(h.deps, h.fence);
      const secondLease = h.fence.currentLease();
      if (secondLease === null) throw new Error("expected a live lease");

      expect(secondLease.turnId).toBe(firstLease.turnId);
      expect(secondLease.attempt).toBe(2);
      expect(secondLease.leaseNonce).not.toBe(firstLease.leaseNonce);

      h.agentBackend.completeRun(secondLease, {
        kind: "completed",
        finalText: "done2",
        usage: null,
        sessionId: "s2",
      });
      await wrap(second.outcome);
    });
  });
});
