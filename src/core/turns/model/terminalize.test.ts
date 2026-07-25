import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import {
  type StateMachine,
  type TurnAction,
  type TurnState,
  type TurnTerminalOutcome,
  reatomTurnStateMachine,
} from "core/machines";
import { createFakeStagingService, createFakeTurnTransactionService } from "core/ports/fakes";
import type { FailureDtoV1 } from "core/protocol";

import { type TerminalizeTurnInputV1, terminalizeTurn } from "./terminalize";

/**
 * TESTING NOTE (same hazard as `finalize.test.ts`/`core/project/model/page-mutations.test.ts`):
 * `context.start(cb)` pops its isolated frame the instant `cb()` returns, even for an async
 * `cb`. Every test calls `terminalizeTurn` SYNCHRONOUSLY inside `context.start(() => {...})`
 * and reads `machine.phase()` only through a `wrap(() => machine.phase())` reader captured
 * in that same window.
 */

const TURN_ID = "0192f6f0-0000-7000-8000-00000000aaaa";
const CHAT_ID = "0192f6f0-0000-7000-8000-00000000bbbb";
const CREATED_AT = "2024-06-01T12:00:00.000Z";

/** Walks a fresh machine from `idle` to `terminalizing` — terminalize.ts's own entry phase. */
function advanceToTerminalizing(machine: StateMachine<TurnState, TurnAction>): void {
  const steps: TurnAction[] = [
    "beginAdmission",
    "finishAdmission",
    "beginAttempt",
    "beginStopping",
    "beginTerminalization",
  ];
  for (const step of steps) {
    const outcome = machine.apply(step);
    if (outcome.kind === "illegal")
      throw new Error(`setup: ${step} was illegal from ${outcome.from}`);
  }
}

