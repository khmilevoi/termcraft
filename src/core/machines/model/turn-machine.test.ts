import { describe, expect, it, test } from "bun:test";

import { context } from "@reatom/core";

import {
  MAX_TURN_ATTEMPT,
  MIN_TURN_ATTEMPT,
  TURN_ACTION_FULL_NAME,
  TURN_TERMINAL_OUTCOMES,
  type TurnAction,
  type TurnState,
  canRetryAfterGate,
  isTurnAttempt,
  reatomTurnStateMachine,
} from "./turn-machine";

/**
 * kernel-command-contract §7.2 (lines 230-270), §13.1.
 *
 * `TURN_STATES`, `TURN_ACTIONS`, and `EXPECTED_EDGES` below are transcribed BY HAND from
 * the spec's §7.2 table and its surrounding `requestCancel`/`turn.start` prose a second
 * time, independently of `turn-machine.ts`'s own `TURN_TRANSITION_TABLE`. Iterating the
 * implementation's own table would not catch the implementation transcribing a row wrong —
 * pinning against this independent copy means a wrong target, a dropped source, or a wrong
 * illegal code in the implementation shows up as a failing assertion here.
 */

const TURN_STATES: readonly TurnState[] = [
  "idle",
  "admitting",
  "workspace-ready",
  "running",
  "stopping",
  "snapshotting",
  "validating",
  "finalizing",
  "committed",
  "terminalizing",
  "terminal",
  "backend-unhealthy",
];

const TURN_ACTIONS: readonly TurnAction[] = [
  "beginAdmission",
  "finishAdmission",
  "beginAttempt",
  "beginStopping",
  "beginSnapshot",
  "beginTerminalization",
  "markBackendUnhealthy",
  "candidateCaptured",
  "retryAfterGate",
  "beginFinalization",
  "markCommitted",
  "settle",
  "finishTerminalization",
  "confirmBackendHealthy",
  "requestCancel",
];

interface ExpectedEdge {
  readonly from: TurnState;
  readonly action: TurnAction;
  readonly to: TurnState;
  readonly noOp?: boolean;
}

// One entry per §7.2 table row, multi-source rows expanded to one edge per source, PLUS
// the `requestCancel` edges from §7.2's prose paragraph (lines 265-269) and §8.4's
// "stopping or terminalizing returns accepted no-op for the same turn".
const EXPECTED_EDGES: readonly ExpectedEdge[] = [
  { from: "idle", action: "beginAdmission", to: "admitting" },
  { from: "admitting", action: "finishAdmission", to: "workspace-ready" },
  { from: "workspace-ready", action: "beginAttempt", to: "running" },
  { from: "running", action: "beginStopping", to: "stopping" },
  { from: "stopping", action: "beginSnapshot", to: "snapshotting" },
  // Amended 2026-07-26 (MVP blocker fix bundle §1.1): a rejected admission had no exit —
  // requestCancel needs a turnId a failed admission never surfaced — so admitting now also
  // bridges to terminalizing via beginTerminalization, matching kernel-command-contract §7.2.
  { from: "admitting", action: "beginTerminalization", to: "terminalizing" },
  { from: "stopping", action: "beginTerminalization", to: "terminalizing" },
  { from: "stopping", action: "markBackendUnhealthy", to: "backend-unhealthy" },
  { from: "snapshotting", action: "candidateCaptured", to: "validating" },
  { from: "validating", action: "retryAfterGate", to: "workspace-ready" },
  { from: "validating", action: "beginFinalization", to: "finalizing" },
  { from: "validating", action: "beginTerminalization", to: "terminalizing" },
  { from: "finalizing", action: "markCommitted", to: "committed" },
  { from: "finalizing", action: "beginTerminalization", to: "terminalizing" },
  { from: "committed", action: "settle", to: "idle" },
  { from: "terminalizing", action: "finishTerminalization", to: "terminal" },
  { from: "terminal", action: "settle", to: "idle" },
  { from: "backend-unhealthy", action: "confirmBackendHealthy", to: "idle" },
  // requestCancel: "legal from any active pre-intent phase ... moves a running attempt to
  // stopping; phases with no process move to terminalizing ... A repeated request ... while
  // stopping/terminalizing is an accepted no-op."
  { from: "admitting", action: "requestCancel", to: "terminalizing" },
  { from: "workspace-ready", action: "requestCancel", to: "terminalizing" },
  { from: "running", action: "requestCancel", to: "stopping" },
  { from: "stopping", action: "requestCancel", to: "stopping", noOp: true },
  { from: "snapshotting", action: "requestCancel", to: "terminalizing" },
  { from: "validating", action: "requestCancel", to: "terminalizing" },
  { from: "finalizing", action: "requestCancel", to: "terminalizing" },
  { from: "terminalizing", action: "requestCancel", to: "terminalizing", noOp: true },
];

