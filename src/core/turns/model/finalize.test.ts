import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import {
  type StateMachine,
  type TurnAction,
  type TurnState,
  reatomTurnStateMachine,
} from "core/machines";
import type { SentPinV1 } from "core/pins/model/turn-resolution";
import type { StagedTurnReadSetV1 } from "core/ports";
import { createFakeStagingService, createFakeTurnTransactionService } from "core/ports/fakes";
import type { FailureDtoV1 } from "core/protocol";
import type { ChatAgentRecord } from "entities/chat";
import type { PageSlug } from "entities/page";
import type { Clock } from "infrastructure/clock";

import { createTurnDeadlines } from "./deadlines";
import { type FinalizeTurnInputV1, finalizeTurn } from "./finalize";

/**
 * TESTING NOTE (matching `core/project/model/page-mutations.test.ts`'s own documented
 * hazard): `context.start(cb)` pops its isolated frame the instant `cb()` returns —
 * immediately, even for an async `cb`, the moment it hits its first internal `await`. Every
 * test below therefore (1) builds the machine/fakes and calls `finalizeTurn` SYNCHRONOUSLY
 * inside `context.start(() => {...})`, capturing its returned promise without awaiting
 * inside the callback, and (2) reads `machine.phase()` only through a `wrap(() =>
 * machine.phase())` reader built in that SAME synchronous window — never a bare
 * post-await `machine.phase()` call. `turnTransactions` is plain JS state (its `.calls` log
 * is safe to read from anywhere), matching this same file's own precedent.
 */

const slug = (value: string): PageSlug => value as PageSlug;
const TURN_ID = "0192f6f0-0000-7000-8000-00000000aaaa";
const CHAT_ID = "0192f6f0-0000-7000-8000-00000000bbbb";
const T0 = 1_700_000_000_000;
const CREATED_AT = "2024-06-01T12:00:00.000Z";

function manualClock(startMs: number): Clock & { advance: (ms: number) => void } {
  let now = startMs;
  return { now: () => new Date(now), advance: (ms: number) => (now += ms) };
}

/** Walks a fresh machine from `idle` to `validating` — finalize.ts's own entry phase. */
function advanceToValidating(machine: StateMachine<TurnState, TurnAction>): void {
  const steps: TurnAction[] = [
    "beginAdmission",
    "finishAdmission",
    "beginAttempt",
    "beginStopping",
    "beginSnapshot",
    "candidateCaptured",
  ];
  for (const step of steps) {
    const outcome = machine.apply(step);
    if (outcome.kind === "illegal")
      throw new Error(`setup: ${step} was illegal from ${outcome.from}`);
  }
}

function agentRecord(overrides: Partial<ChatAgentRecord> = {}): ChatAgentRecord {
  return {
    kind: "agent",
    recordId: "0192f6f0-0000-7000-8000-00000000cccc",
    turnId: TURN_ID,
    text: "done",
    changedPages: [slug("home")],
    warnings: [],
    ts: CREATED_AT,
    ...overrides,
  };
}

function stagedReadSet(overrides: Partial<StagedTurnReadSetV1> = {}): StagedTurnReadSetV1 {
  return {
    manifest: { sha256: "a".repeat(64), size: 120 },
    canonicalPages: [{ pageSlug: slug("home"), snapshot: { sha256: "b".repeat(64), size: 400 } }],
    chat: { length: 2048, prefixSha256: "c".repeat(64) },
    pins: [{ pageSlug: slug("home"), base: { length: 64, prefixSha256: "a".repeat(64) } }],
    ...overrides,
  };
}

/** `candidateRoot` is required on `FinalizeTurnInputV1` (review finding #4 — `finalizeTurn` is only ever called once a candidate has already been frozen), so every `baseInput()` needs SOME value even when a test's own focus is elsewhere. */
const DEFAULT_CANDIDATE_ROOT = "/fake-candidate/default";

function baseInput(overrides: Partial<FinalizeTurnInputV1> = {}): FinalizeTurnInputV1 {
  return {
    turnId: TURN_ID,
    targetChatId: CHAT_ID,
    changedPages: [{ pageSlug: slug("home"), change: "replace" }],
    validatedPageSlugs: [slug("home")],
    agentRecord: agentRecord(),
    sentPins: [] as readonly SentPinV1[],
    stagedReadSet: stagedReadSet(),
    createdAt: CREATED_AT,
    candidateRoot: DEFAULT_CANDIDATE_ROOT,
    ...overrides,
  };
}

