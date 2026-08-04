import { describe, expect, test } from "bun:test";

import { COMMAND_KINDS_V1, type CommandKindV1, primaryReason } from "core/protocol";
import { DEFERRED_CAPABILITY_KINDS } from "core/versions";
import { uuidv7 } from "infrastructure/uuid";

import type { CapabilityRecord, KernelStateSnapshot } from "../types";
import { evaluateCapabilityGuard } from "./guards";
import { diffCapabilities, projectCapabilities, projectCapability } from "./projector";

/**
 * kernel-command-contract §10.2 (lines 905-921): "The capability projector calls the SAME
 * function over the current state and the same normalized target ... Capability/guard
 * parity is an invariant: for the same state and target, a published available capability
 * must let a direct current-revision command pass the guard, and an unavailable
 * capability must reject it with the same primary code." §13.2 requires exactly this as a
 * property test.
 */

let slugSeq = 0;
function slug(): string {
  slugSeq += 1;
  return `slug-${slugSeq}`;
}

function representativeTarget(kind: CommandKindV1): unknown {
  switch (kind) {
    case "project.create":
    case "project.open":
    case "project.close":
    case "turn.start":
    case "chat.create":
    case "page.reorder":
    case "selection.clear":
    case "export.start":
    case "migration.plan":
      return null;
    case "project.retryOpen":
      return { recovery: { kind: "restore", restoreActionId: uuidv7() } };
    case "project.setTrust":
      return { workspaceIdentity: "workspace-1" };
    case "turn.cancel":
      return { turnId: uuidv7() };
    case "chat.switch":
      return { chatId: uuidv7() };
    case "chat.load-older":
      return { chatId: uuidv7() };
    case "model.select":
      return { backend: "anthropic", model: "claude", effort: "medium" };
    case "page.renameTitle":
    case "page.removePlan":
    case "history.open":
    case "preview.selectPage":
    case "preview.selectCurrent":
      return { pageSlug: slug() };
    case "page.removeConfirm":
    case "page.removeDiscardPlan":
      return { pageRemovePlanId: uuidv7() };
    case "preview.selectHistorical":
    case "restore.plan":
      return { pageSlug: slug(), sourceCommit: "a".repeat(40) };
    case "preview.resize":
    case "preview.forwardInput":
    case "preview.retry":
    case "preview.close":
      return { previewSessionId: uuidv7() };
    case "preview.setThemeCapabilities":
      return { previewSessionId: uuidv7(), themeId: "dark" };
    case "preview.setMode":
      return { previewSessionId: uuidv7(), mode: "interactive" };
    case "preview.setTweak":
      return { previewSessionId: uuidv7(), tweakId: "font-size" };
    case "preview.queryGeometry":
      return { frameTokenId: uuidv7(), queryKind: "hit" };
    case "selection.set":
      return { pageSlug: slug(), elementId: "el-1" };
    case "pin.create":
      return { geometryTokenId: uuidv7() };
    case "pin.setStatus":
      return { pinId: uuidv7(), status: "open" };
    case "restore.confirm":
    case "restore.discardPlan":
      return { restorePlanId: uuidv7() };
    case "restore.retryRecord":
      return { restoreActionId: uuidv7() };
    case "commit.plan":
      return { scope: "current-page" };
    case "commit.confirm":
    case "commit.discardPlan":
      return { commitPlanId: uuidv7() };
    case "migration.confirm":
    case "migration.discardPlan":
      return { migrationPlanId: uuidv7() };
    case "migration.retryRecovery":
      return { migrationActionId: uuidv7() };
  }
}

function cleanState(): KernelStateSnapshot {
  return {
    project: { phase: "ready", trust: "trusted" },
    turn: { phase: "idle", activeTurnId: null, commitIntentRecorded: false },
    restore: { phase: "idle" },
    commit: { phase: "idle" },
    export: { phase: "idle" },
    preview: { phase: "live", sourceKind: "current" },
    migration: { phase: "idle" },
  };
}

