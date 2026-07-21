import { describe, expect, test } from "bun:test";

import { context } from "@reatom/core";

import { type CommitAction, type CommitState, reatomCommitStateMachine } from "./commit-machine";

/**
 * kernel-command-contract §7.4, §13.1.
 *
 * `COMMIT_STATES`, `COMMIT_ACTIONS`, and `EXPECTED_EDGES` are transcribed BY HAND from
 * §7.4's table a second time, independently of `commit-machine.ts`'s own
 * `COMMIT_TRANSITION_TABLE` — see `export-machine.test.ts` for why iterating the
 * implementation's own table would not discriminate.
 */

const COMMIT_STATES: readonly CommitState[] = [
  "idle",
  "planning",
  "awaiting-confirmation",
  "executing",
  "refreshing",
];

const COMMIT_ACTIONS: readonly CommitAction[] = [
  "kernel.commit.beginPlan",
  "kernel.commit.planReady",
  "kernel.commit.planFailed",
  "kernel.commit.confirm",
  "kernel.commit.discardPlan",
  "kernel.commit.beginRefresh",
  "kernel.commit.finishRefresh",
];

interface ExpectedEdge {
  readonly from: CommitState;
  readonly action: CommitAction;
  readonly to: CommitState;
}

// One row per §7.4 table entry — every row in this table has exactly one source.
const EXPECTED_EDGES: readonly ExpectedEdge[] = [
  { from: "idle", action: "kernel.commit.beginPlan", to: "planning" },
  { from: "planning", action: "kernel.commit.planReady", to: "awaiting-confirmation" },
  { from: "planning", action: "kernel.commit.planFailed", to: "idle" },
  { from: "awaiting-confirmation", action: "kernel.commit.confirm", to: "executing" },
  { from: "awaiting-confirmation", action: "kernel.commit.discardPlan", to: "idle" },
  { from: "executing", action: "kernel.commit.beginRefresh", to: "refreshing" },
  { from: "refreshing", action: "kernel.commit.finishRefresh", to: "idle" },
];

const ILLEGAL_CODE = "OPERATION_BUSY";

function findExpected(from: CommitState, action: CommitAction): ExpectedEdge | undefined {
  return EXPECTED_EDGES.find((edge) => edge.from === from && edge.action === action);
}

/** Drives a fresh machine straight to `phase` via a known-legal edge path. */
function machineAt(phase: CommitState) {
  const m = reatomCommitStateMachine();
  if (phase === "idle") return m;
  const path: Record<Exclude<CommitState, "idle">, readonly CommitAction[]> = {
    planning: ["kernel.commit.beginPlan"],
    "awaiting-confirmation": ["kernel.commit.beginPlan", "kernel.commit.planReady"],
    executing: ["kernel.commit.beginPlan", "kernel.commit.planReady", "kernel.commit.confirm"],
    refreshing: [
      "kernel.commit.beginPlan",
      "kernel.commit.planReady",
      "kernel.commit.confirm",
      "kernel.commit.beginRefresh",
    ],
  };
  for (const action of path[phase]) m.apply(action);
  return m;
}

describe("reatomCommitStateMachine", () => {
  test("starts idle", () => {
    context.start(() => {
      expect(reatomCommitStateMachine().phase()).toBe("idle");
    });
  });

  test("the phase atom carries the §6 trace root", () => {
    context.start(() => {
      expect(reatomCommitStateMachine().phaseAtom.name).toBe("kernel.commit.state");
    });
  });

  test("the hand-counted §7.4 edge total is 7", () => {
    expect(EXPECTED_EDGES.length).toBe(7);
  });

  test("every (state, action) pair matches the §7.4 table exactly", () => {
    context.start(() => {
      for (const from of COMMIT_STATES) {
        for (const action of COMMIT_ACTIONS) {
          const expected = findExpected(from, action);
          const m = machineAt(from);
          const outcome = m.apply(action);

          if (expected === undefined) {
            expect(outcome).toEqual({ kind: "illegal", code: ILLEGAL_CODE, from, action });
            expect(m.phase()).toBe(from);
            continue;
          }

          expect(outcome).toEqual({ kind: "changed", from, to: expected.to });
          expect(m.phase()).toBe(expected.to);
        }
      }
    });
  });

  test("a full plan-through-refresh cycle returns to idle", () => {
    context.start(() => {
      const m = reatomCommitStateMachine();
      m.apply("kernel.commit.beginPlan");
      m.apply("kernel.commit.planReady");
      m.apply("kernel.commit.confirm");
      m.apply("kernel.commit.beginRefresh");
      const outcome = m.apply("kernel.commit.finishRefresh");
      expect(outcome).toEqual({ kind: "changed", from: "refreshing", to: "idle" });
      expect(m.phase()).toBe("idle");
    });
  });
});