function setup(options?: { readonly deadlineExpired?: boolean }) {
  const machine = reatomTurnStateMachine();
  advanceToValidating(machine);
  const turnTransactions = createFakeTurnTransactionService();
  const staging = createFakeStagingService();
  const clock = manualClock(T0);
  const deadlines = createTurnDeadlines({ clock, absoluteMs: 10_000, silenceMs: 5_000 });
  if (options?.deadlineExpired) clock.advance(10_000);
  return { machine, turnTransactions, staging, deadlines, clock };
}

describe("finalizeTurn", () => {
  test("on success it moves finalizing -> committed -> idle and reports the commit", async () => {
    const { call, readPhase, turnTransactions } = context.start(() => {
      const { machine, turnTransactions, staging, deadlines } = setup();
      const call = finalizeTurn({ machine, turnTransactions, staging, deadlines }, baseInput());
      return { call, readPhase: wrap(() => machine.phase()), turnTransactions };
    });

    const result = await call;

    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") return;
    expect(typeof result.commit.transactionId).toBe("string");
    expect(readPhase()).toBe("idle");
    expect(turnTransactions.calls.map((c) => c.method)).toEqual(["finalize"]);
  });

  test("passes the translated read set and caller-built fields straight through to TurnTransactionService.finalize", async () => {
    const { call, turnTransactions } = context.start(() => {
      const { machine, turnTransactions, staging, deadlines } = setup();
      const record = agentRecord({ text: "custom text" });
      const call = finalizeTurn(
        { machine, turnTransactions, staging, deadlines },
        baseInput({ agentRecord: record, requestedActivePage: slug("about") }),
      );
      return { call, turnTransactions };
    });

    await call;

    const finalizeCall = turnTransactions.calls.find((c) => c.method === "finalize");
    if (finalizeCall?.method !== "finalize") throw new Error("expected a finalize call");
    expect(finalizeCall.input.turnId).toBe(TURN_ID);
    expect(finalizeCall.input.targetChatId).toBe(CHAT_ID);
    expect(finalizeCall.input.agentRecord.text).toBe("custom text");
    expect(finalizeCall.input.requestedActivePage).toBe(slug("about"));
    expect(finalizeCall.input.readSet.manifest).toEqual({
      state: "file",
      sha256: "a".repeat(64),
      size: 120,
    });
    expect(finalizeCall.input.readSet.chat).toEqual({ length: 2048, prefixSha256: "c".repeat(64) });
  });

  test("the CAS basis carries only manifest/canonicalPages/chat/pins — never local tab/preview/selection snapshot context", async () => {
    // §11.2 negative, verbatim: "Send-time local tab/preview/selection changes are
    // snapshot context and do not stale apply." toFinalizeReadSet's shape has no channel
    // for such fields; this pins the ACTUAL object this module sends to the port to
    // exactly those four keys, so a future edit cannot smuggle local UI context into it.
    const { call, turnTransactions } = context.start(() => {
      const { machine, turnTransactions, staging, deadlines } = setup();
      const call = finalizeTurn({ machine, turnTransactions, staging, deadlines }, baseInput());
      return { call, turnTransactions };
    });

    await call;

    const finalizeCall = turnTransactions.calls.find((c) => c.method === "finalize");
    if (finalizeCall?.method !== "finalize") throw new Error("expected a finalize call");
    expect(Object.keys(finalizeCall.input.readSet).sort()).toEqual([
      "canonicalPages",
      "chat",
      "manifest",
      "pins",
    ]);
  });

  test("rejects with TURN_ALREADY_ACTIVE and touches no port when the turn is not in validating", async () => {
    const { call, turnTransactions } = context.start(() => {
      const machine = reatomTurnStateMachine(); // stays at idle
      const turnTransactions = createFakeTurnTransactionService();
      const staging = createFakeStagingService();
      const clock = manualClock(T0);
      const deadlines = createTurnDeadlines({ clock, absoluteMs: 10_000, silenceMs: 5_000 });
      const call = finalizeTurn({ machine, turnTransactions, staging, deadlines }, baseInput());
      return { call, turnTransactions };
    });

    const result = await call;

    // `at` is what lets `run-turn.ts` tell "nothing was written" from "a commit already landed"
    // — the two used to collapse into one message claiming a durable commit either way.
    expect(result).toEqual({
      kind: "illegal",
      code: "TURN_ALREADY_ACTIVE",
      at: "beginFinalization",
    });
    expect(turnTransactions.calls).toEqual([]);
  });

  test("an expired absolute deadline blocks commit intent and leaves the machine in finalizing", async () => {
    const { call, readPhase, turnTransactions } = context.start(() => {
      const { machine, turnTransactions, staging, deadlines } = setup({ deadlineExpired: true });
      const call = finalizeTurn({ machine, turnTransactions, staging, deadlines }, baseInput());
      return { call, readPhase: wrap(() => machine.phase()), turnTransactions };
    });

    const result = await call;

    expect(result).toEqual({
      kind: "failed",
      failure: {
        code: "TURN_DEADLINE_EXCEEDED",
        retryable: false,
        safeMessage: expect.any(String),
        details: { bound: "absolute" },
      },
    });
    expect(turnTransactions.calls).toEqual([]);
    // No intent was ever written — the machine never reached committed/idle.
    expect(readPhase()).toBe("finalizing");
  });

  test("checks the deadline BEFORE calling TurnTransactionService.finalize", async () => {
    const { call, order } = context.start(() => {
      const { machine, turnTransactions, staging, deadlines } = setup();
      const order: string[] = [];
      const tracedDeadlines = {
        ...deadlines,
        check: () => {
          order.push("check-deadline");
          return deadlines.check();
        },
      };
      const tracedTransactions = {
        ...turnTransactions,
        finalize: async (input: Parameters<typeof turnTransactions.finalize>[0]) => {
          order.push("finalize");
          return turnTransactions.finalize(input);
        },
      };
      const call = finalizeTurn(
        { machine, turnTransactions: tracedTransactions, staging, deadlines: tracedDeadlines },
        baseInput(),
      );
      return { call, order };
    });

    await call;

    expect(order).toEqual(["check-deadline", "finalize"]);
  });

  test("propagates a CAS-mismatch failure from the port without moving past finalizing", async () => {
    const FAILURE: FailureDtoV1 = {
      code: "APPLY_STALE",
      retryable: false,
      safeMessage: "the captured chat drifted",
      details: { part: "chat" },
    };
    const { call, readPhase } = context.start(() => {
      const { machine, turnTransactions, staging, deadlines } = setup();
      turnTransactions.failNext("finalize", FAILURE);
      const call = finalizeTurn({ machine, turnTransactions, staging, deadlines }, baseInput());
      return { call, readPhase: wrap(() => machine.phase()) };
    });

    const result = await call;

    expect(result).toEqual({ kind: "failed", failure: FAILURE });
    expect(readPhase()).toBe("finalizing");
  });

  test("resolvedPins sent to the transaction are sentPins narrowed to changedPages — never invented for a page with no sent pin", async () => {
    // A pin created AFTER turn capture was never added to sentPins, so it structurally
    // cannot appear here — "pins created after turn capture ... remain open" (§12.2 item 8).
    const { call, turnTransactions } = context.start(() => {
      const { machine, turnTransactions, staging, deadlines } = setup();
      const input = baseInput({
        changedPages: [
          { pageSlug: slug("home"), change: "replace" },
          { pageSlug: slug("about"), change: "replace" },
        ],
        sentPins: [{ pinId: "pin-a", pageSlug: slug("home") }],
      });
      const call = finalizeTurn({ machine, turnTransactions, staging, deadlines }, input);
      return { call, turnTransactions };
    });

    await call;

    const finalizeCall = turnTransactions.calls.find((c) => c.method === "finalize");
    if (finalizeCall?.method !== "finalize") throw new Error("expected a finalize call");
    expect(finalizeCall.input.resolvedPins).toHaveLength(1);
    expect(finalizeCall.input.resolvedPins[0]?.pageSlug).toBe(slug("home"));
    expect(finalizeCall.input.resolvedPins[0]?.event.pinId).toBe("pin-a");
  });

  test("an empty changedPages diff resolves no pins at all", async () => {
    const { call, turnTransactions } = context.start(() => {
      const { machine, turnTransactions, staging, deadlines } = setup();
      const input = baseInput({
        changedPages: [],
        agentRecord: agentRecord({ changedPages: [] }),
        sentPins: [{ pinId: "pin-a", pageSlug: slug("home") }],
      });
      const call = finalizeTurn({ machine, turnTransactions, staging, deadlines }, input);
      return { call, turnTransactions };
    });

    await call;

    const finalizeCall = turnTransactions.calls.find((c) => c.method === "finalize");
    if (finalizeCall?.method !== "finalize") throw new Error("expected a finalize call");
    expect(finalizeCall.input.resolvedPins).toEqual([]);
  });

  describe("candidate retirement (kernel-assembly Task 13)", () => {
    const CANDIDATE_ROOT = "/fake-candidate/finalize-test";

    test("retires the frozen candidate exactly once on a successful commit", async () => {
      const { call, staging } = context.start(() => {
        const { machine, turnTransactions, deadlines } = setup();
        const staging = createFakeStagingService();
        const call = finalizeTurn(
          { machine, turnTransactions, deadlines, staging },
          baseInput({ candidateRoot: CANDIDATE_ROOT }),
        );
        return { call, staging };
      });

      const result = await call;

      expect(result.kind).toBe("committed");
      expect(staging.calls.map((c) => c.method)).toEqual(["retireCandidate"]);
      const retireCall = staging.calls.find((c) => c.method === "retireCandidate");
      if (retireCall?.method !== "retireCandidate")
        throw new Error("expected a retireCandidate call");
      expect(retireCall.root).toBe(CANDIDATE_ROOT);
    });

    // REMOVED (review finding #4): this describe block used to also pin "never retires when
    // staging or candidateRoot is absent" — `FinalizeTurnDeps.staging` and
    // `FinalizeTurnInputV1.candidateRoot` were both optional, and omitting either one made
    // retirement a silent no-op. Finding #4 flagged that as the exact bug (nothing in
    // production ever threaded either value through, so the candidate leak stayed open) and
    // required both fields to become REQUIRED instead — a `finalizeTurn` call that omits
    // either one is now a compile error, so the scenario this test pinned can no longer be
    // constructed through the public API at all. It is removed rather than left to bit-rot
    // into a type error.

    test("never retires on a deadline-exceeded failure — the turn never reaches committed", async () => {
      const { call, staging } = context.start(() => {
        const { machine, turnTransactions, deadlines } = setup({ deadlineExpired: true });
        const staging = createFakeStagingService();
        const call = finalizeTurn(
          { machine, turnTransactions, deadlines, staging },
          baseInput({ candidateRoot: CANDIDATE_ROOT }),
        );
        return { call, staging };
      });

      const result = await call;

      expect(result.kind).toBe("failed");
      expect(staging.calls).toEqual([]);
    });

    test("a retire failure is reported via console.warn without failing the already-committed turn", async () => {
      const RETIRE_FAILURE: FailureDtoV1 = {
        code: "PERSISTENCE_FAILED",
        retryable: false,
        safeMessage: "candidate cleanup failed",
        details: {},
      };
      const { call } = context.start(() => {
        const { machine, turnTransactions, deadlines } = setup();
        const staging = createFakeStagingService();
        staging.failNext("retireCandidate", RETIRE_FAILURE);
        const call = finalizeTurn(
          { machine, turnTransactions, deadlines, staging },
          baseInput({ candidateRoot: CANDIDATE_ROOT }),
        );
        return { call, staging };
      });

      const originalWarn = console.warn;
      const warnCalls: unknown[][] = [];
      console.warn = (...args: unknown[]) => {
        warnCalls.push(args);
      };
      const result = await call.finally(() => {
        console.warn = originalWarn;
      });

      expect(result.kind).toBe("committed");
      // Exactly the ONE warning this code path itself emits (`retireFinalizedCandidate`'s own
      // `console.warn` call in finalize.ts) — not merely "some warning fired somewhere",
      // which would also pass for an unrelated warning this same run happened to log.
      expect(warnCalls).toEqual([
        ["finalizeTurn: candidate retirement failed:", RETIRE_FAILURE.safeMessage],
      ]);
    });
  });
});
