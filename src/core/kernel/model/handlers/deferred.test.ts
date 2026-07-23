import { describe, expect, test } from "bun:test";

import { context } from "@reatom/core";

import {
  reatomCommitStateMachine,
  reatomExportStateMachine,
  reatomMigrationStateMachine,
  reatomPreviewStateMachine,
  reatomProjectStateMachine,
  reatomRestoreStateMachine,
  reatomTurnStateMachine,
} from "core/machines";
import {
  createFakeAgentBackend,
  createFakeAgentRegistry,
  createFakeChatStore,
  createFakeDiagnosticsCache,
  createFakeExportPublish,
  createFakeExportRenderPort,
  createFakeGateRunner,
  createFakeHostSupervisorPort,
  createFakePageMetaCache,
  createFakePageStore,
  createFakePinStore,
  createFakeProjectStore,
  createFakeProjectWriteCoordinator,
  createFakeRecoveryService,
  createFakeRenderCache,
  createFakeSessionCheckpointService,
  createFakeStagingService,
  createFakeTrustGate,
  createFakeTurnTransactionService,
} from "core/ports/fakes";
import type { UUIDv7 } from "core/protocol";
import { deferredCapabilityReason } from "core/versions";
import { parsePageSlug } from "entities/page";
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

import type { KernelDeps } from "../../types";
import { DEFERRED_CAPABILITY_KINDS, DEFERRED_HANDLER_KINDS, deferredHandlers } from "./deferred";
import type { HandlerContext, PreviewSourceKindV1, ProjectTrustV1 } from "./types";