// "turn.start is rejected with TURN_ALREADY_ACTIVE in every non-idle state" (§7.2) — the
// table-wide fallback: beginAdmission (the only idle-entry action) is illegal everywhere
// except idle, and that illegality reads exactly as TURN_ALREADY_ACTIVE.
const ILLEGAL_CODE = "TURN_ALREADY_ACTIVE";

function findExpected(from: TurnState, action: TurnAction): ExpectedEdge | undefined {
  return EXPECTED_EDGES.find((edge) => edge.from === from && edge.action === action);
}

/** Drives a fresh machine straight to `phase` via a known-legal edge path. */
function machineAt(phase: TurnState) {
  const m = reatomTurnStateMachine();
  if (phase === "idle") return m;
  const toWorkspaceReady: readonly TurnAction[] = ["beginAdmission", "finishAdmission"];
  const toRunning: readonly TurnAction[] = [...toWorkspaceReady, "beginAttempt"];
  const toStopping: readonly TurnAction[] = [...toRunning, "beginStopping"];
  const toSnapshotting: readonly TurnAction[] = [...toStopping, "beginSnapshot"];
  const toValidating: readonly TurnAction[] = [...toSnapshotting, "candidateCaptured"];
  const toFinalizing: readonly TurnAction[] = [...toValidating, "beginFinalization"];
  const toTerminalizing: readonly TurnAction[] = [...toStopping, "beginTerminalization"];
  const path: Record<Exclude<TurnState, "idle">, readonly TurnAction[]> = {
    admitting: ["beginAdmission"],
    "workspace-ready": toWorkspaceReady,
    running: toRunning,
    stopping: toStopping,
    snapshotting: toSnapshotting,
    validating: toValidating,
    finalizing: toFinalizing,
    committed: [...toFinalizing, "markCommitted"],
    terminalizing: toTerminalizing,
    terminal: [...toTerminalizing, "finishTerminalization"],
    "backend-unhealthy": [...toStopping, "markBackendUnhealthy"],
  };
  for (const action of path[phase]) m.apply(action);
  return m;
}