/**
 * A wide, hand-varied set of LEGAL `KernelStateSnapshot` combinations — every project
 * phase/trust pairing that can genuinely occur, every turn phase (with a matching active
 * turnId whenever the phase is non-idle), several migration/export/preview phases, and a
 * historical preview source. This is the property test's state space: not a single
 * happy-path snapshot, and not truly random, but broad enough that a guard/projector
 * divergence on any of the cross-cutting rules (project readiness, trust, turn lock,
 * migration idle, deferred families, per-machine phase legality) would show up on at
 * least one (state, kind) pair.
 */
function* legalStateCombinations(): Generator<KernelStateSnapshot> {
  const projectVariants: readonly Pick<KernelStateSnapshot, "project">["project"][] = [
    { phase: "closed", trust: null },
    { phase: "opening", trust: null },
    { phase: "opening", trust: "trusted" },
    { phase: "recovering", trust: null },
    { phase: "ready", trust: "trusted" },
    { phase: "ready", trust: "untrusted-read-only" },
    { phase: "blocked", trust: null },
    { phase: "closing", trust: "trusted" },
  ];

  const idleTurnId = uuidv7();
  const runningTurnId = uuidv7();
  const turnVariants: readonly KernelStateSnapshot["turn"][] = [
    { phase: "idle", activeTurnId: null, commitIntentRecorded: false },
    { phase: "running", activeTurnId: runningTurnId, commitIntentRecorded: false },
    { phase: "finalizing", activeTurnId: runningTurnId, commitIntentRecorded: false },
    { phase: "finalizing", activeTurnId: runningTurnId, commitIntentRecorded: true },
    { phase: "terminal", activeTurnId: idleTurnId, commitIntentRecorded: false },
  ];

  const migrationVariants: readonly KernelStateSnapshot["migration"]["phase"][] = [
    "idle",
    "transforming",
    "blocked",
  ];
  const exportVariants: readonly KernelStateSnapshot["export"]["phase"][] = ["idle", "rendering"];
  const previewVariants: readonly KernelStateSnapshot["preview"][] = [
    { phase: "live", sourceKind: "current" },
    { phase: "live", sourceKind: "historical" },
    { phase: "disabled", sourceKind: null },
    { phase: "circuit-open", sourceKind: null },
  ];

  for (const project of projectVariants) {
    for (const turn of turnVariants) {
      for (const migration of migrationVariants) {
        for (const exportPhase of exportVariants) {
          for (const preview of previewVariants) {
            yield {
              project,
              turn,
              restore: { phase: "idle" },
              commit: { phase: "idle" },
              export: { phase: exportPhase },
              preview,
              migration: { phase: migration },
            };
          }
        }
      }
    }
  }
}

/**
 * Every target worth comparing for one kind against one state. Most kinds have a single
 * shape, but the ones whose guard BRANCHES on target content need each branch represented
 * — and for identity-bound kinds one of those targets must be derived from the state being
 * iterated, not from a fresh id, or the matching branch is unreachable.
 */
function targetsFor(kind: CommandKindV1, state: KernelStateSnapshot): unknown[] {
  if (kind === "turn.cancel") {
    const active = state.turn.activeTurnId;
    // The foreign id exercises TURN_ID_MISMATCH; the active one exercises available and
    // CANCEL_TOO_LATE, which no fresh uuid can ever reach.
    return active === null ? [{ turnId: uuidv7() }] : [{ turnId: uuidv7() }, { turnId: active }];
  }
  if (kind === "preview.setMode") {
    const previewSessionId = uuidv7();
    return [
      { previewSessionId, mode: "interactive" },
      { previewSessionId, mode: "static" },
    ];
  }
  if (kind === "pin.setStatus") {
    const pinId = uuidv7();
    return [
      { pinId, status: "open" },
      { pinId, status: "resolved" },
    ];
  }
  if (kind === "commit.plan") {
    return [{ scope: "current-page" }, { scope: "infrastructure" }, { scope: "whole-project" }];
  }
  return [representativeTarget(kind)];
}