function slug(value: string) {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

/** A full, real `KernelDeps` from `core/ports/fakes` — no git ports, matching `kernel.test.ts`'s own `buildDeps`. */
function buildDeps(): KernelDeps {
  const chatStore = createFakeChatStore();
  const pageStore = createFakePageStore({ order: [] });
  const pinStore = createFakePinStore();
  const clock: Clock = { now: () => new Date(1_700_000_000_000) };

  return {
    projectStore: createFakeProjectStore({ root: "/test-root" }),
    chatReader: chatStore,
    chatMutations: chatStore,
    pageReader: pageStore,
    pageMutations: pageStore,
    pinReader: pinStore,
    pinMutations: pinStore,
    turnTransactions: createFakeTurnTransactionService(),
    projectWrite: createFakeProjectWriteCoordinator(),
    staging: createFakeStagingService(),
    trustGate: createFakeTrustGate(),
    pageMetaCache: createFakePageMetaCache(),
    diagnosticsCache: createFakeDiagnosticsCache(),
    renderCache: createFakeRenderCache(),
    sessionCheckpoint: createFakeSessionCheckpointService(),
    recovery: createFakeRecoveryService(),
    gateRunner: createFakeGateRunner(),
    hostSupervisor: createFakeHostSupervisorPort(),
    exportRender: createFakeExportRenderPort(),
    exportPublish: createFakeExportPublish(),
    agentRegistry: createFakeAgentRegistry([createFakeAgentBackend()]),
    clock,
  };
}

/**
 * A real `HandlerContext` — real machines built inside one Reatom frame (matching
 * `kernel.ts`'s own construction), real fake ports, and mutators/`launchOperation` that
 * count their own calls so a test can prove `rejectDeferred` never reaches any of them
 * (a Tier-C deferred handler must never mutate Kernel-held state OR launch async work).
 */
function buildTestContext(): {
  readonly handlerContext: HandlerContext;
  readonly getMutatorCalls: () => number;
  readonly getLaunchOperationCalls: () => number;
} {
  return context.start(() => {
    let mutatorCalls = 0;
    let launchOperationCalls = 0;
    let trust: ProjectTrustV1 = null;
    let activeTurnId: UUIDv7 | null = null;
    let commitIntentRecorded = false;
    let previewSourceKind: PreviewSourceKindV1 = null;

    const machines = {
      project: reatomProjectStateMachine(),
      turn: reatomTurnStateMachine(),
      restore: reatomRestoreStateMachine(),
      commit: reatomCommitStateMachine(),
      export: reatomExportStateMachine(),
      preview: reatomPreviewStateMachine(),
      migration: reatomMigrationStateMachine(),
    };

    const handlerContext: HandlerContext = {
      deps: buildDeps(),
      machines,
      readKernelState: () => ({
        project: { phase: machines.project.phase(), trust },
        turn: {
          phase: machines.turn.phase(),
          activeTurnId,
          commitIntentRecorded,
        },
        restore: { phase: machines.restore.phase() },
        commit: { phase: machines.commit.phase() },
        export: { phase: machines.export.phase() },
        preview: { phase: machines.preview.phase(), sourceKind: previewSourceKind },
        migration: { phase: machines.migration.phase() },
      }),
      setProjectTrust: (next) => {
        mutatorCalls += 1;
        trust = next;
      },
      setActiveTurnId: (next) => {
        mutatorCalls += 1;
        activeTurnId = next;
      },
      setCommitIntentRecorded: (next) => {
        mutatorCalls += 1;
        commitIntentRecorded = next;
      },
      setPreviewSourceKind: (next) => {
        mutatorCalls += 1;
        previewSourceKind = next;
      },
      setActivePreviewSession: () => {
        mutatorCalls += 1;
      },
      launchOperation: () => {
        launchOperationCalls += 1;
      },
    };

    return {
      handlerContext,
      getMutatorCalls: () => mutatorCalls,
      getLaunchOperationCalls: () => launchOperationCalls,
    };
  });
}

/** One valid, representative payload per deferred kind (`command-payload.ts`'s own schemas). */
const SAMPLE_PAYLOADS: Readonly<Record<(typeof DEFERRED_HANDLER_KINDS)[number], unknown>> = {
  "restore.plan": { pageSlug: slug("home"), sourceCommit: "a".repeat(40) },
  "restore.confirm": { restorePlanId: uuidv7(), overwriteAcknowledged: true },
  "restore.discardPlan": { restorePlanId: uuidv7() },
  "restore.retryRecord": { restoreActionId: uuidv7() },
  "commit.plan": { scope: "current-page" },
  "commit.confirm": { commitPlanId: uuidv7(), message: "message", warningAcknowledged: true },
  "commit.discardPlan": { commitPlanId: uuidv7() },
  "history.open": { pageSlug: slug("home") },
  "preview.forwardInput": { previewSessionId: uuidv7(), input: { kind: "key", key: "a" } },
  "preview.setTweak": {
    previewSessionId: uuidv7(),
    tweakId: "tweak-1",
    value: { kind: "boolean", value: true },
  },
};

describe("deferredHandlers", () => {
  test("this file's own kind list matches core/versions's DEFERRED_CAPABILITY_KINDS exactly", () => {
    // Compared as plain strings, deliberately: `DEFERRED_HANDLER_KINDS` is the precise
    // 10-member literal tuple and `DEFERRED_CAPABILITY_KINDS` is typed as the full 43-kind
    // union at its own declaration site (`core/versions`) — this test asserts SET equality
    // of the values, not that the two declarations share one TypeScript type.
    const local: readonly string[] = DEFERRED_HANDLER_KINDS;
    const versions: readonly string[] = DEFERRED_CAPABILITY_KINDS;
    expect([...local].sort()).toEqual([...versions].sort());
  });

  test("every deferred kind is unconditionally CAPABILITY_UNAVAILABLE at the guard's own reason function", () => {
    for (const kind of DEFERRED_HANDLER_KINDS) {
      expect(deferredCapabilityReason(kind)).toEqual({ code: "CAPABILITY_UNAVAILABLE" });
    }
  });

  for (const kind of DEFERRED_HANDLER_KINDS) {
    test(`"${kind}" returns the well-formed no-op and never touches the context`, () => {
      const { handlerContext, getMutatorCalls, getLaunchOperationCalls } = buildTestContext();
      const payload = SAMPLE_PAYLOADS[kind];

      const outcome = deferredHandlers[kind](payload as never, handlerContext);

      expect(outcome).toEqual({ disposition: "no-op", events: [] });
      expect(getMutatorCalls()).toBe(0);
      expect(getLaunchOperationCalls()).toBe(0);
    });
  }
});