describe("reatomTurnStateMachine", () => {
  test("starts idle", () => {
    context.start(() => {
      expect(reatomTurnStateMachine().phase()).toBe("idle");
    });
  });

  test("the phase atom carries the §6 trace root", () => {
    context.start(() => {
      expect(reatomTurnStateMachine().phaseAtom.name).toBe("kernel.turn.state");
    });
  });

  test("the hand-counted §7.2 edge total is 26", () => {
    expect(EXPECTED_EDGES.length).toBe(26);
  });

  test("every (state, action) pair matches the §7.2 table exactly", () => {
    context.start(() => {
      for (const from of TURN_STATES) {
        for (const action of TURN_ACTIONS) {
          const expected = findExpected(from, action);
          const m = machineAt(from);
          const outcome = m.apply(action);

          if (expected === undefined) {
            expect(outcome).toEqual({ kind: "illegal", code: ILLEGAL_CODE, from, action });
            expect(m.phase()).toBe(from);
            continue;
          }

          if (expected.noOp === true) {
            expect(outcome).toEqual({ kind: "no-op", phase: from });
          } else {
            expect(outcome).toEqual({ kind: "changed", from, to: expected.to });
          }
          expect(m.phase()).toBe(expected.to);
        }
      }
    });
  });

  test("two machines built by the factory are independent", () => {
    context.start(() => {
      const a = reatomTurnStateMachine();
      const b = reatomTurnStateMachine();
      a.apply("beginAdmission");
      expect(a.phase()).toBe("admitting");
      expect(b.phase()).toBe("idle");
    });
  });

  test("TURN_ACTION_FULL_NAME names every action with its kernel.turn.<verb> form", () => {
    const expectedFullNames: Readonly<Record<TurnAction, string>> = {
      beginAdmission: "kernel.turn.beginAdmission",
      finishAdmission: "kernel.turn.finishAdmission",
      beginAttempt: "kernel.turn.beginAttempt",
      beginStopping: "kernel.turn.beginStopping",
      beginSnapshot: "kernel.turn.beginSnapshot",
      beginTerminalization: "kernel.turn.beginTerminalization",
      markBackendUnhealthy: "kernel.turn.markBackendUnhealthy",
      candidateCaptured: "kernel.turn.candidateCaptured",
      retryAfterGate: "kernel.turn.retryAfterGate",
      beginFinalization: "kernel.turn.beginFinalization",
      markCommitted: "kernel.turn.markCommitted",
      settle: "kernel.turn.settle",
      finishTerminalization: "kernel.turn.finishTerminalization",
      confirmBackendHealthy: "kernel.turn.confirmBackendHealthy",
      requestCancel: "kernel.turn.requestCancel",
    };
    for (const action of TURN_ACTIONS) {
      expect(TURN_ACTION_FULL_NAME[action]).toBe(expectedFullNames[action]);
    }
  });

  test("retryAfterGate from validating is phase-legal regardless of attempt; the attempt<4 gate is the caller's, via canRetryAfterGate", () => {
    // §7.2: "kernel.turn.retryAfterGate is legal only while attempt < 4." The discrete
    // phase table cannot see `attempt` at all — the table only proves the edge exists;
    // gating on attempt number is the guard layer's job using the helper below.
    context.start(() => {
      const m = machineAt("validating");
      expect(m.apply("retryAfterGate")).toEqual({
        kind: "changed",
        from: "validating",
        to: "workspace-ready",
      });
    });
  });

  test("requestCancel from finalizing is phase-legal; the pre/post-intent CANCEL_TOO_LATE split is the caller's, not the table's", () => {
    // §7.2: "In `finalizing` after durable intent it is rejected with `CANCEL_TOO_LATE`;
    // roll-forward must finish." The coarse phase machine has no sub-state for
    // pre-/post-intent within `finalizing`, so it treats the edge as legal; the guard
    // layer must additionally check durable-intent status before honoring a real cancel.
    context.start(() => {
      const m = machineAt("finalizing");
      expect(m.apply("requestCancel")).toEqual({
        kind: "changed",
        from: "finalizing",
        to: "terminalizing",
      });
    });
  });

  it("admitting can terminalize — a rejected admission has an exit (spec §1.1)", () => {
    const machine = reatomTurnStateMachine();
    expect(machine.apply("beginAdmission").kind).toBe("changed");
    expect(machine.phase()).toBe("admitting");

    const bridged = machine.apply("beginTerminalization");
    expect(bridged.kind).toBe("changed");
    expect(machine.phase()).toBe("terminalizing");
  });
});

describe('turn attempt bookkeeping (§7.2: "Attempts are integers 1 through 4")', () => {
  test("MIN_TURN_ATTEMPT and MAX_TURN_ATTEMPT are 1 and 4", () => {
    expect(MIN_TURN_ATTEMPT).toBe(1);
    expect(MAX_TURN_ATTEMPT).toBe(4);
  });

  test("isTurnAttempt accepts exactly the integers 1..4", () => {
    expect(isTurnAttempt(1)).toBe(true);
    expect(isTurnAttempt(2)).toBe(true);
    expect(isTurnAttempt(3)).toBe(true);
    expect(isTurnAttempt(4)).toBe(true);
  });

  test("isTurnAttempt rejects 0, 5, negative, and non-integer values", () => {
    expect(isTurnAttempt(0)).toBe(false);
    expect(isTurnAttempt(5)).toBe(false);
    expect(isTurnAttempt(-1)).toBe(false);
    expect(isTurnAttempt(1.5)).toBe(false);
  });

  test("canRetryAfterGate is true only while attempt < 4", () => {
    expect(canRetryAfterGate(1)).toBe(true);
    expect(canRetryAfterGate(2)).toBe(true);
    expect(canRetryAfterGate(3)).toBe(true);
    expect(canRetryAfterGate(4)).toBe(false);
  });
});

describe('turn terminal outcome (§7.2: "`terminal` carries `failed | cancelled | stale | interrupted`")', () => {
  test("TURN_TERMINAL_OUTCOMES lists exactly the four spec outcomes in spec order", () => {
    expect(TURN_TERMINAL_OUTCOMES).toEqual(["failed", "cancelled", "stale", "interrupted"]);
  });
});