describe("projectCapability — parity with evaluateCapabilityGuard (§10.2, §13.2)", () => {
  test("wraps the exact guard decision as { id, target, state }", () => {
    const state = cleanState();
    const entry = projectCapability("selection.set", { pageSlug: slug(), elementId: "e1" }, state);
    expect(entry.id).toBe("selection.set");
    expect(entry.state).toEqual(evaluateCapabilityGuard("selection.set", entry.target, state));
  });

  test("property: for every legal state combination and every one of the 44 kinds, the projected capability's availability and primary code match calling the guard directly", () => {
    let comparisons = 0;
    for (const state of legalStateCombinations()) {
      for (const kind of COMMAND_KINDS_V1) {
        // §13.2 requires "every exact CapabilityTargetByKindV1 target", not one sample per
        // kind. A single representative hides every target-SENSITIVE divergence: with a
        // freshly-minted turnId, turn.cancel could only ever reach TURN_ID_MISMATCH, so the
        // branches that actually matter — cancelling the live turn, and CANCEL_TOO_LATE —
        // were never compared, and a projector that broke exactly the Esc-cancels-a-running-
        // turn case passed the whole suite.
        for (const target of targetsFor(kind, state)) {
          const direct = evaluateCapabilityGuard(kind, target, state);
          const projected = projectCapability(kind, target as never, state).state;

          expect(projected.available, `${kind}: availability mismatch`).toBe(direct.available);

          if (!direct.available && !projected.available) {
            expect(primaryReason(projected.reasons).code, `${kind}: primary code mismatch`).toBe(
              primaryReason(direct.reasons).code,
            );
          }
          comparisons += 1;
        }
      }
    }
    // Sanity: the generator + 43 kinds actually produced a non-trivial number of comparisons.
    expect(comparisons).toBeGreaterThan(1000);
  });
});

/**
 * MVP phase-8 task 18 documented `migration.*`'s handler (`core/kernel/model/handlers/
 * index.ts`'s `migrationPostMvpHandler`) as a deliberate post-MVP no-op — MVP ships exactly
 * one storage format version, so there is nothing to migrate FROM. That decision does NOT
 * make `migration.*` a Tier-C `DEFERRED_CAPABILITY_KINDS` member (`core/versions`): unlike the
 * 10 deferred kinds, whose guards reject unconditionally in every phase because no service
 * exists behind them at all, `migration.*`'s guard (`guards.ts`'s `migrationFamilyReason`) is
 * fully real — it evaluates genuine phase legality against `MIGRATION_TRANSITION_TABLE`
 * (`core/machines`), matching kernel-command-contract §7.7 row for row (see that function's
 * own header comment for the full citation chain).
 *
 * These tests exercise `projectCapability` — the PROJECTOR a UI actually consumes, not
 * `evaluateCapabilityGuard` in isolation (the existing per-kind property test above already
 * proves projector/guard parity generically for all 43 kinds; this block makes the
 * migration-specific shape explicit and independently readable) — to pin down, on purpose:
 * capability `available: true` here means "this command passes the guard" (KCC §10.2's own
 * definition), never "dispatching it will move `MigrationState` or perform migration work."
 * A future change that "fixes" this by adding `migration.*` to `DEFERRED_CAPABILITY_KINDS`
 * would make it unconditionally unavailable in every phase and break `guards.test.ts`'s own
 * `describe("migration family phase legality", ...)` assertions (`migration.plan` available
 * from `idle`, `migration.confirm`/`discardPlan` only from `awaiting-confirmation`,
 * `migration.retryRecovery` only from `blocked`) — this block is the projector-side half of
 * that same regression guard.
 */