function baseInput(overrides: Partial<TerminalizeTurnInputV1> = {}): TerminalizeTurnInputV1 {
  return {
    turnId: TURN_ID,
    targetChatId: CHAT_ID,
    outcome: "failed",
    text: "the agent backend failed",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function setup() {
  const machine = reatomTurnStateMachine();
  advanceToTerminalizing(machine);
  const turnTransactions = createFakeTurnTransactionService();
  const staging = createFakeStagingService();
  return { machine, turnTransactions, staging };
}

describe("terminalizeTurn", () => {
  describe("the outcome -> persisted record mapping is §7.2 verbatim", () => {
    // "failed | cancelled | stale | interrupted", in that exact order, transcribed by hand
    // from §7.2 rather than iterated from the implementation's own mapping.
    const CASES: readonly {
      readonly outcome: TurnTerminalOutcome;
      readonly expectKind: "system:error" | "system:cancelled";
      readonly expectRecordOutcome?: "error" | "stale" | "interrupted";
    }[] = [
      { outcome: "failed", expectKind: "system:error", expectRecordOutcome: "error" },
      { outcome: "cancelled", expectKind: "system:cancelled" },
      { outcome: "stale", expectKind: "system:error", expectRecordOutcome: "stale" },
      { outcome: "interrupted", expectKind: "system:error", expectRecordOutcome: "interrupted" },
    ];

    for (const testCase of CASES) {
      test(`"${testCase.outcome}" persists as ${testCase.expectKind}${testCase.expectRecordOutcome ? ` with outcome "${testCase.expectRecordOutcome}"` : ""}`, async () => {
        const { call, turnTransactions } = context.start(() => {
          const { machine, turnTransactions, staging } = setup();
          const call = terminalizeTurn(
            { machine, turnTransactions, staging },
            baseInput({ outcome: testCase.outcome, text: "boom" }),
          );
          return { call, turnTransactions };
        });

        const result = await call;

        expect(result.kind).toBe("recorded");
        const terminalizeCall = turnTransactions.calls.find((c) => c.method === "terminalize");
        if (terminalizeCall?.method !== "terminalize")
          throw new Error("expected a terminalize call");
        expect(terminalizeCall.input.turnId).toBe(TURN_ID);
        expect(terminalizeCall.input.targetChatId).toBe(CHAT_ID);
        expect(terminalizeCall.input.record.kind).toBe(testCase.expectKind);
        expect(terminalizeCall.input.record.turnId).toBe(TURN_ID);
        expect(terminalizeCall.input.record.text).toBe("boom");
        if (
          terminalizeCall.input.record.kind === "system:error" &&
          testCase.expectRecordOutcome !== undefined
        ) {
          expect(terminalizeCall.input.record.outcome).toBe(testCase.expectRecordOutcome);
        }
      });
    }
  });

  test("never persists turnId AND actionId together — actionId is always absent for a turn terminalization", async () => {
    const { call, turnTransactions } = context.start(() => {
      const { machine, turnTransactions, staging } = setup();
      const call = terminalizeTurn({ machine, turnTransactions, staging }, baseInput());
      return { call, turnTransactions };
    });

    await call;

    const terminalizeCall = turnTransactions.calls.find((c) => c.method === "terminalize");
    if (terminalizeCall?.method !== "terminalize") throw new Error("expected a terminalize call");
    expect(terminalizeCall.input.record.actionId).toBeUndefined();
  });

  test("on success it moves terminalizing -> terminal -> idle and reports 'recorded'", async () => {
    const { call, readPhase, turnTransactions } = context.start(() => {
      const { machine, turnTransactions, staging } = setup();
      const call = terminalizeTurn({ machine, turnTransactions, staging }, baseInput());
      return { call, readPhase: wrap(() => machine.phase()), turnTransactions };
    });

    const result = await call;

    expect(result.kind).toBe("recorded");
    if (result.kind !== "recorded") return;
    expect(typeof result.commit.transactionId).toBe("string");
    expect(readPhase()).toBe("idle");
    expect(turnTransactions.calls.map((c) => c.method)).toEqual(["terminalize"]);
  });

  // Gate-exhaustion-vs-backend-failure follow-up to WP-8 item 4: `TerminalizeTurnResultV1`'s
  // `"recorded"` variant used to carry only an opaque `TurnCommitV1`, discarding which
  // `TurnTerminalOutcome`/`reason` the caller originally requested — the exact gap that left
  // two DIFFERENT `run-turn.ts` causes indistinguishable once both reached `"recorded"`
  // (`core/kernel/model/handlers/turn.ts`'s own header). This pins the echo directly, at the
  // point it is produced.
  test("a 'recorded' result echoes back the outcome and reason it was called with, not just the opaque commit", async () => {
    const { call } = context.start(() => {
      const { machine, turnTransactions, staging } = setup();
      const call = terminalizeTurn(
        { machine, turnTransactions, staging },
        baseInput({ outcome: "failed", reason: "GATE_RETRY_EXHAUSTED" }),
      );
      return { call };
    });

    const result = await call;

    if (result.kind !== "recorded") throw new Error(`expected recorded, got ${result.kind}`);
    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("GATE_RETRY_EXHAUSTED");
  });

  test("rejects with the machine's illegal code and touches no port when the turn is not terminalizing", async () => {
    const { call, turnTransactions } = context.start(() => {
      const machine = reatomTurnStateMachine(); // stays at idle
      const turnTransactions = createFakeTurnTransactionService();
      const staging = createFakeStagingService();
      const call = terminalizeTurn({ machine, turnTransactions, staging }, baseInput());
      return { call, turnTransactions };
    });

    const result = await call;

    expect(result).toEqual({ kind: "illegal", code: "TURN_ALREADY_ACTIVE" });
    expect(turnTransactions.calls).toEqual([]);
  });

  test("§7.2: finishTerminalization is legal on a TYPED UNRECORDED condition too — a failed append still reaches terminal -> idle", async () => {
    // "Requires exactly one terminal chat record OR a typed unrecorded recovery
    // condition." A turn that could not even append its own failure record must not get
    // stuck outside `terminal` — startup orphan recovery (already landed) picks this up.
    const FAILURE: FailureDtoV1 = {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: "disk unavailable",
      details: {},
    };
    const { call, readPhase, turnTransactions } = context.start(() => {
      const { machine, turnTransactions, staging } = setup();
      turnTransactions.failNext("terminalize", FAILURE);
      const call = terminalizeTurn({ machine, turnTransactions, staging }, baseInput());
      return { call, readPhase: wrap(() => machine.phase()), turnTransactions };
    });

    const result = await call;

    // `outcome`/`reason` are the echo this task's own follow-up added (see this file's
    // `TerminalizeTurnResultV1` doc comment) — `baseInput()`'s `outcome: "failed"` and no
    // `reason`, echoed back verbatim rather than discarded.
    expect(result).toEqual({ kind: "unrecorded", failure: FAILURE, outcome: "failed" });
    expect(readPhase()).toBe("idle");
    expect(turnTransactions.calls.map((c) => c.method)).toEqual(["terminalize"]);
  });

  test("a reason is threaded onto the system:error record only", async () => {
    const { call, turnTransactions } = context.start(() => {
      const { machine, turnTransactions, staging } = setup();
      const call = terminalizeTurn(
        { machine, turnTransactions, staging },
        baseInput({ outcome: "interrupted", reason: "process_restart_before_intent" }),
      );
      return { call, turnTransactions };
    });

    await call;

    const terminalizeCall = turnTransactions.calls.find((c) => c.method === "terminalize");
    if (terminalizeCall?.method !== "terminalize") throw new Error("expected a terminalize call");
    if (terminalizeCall.input.record.kind !== "system:error")
      throw new Error("expected system:error");
    expect(terminalizeCall.input.record.reason).toBe("process_restart_before_intent");
  });

  describe("candidate retirement (kernel-assembly Task 13)", () => {
    const CANDIDATE_ROOT = "/fake-candidate/terminalize-test";

    test("retires the frozen candidate exactly once on a recorded terminalization", async () => {
      const { call, staging } = context.start(() => {
        const { machine, turnTransactions } = setup();
        const staging = createFakeStagingService();
        const call = terminalizeTurn(
          { machine, turnTransactions, staging },
          baseInput({ candidateRoot: CANDIDATE_ROOT }),
        );
        return { call, staging };
      });

      const result = await call;

      expect(result.kind).toBe("recorded");
      expect(staging.calls.map((c) => c.method)).toEqual(["retireCandidate"]);
      const retireCall = staging.calls.find((c) => c.method === "retireCandidate");
      if (retireCall?.method !== "retireCandidate")
        throw new Error("expected a retireCandidate call");
      expect(retireCall.root).toBe(CANDIDATE_ROOT);
    });

    test("also retires exactly once on an UNRECORDED terminalization — the turn is still done either way", async () => {
      const APPEND_FAILURE: FailureDtoV1 = {
        code: "PERSISTENCE_FAILED",
        retryable: false,
        safeMessage: "disk unavailable",
        details: {},
      };
      const { call, staging } = context.start(() => {
        const { machine, turnTransactions } = setup();
        turnTransactions.failNext("terminalize", APPEND_FAILURE);
        const staging = createFakeStagingService();
        const call = terminalizeTurn(
          { machine, turnTransactions, staging },
          baseInput({ candidateRoot: CANDIDATE_ROOT }),
        );
        return { call, staging };
      });

      const result = await call;

      expect(result.kind).toBe("unrecorded");
      expect(staging.calls.map((c) => c.method)).toEqual(["retireCandidate"]);
    });

    // NARROWED (review finding #4): `TerminalizeTurnDeps.staging` is now REQUIRED — a
    // "staging absent" half of this test can no longer be constructed through the public
    // API (a compile error), matching `finalize.test.ts`'s identical fix. `candidateRoot`
    // stays optional here (unlike `finalize.ts`'s own now-required field): a turn can
    // legitimately terminalize before any candidate was ever frozen, so this test keeps
    // pinning THAT one remaining honest skip.
    test("never retires when candidateRoot is absent (no candidate ever froze) — an honest skip, not a failure", async () => {
      const { call, staging } = context.start(() => {
        const { machine, turnTransactions, staging } = setup();
        // no candidateRoot on the input (the default baseInput()).
        const call = terminalizeTurn({ machine, turnTransactions, staging }, baseInput());
        return { call, staging };
      });

      const result = await call;

      expect(result.kind).toBe("recorded");
      expect(staging.calls).toEqual([]);
    });

    test("a retire failure is reported via console.warn without failing the already-recorded terminalization", async () => {
      const RETIRE_FAILURE: FailureDtoV1 = {
        code: "PERSISTENCE_FAILED",
        retryable: false,
        safeMessage: "candidate cleanup failed",
        details: {},
      };
      const { call } = context.start(() => {
        const { machine, turnTransactions, staging } = setup();
        staging.failNext("retireCandidate", RETIRE_FAILURE);
        const call = terminalizeTurn(
          { machine, turnTransactions, staging },
          baseInput({ candidateRoot: CANDIDATE_ROOT }),
        );
        return { call };
      });

      const originalWarn = console.warn;
      const warnCalls: unknown[][] = [];
      console.warn = (...args: unknown[]) => {
        warnCalls.push(args);
      };
      const result = await call.finally(() => {
        console.warn = originalWarn;
      });

      expect(result.kind).toBe("recorded");
      // Exactly the ONE warning this code path itself emits (`retireIfCandidateFrozen`'s own
      // `console.warn` call in terminalize.ts) — not merely "some warning fired somewhere",
      // which would also pass for `terminalizeTurn`'s own unrelated unrecorded-path warning.
      expect(warnCalls).toEqual([
        ["terminalizeTurn: candidate retirement failed:", RETIRE_FAILURE.safeMessage],
      ]);
    });
  });
});
