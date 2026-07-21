import { describe, expect, test } from "bun:test";

import { context } from "@reatom/core";

import {
  type MigrationAction,
  type MigrationState,
  reatomMigrationStateMachine,
} from "./migration-machine";

/**
 * kernel-command-contract §7.7, §13.1.
 *
 * `MIGRATION_STATES`, `MIGRATION_ACTIONS`, and `EXPECTED_EDGES` are transcribed BY HAND
 * from §7.7's table a second time, independently of `migration-machine.ts`'s own
 * `MIGRATION_TRANSITION_TABLE` — see `export-machine.test.ts` for why iterating the
 * implementation's own table would not discriminate.
 */

const MIGRATION_STATES: readonly MigrationState[] = [
  "idle",
  "planning",
  "awaiting-confirmation",
  "backing-up",
  "transforming",
  "publishing",
  "recovering",
  "blocked",
];

const MIGRATION_ACTIONS: readonly MigrationAction[] = [
  "kernel.migration.beginPlan",
  "kernel.migration.planReady",
  "kernel.migration.planFailed",
  "kernel.migration.confirm",
  "kernel.migration.discardPlan",
  "kernel.migration.backupVerified",
  "kernel.migration.failBeforeIntent",
  "kernel.migration.beginPublication",
  "kernel.migration.complete",
  "kernel.migration.beginRecovery",
  "kernel.migration.completeRecovery",
  "kernel.migration.blockRecovery",
  "kernel.migration.retryRecovery",
];

interface ExpectedEdge {
  readonly from: MigrationState;
  readonly action: MigrationAction;
  readonly to: MigrationState;
}

// One row per §7.7 table entry, multi-source rows expanded to one edge per source.
const EXPECTED_EDGES: readonly ExpectedEdge[] = [
  { from: "idle", action: "kernel.migration.beginPlan", to: "planning" },
  { from: "planning", action: "kernel.migration.planReady", to: "awaiting-confirmation" },
  { from: "planning", action: "kernel.migration.planFailed", to: "idle" },
  { from: "awaiting-confirmation", action: "kernel.migration.confirm", to: "backing-up" },
  { from: "awaiting-confirmation", action: "kernel.migration.discardPlan", to: "idle" },
  { from: "backing-up", action: "kernel.migration.backupVerified", to: "transforming" },
  { from: "backing-up", action: "kernel.migration.failBeforeIntent", to: "idle" },
  { from: "transforming", action: "kernel.migration.failBeforeIntent", to: "idle" },
  { from: "transforming", action: "kernel.migration.beginPublication", to: "publishing" },
  { from: "publishing", action: "kernel.migration.failBeforeIntent", to: "idle" },
  { from: "publishing", action: "kernel.migration.complete", to: "idle" },
  { from: "publishing", action: "kernel.migration.beginRecovery", to: "recovering" },
  { from: "idle", action: "kernel.migration.beginRecovery", to: "recovering" },
  { from: "recovering", action: "kernel.migration.completeRecovery", to: "idle" },
  { from: "recovering", action: "kernel.migration.blockRecovery", to: "blocked" },
  { from: "blocked", action: "kernel.migration.retryRecovery", to: "recovering" },
];

const ILLEGAL_CODE = "OPERATION_BUSY";

function findExpected(from: MigrationState, action: MigrationAction): ExpectedEdge | undefined {
  return EXPECTED_EDGES.find((edge) => edge.from === from && edge.action === action);
}

/** Drives a fresh machine straight to `phase` via a known-legal edge path. */
function machineAt(phase: MigrationState) {
  const m = reatomMigrationStateMachine();
  if (phase === "idle") return m;
  const path: Record<Exclude<MigrationState, "idle">, readonly MigrationAction[]> = {
    planning: ["kernel.migration.beginPlan"],
    "awaiting-confirmation": ["kernel.migration.beginPlan", "kernel.migration.planReady"],
    "backing-up": [
      "kernel.migration.beginPlan",
      "kernel.migration.planReady",
      "kernel.migration.confirm",
    ],
    transforming: [
      "kernel.migration.beginPlan",
      "kernel.migration.planReady",
      "kernel.migration.confirm",
      "kernel.migration.backupVerified",
    ],
    publishing: [
      "kernel.migration.beginPlan",
      "kernel.migration.planReady",
      "kernel.migration.confirm",
      "kernel.migration.backupVerified",
      "kernel.migration.beginPublication",
    ],
    recovering: ["kernel.migration.beginRecovery"],
    blocked: ["kernel.migration.beginRecovery", "kernel.migration.blockRecovery"],
  };
  for (const action of path[phase]) m.apply(action);
  return m;
}

describe("reatomMigrationStateMachine", () => {
  test("starts idle", () => {
    context.start(() => {
      expect(reatomMigrationStateMachine().phase()).toBe("idle");
    });
  });

  test("the phase atom carries the §6 trace root", () => {
    context.start(() => {
      expect(reatomMigrationStateMachine().phaseAtom.name).toBe("kernel.migration.state");
    });
  });

  test("the hand-counted §7.7 edge total is 16", () => {
    expect(EXPECTED_EDGES.length).toBe(16);
  });

  test("every (state, action) pair matches the §7.7 table exactly", () => {
    context.start(() => {
      for (const from of MIGRATION_STATES) {
        for (const action of MIGRATION_ACTIONS) {
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

  test("failBeforeIntent is legal from all three of backing-up, transforming, and publishing", () => {
    // §7.7's row lists backing-up/transforming together and publishing separately, but
    // all three share the same action name and same target — confirm each independently.
    context.start(() => {
      expect(machineAt("backing-up").apply("kernel.migration.failBeforeIntent")).toEqual({
        kind: "changed",
        from: "backing-up",
        to: "idle",
      });
      expect(machineAt("transforming").apply("kernel.migration.failBeforeIntent")).toEqual({
        kind: "changed",
        from: "transforming",
        to: "idle",
      });
      // §7.7 + §13.1: publishing -> failBeforeIntent -> idle is legal only "when journal
      // inspection proves no durable commit intent exists" — the table encodes the edge;
      // proving the precondition is the caller's (orchestration slice's) job, not
      // something this factory can enforce.
      expect(machineAt("publishing").apply("kernel.migration.failBeforeIntent")).toEqual({
        kind: "changed",
        from: "publishing",
        to: "idle",
      });
    });
  });
});