describe("projectCapability — migration.* is guard-legal, phase-sensitive, and NOT Tier-C deferred (task 18)", () => {
  test("migration.* kinds are absent from DEFERRED_CAPABILITY_KINDS", () => {
    for (const kind of [
      "migration.plan",
      "migration.confirm",
      "migration.discardPlan",
      "migration.retryRecovery",
    ] as const) {
      expect(DEFERRED_CAPABILITY_KINDS, `${kind} must not be Tier-C deferred`).not.toContain(kind);
    }
  });

  test("migration.plan projects available: true from the migration machine's idle phase", () => {
    const state = cleanState();
    expect(state.migration.phase).toBe("idle");

    const entry = projectCapability("migration.plan", null, state);

    expect(entry).toEqual({ id: "migration.plan", target: null, state: { available: true } });
  });

  test("migration.plan projects available: false once migration has left idle — real phase sensitivity, not an unconditional block", () => {
    const state = { ...cleanState(), migration: { phase: "transforming" as const } };

    const entry = projectCapability("migration.plan", null, state);

    expect(entry.state.available).toBe(false);
    if (entry.state.available) return;
    expect(primaryReason(entry.state.reasons).code).toBe("CAPABILITY_UNAVAILABLE");
  });
});

describe("diffCapabilities", () => {
  function record(id: CommandKindV1, target: unknown, available: boolean): CapabilityRecord {
    return {
      id,
      target,
      state: available
        ? { available: true }
        : { available: false, reasons: [{ code: "CAPABILITY_UNAVAILABLE" }] },
    };
  }

  test("a brand-new (id,target) key is 'changed'", () => {
    const next = [record("turn.start", null, true)];
    const { changed, removed } = diffCapabilities([], next);
    expect(changed).toEqual(next);
    expect(removed).toEqual([]);
  });

  test("an unchanged (id,target,state) key is NOT reported as changed", () => {
    const entry = record("turn.start", null, true);
    const { changed, removed } = diffCapabilities([entry], [entry]);
    expect(changed).toEqual([]);
    expect(removed).toEqual([]);
  });

  test("the same key with a different state IS reported as changed, with the complete replacement entry", () => {
    const before = record("turn.start", null, true);
    const after = record("turn.start", null, false);
    const { changed, removed } = diffCapabilities([before], [after]);
    expect(changed).toEqual([after]);
    expect(removed).toEqual([]);
  });

  test("a key present before and absent after is 'removed', not 'changed'", () => {
    const gone = record("preview.resize", { previewSessionId: "s1" }, true);
    const { changed, removed } = diffCapabilities([gone], []);
    expect(changed).toEqual([]);
    expect(removed).toEqual([{ id: "preview.resize", target: { previewSessionId: "s1" } }]);
  });

  test("target key comparison is insensitive to object key order", () => {
    const before = record("selection.set", { pageSlug: "p1", elementId: "e1" }, true);
    const after = record("selection.set", { elementId: "e1", pageSlug: "p1" }, true);
    const { changed, removed } = diffCapabilities([before], [after]);
    expect(changed).toEqual([]);
    expect(removed).toEqual([]);
  });

  test("different targets for the same id are different keys — both survive independently", () => {
    const a = record("selection.set", { pageSlug: "p1", elementId: "e1" }, true);
    const b = record("selection.set", { pageSlug: "p2", elementId: "e2" }, true);
    const { changed, removed } = diffCapabilities([a], [a, b]);
    expect(changed).toEqual([b]);
    expect(removed).toEqual([]);
  });
});

describe("projectCapabilities — batch projection", () => {
  test("projects every request through the same guard, in order", () => {
    const state = cleanState();
    const requests = [
      { id: "turn.start" as const, target: null },
      { id: "chat.create" as const, target: null },
    ];
    const results = projectCapabilities(requests, state);
    expect(results).toEqual([
      { id: "turn.start", target: null, state: evaluateCapabilityGuard("turn.start", null, state) },
      {
        id: "chat.create",
        target: null,
        state: evaluateCapabilityGuard("chat.create", null, state),
      },
    ]);
  });
});
