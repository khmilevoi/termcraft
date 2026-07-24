import { describe, expect, test } from "bun:test";

import { context } from "@reatom/core";

import {
  type TurnAction,
  type TurnState,
  reatomCommitStateMachine,
  reatomExportStateMachine,
  reatomMigrationStateMachine,
  reatomPreviewStateMachine,
  reatomProjectStateMachine,
  reatomRestoreStateMachine,
  reatomTurnStateMachine,
} from "core/machines";
import type { PublishableEventV1 } from "core/mailbox";
import type { BackendCapabilities } from "core/ports";
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
import {
  createFrameBroker,
  createFrameTokenLedger,
  createGeometryTokenLedger,
  createPreviewBackpressure,
  createPreviewSessionCommands,
} from "core/preview";
import { createPageRemovePlanLedger } from "core/project/model/page-remove-plan";
import { type UUIDv7, eventPayloadV1SchemaByKind } from "core/protocol";
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

import type { KernelDeps } from "../../types";
import { turnHandlers } from "./turn";
import type {
  HandlerContext,
  PreviewSourceKindV1,
  ProjectTrustV1,
  TurnCancelHandle,
} from "./types";

/**
 * `turn.start` / `turn.cancel` — Step C2, the `turn` family (`./turn.ts`'s own header
 * documents the design and its one genuine remaining blocker; this file proves it against
 * the real fakes).
 *
 * Matches `selection-model.test.ts`'s own `buildTestContext` shape (a real `HandlerContext`
 * — real Reatom machines inside one `context.start(...)` frame, real fakes from
 * `core/ports/fakes`), extended with a STATEFUL `turnRunner.setActiveAttempt`/
 * `activeAttempt` pair (kernel.ts's own real semantics: a single slot keyed by the current
 * `activeTurnId`, never a stale handle) so this file can prove `turn.cancel`'s "genuinely
 * stop a running attempt" branch against a directly-injected fake handle — independent of
 * whether `turn.start` itself can populate that slot in this Kernel build (`./turn.ts`'s own
 * header, Gap 3).
 */

const FAKE_BACKEND_CAPABILITIES: BackendCapabilities = {
  backendId: "claude",
  models: [{ model: "sonnet", efforts: ["medium"] }],
  confinement: "canUseTool",
  sessionWorkspaceBinding: "fixed",
};

interface LaunchedOperation {
  readonly label: string;
  readonly run: () => Promise<readonly PublishableEventV1[]>;
}

interface TestContext {
  readonly handlerContext: HandlerContext;
  readonly setActiveTurnId: (turnId: UUIDv7 | null) => void;
  readonly getLaunchedOperations: () => readonly LaunchedOperation[];
  readonly getMutatorCalls: () => number;
}

function buildTestContext(): TestContext {
  return context.start(() => {
    let mutatorCalls = 0;
    const launched: LaunchedOperation[] = [];
    let trust: ProjectTrustV1 = null;
    let activeTurnId: UUIDv7 | null = null;
    let commitIntentRecorded = false;
    let previewSourceKind: PreviewSourceKindV1 = null;
    let activeAttempt: TurnCancelHandle | null = null;

    const machines = {
      project: reatomProjectStateMachine(),
      turn: reatomTurnStateMachine(),
      restore: reatomRestoreStateMachine(),
      commit: reatomCommitStateMachine(),
      export: reatomExportStateMachine(),
      preview: reatomPreviewStateMachine(),
      migration: reatomMigrationStateMachine(),
    };

    const chatStore = createFakeChatStore();
    const pageStore = createFakePageStore({ order: [] });
    const pinStore = createFakePinStore();
    const projectStore = createFakeProjectStore({ root: "/test-root" });
    const clock: Clock = { now: () => new Date(1_700_000_000_000) };

    const deps: KernelDeps = {
      projectStore,
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
      agentRegistry: createFakeAgentRegistry([
        createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES }),
      ]),
      clock,
    };
    const frameTokenLedger = createFrameTokenLedger();
    const geometryTokenLedger = createGeometryTokenLedger({ clock: deps.clock });

    const handlerContext: HandlerContext = {
      deps,
      machines,
      readKernelState: () => ({
        project: { phase: machines.project.phase(), trust },
        turn: { phase: machines.turn.phase(), activeTurnId, commitIntentRecorded },
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
      launchOperation: (label, run) => {
        launched.push({ label, run });
      },
      turnRunner: {
        machine: machines.turn,
        // Mirrors `kernel.ts`'s own real `setActiveAttempt`/`activeAttempt`: a single slot,
        // keyed by whichever `turnId` `activeTurnId` currently names — never a stale handle
        // from an already-settled turn.
        setActiveAttempt: (handle) => {
          activeAttempt = handle;
        },
        activeAttempt: (turnId) => (activeTurnId === turnId ? activeAttempt : null),
      },
      setSelection: () => {},
      selection: () => null,
      currentPreviewSession: () => null,
      previewSessionCommands: createPreviewSessionCommands({
        machine: machines.preview,
        hostSupervisor: deps.hostSupervisor,
        frameBroker: createFrameBroker(),
        frameTokenLedger,
        geometryTokenLedger,
        backpressure: createPreviewBackpressure(),
      }),
      frameTokenLedger,
      geometryTokenLedger,
      pageRemovePlanLedger: createPageRemovePlanLedger(),
    };

    return {
      handlerContext,
      setActiveTurnId: (next) => {
        activeTurnId = next;
      },
      getLaunchedOperations: () => launched,
      getMutatorCalls: () => mutatorCalls,
    };
  });
}

describe('turnHandlers["turn.start"]', () => {
  test("is a documented no-op: no machine transition, no launched operation (Gap 3, ./turn.ts's own header)", () => {
    const { handlerContext, getLaunchedOperations } = buildTestContext();

    const outcome = turnHandlers["turn.start"]({ text: "hello" }, handlerContext);

    expect(outcome).toEqual({ disposition: "no-op", events: [] });
    expect(handlerContext.machines.turn.phase()).toBe("idle");
    expect(getLaunchedOperations()).toHaveLength(0);
  });
});

describe('turnHandlers["turn.cancel"]', () => {
  const TURN_ID = uuidv7();

  /** Drives the real turn machine through the named sequence of actions before each test. */
  function admitTo(handlerContext: HandlerContext, actions: readonly TurnAction[]): void {
    for (const action of actions) {
      const outcome = handlerContext.machines.turn.apply(action);
      if (outcome.kind !== "changed") {
        throw new Error(`test setup: ${action} was not a real transition (${outcome.kind})`);
      }
    }
  }

  const SINGLE_HOP_PHASES: readonly {
    readonly name: string;
    readonly actions: readonly TurnAction[];
    readonly previousTag: TurnState;
  }[] = [
    { name: "admitting", actions: ["beginAdmission"], previousTag: "admitting" },
    {
      name: "workspace-ready",
      actions: ["beginAdmission", "finishAdmission"],
      previousTag: "workspace-ready",
    },
    {
      name: "snapshotting",
      actions: [
        "beginAdmission",
        "finishAdmission",
        "beginAttempt",
        "beginStopping",
        "beginSnapshot",
      ],
      previousTag: "snapshotting",
    },
    {
      name: "validating",
      actions: [
        "beginAdmission",
        "finishAdmission",
        "beginAttempt",
        "beginStopping",
        "beginSnapshot",
        "candidateCaptured",
      ],
      previousTag: "validating",
    },
    {
      name: "finalizing",
      actions: [
        "beginAdmission",
        "finishAdmission",
        "beginAttempt",
        "beginStopping",
        "beginSnapshot",
        "candidateCaptured",
        "beginFinalization",
      ],
      previousTag: "finalizing",
    },
  ];

  for (const { name, actions, previousTag } of SINGLE_HOP_PHASES) {
    test(`from "${name}" (no live attempt): applies requestCancel to terminalizing, a completed outcome, no launched operation`, () => {
      const { handlerContext, setActiveTurnId, getLaunchedOperations } = buildTestContext();
      setActiveTurnId(TURN_ID);
      admitTo(handlerContext, actions);

      const outcome = turnHandlers["turn.cancel"]({ turnId: TURN_ID }, handlerContext);

      expect(handlerContext.machines.turn.phase()).toBe("terminalizing");
      expect(outcome).toEqual({
        disposition: "completed",
        events: [
          {
            kind: "kernel.stateChanged",
            payload: {
              modelId: "kernel.turn.state",
              action: "kernel.turn.requestCancel",
              previousTag,
              nextTag: "terminalizing",
              metadata: {},
            },
            correlation: { turnId: TURN_ID },
          },
        ],
      });
      const [event] = outcome.events;
      if (event === undefined) throw new Error("expected exactly one event");
      expect(
        eventPayloadV1SchemaByKind["kernel.stateChanged"].safeParse(event.payload).success,
      ).toBe(true);
      expect(getLaunchedOperations()).toHaveLength(0);
    });
  }

  test('from "running" with NO live attempt registered: moves to stopping, a completed outcome, no launched operation', () => {
    const { handlerContext, setActiveTurnId, getLaunchedOperations } = buildTestContext();
    setActiveTurnId(TURN_ID);
    admitTo(handlerContext, ["beginAdmission", "finishAdmission", "beginAttempt"]);

    const outcome = turnHandlers["turn.cancel"]({ turnId: TURN_ID }, handlerContext);

    expect(handlerContext.machines.turn.phase()).toBe("stopping");
    expect(outcome).toEqual({
      disposition: "completed",
      events: [
        {
          kind: "kernel.stateChanged",
          payload: {
            modelId: "kernel.turn.state",
            action: "kernel.turn.requestCancel",
            previousTag: "running",
            nextTag: "stopping",
            metadata: {},
          },
          correlation: { turnId: TURN_ID },
        },
      ],
    });
    expect(getLaunchedOperations()).toHaveLength(0);
  });

  test('from "running" WITH a live attempt registered: moves to stopping, a started outcome, and GENUINELY drives the real handle\'s requestCancel (never just the phase flip)', async () => {
    const { handlerContext, setActiveTurnId, getLaunchedOperations } = buildTestContext();
    setActiveTurnId(TURN_ID);
    admitTo(handlerContext, ["beginAdmission", "finishAdmission", "beginAttempt"]);

    let cancelCalls = 0;
    const fakeHandle: TurnCancelHandle = {
      requestCancel: async () => {
        cancelCalls += 1;
      },
    };
    handlerContext.turnRunner.setActiveAttempt(fakeHandle);

    const outcome = turnHandlers["turn.cancel"]({ turnId: TURN_ID }, handlerContext);

    expect(handlerContext.machines.turn.phase()).toBe("stopping");
    expect(outcome).toEqual({
      disposition: "started",
      events: [
        {
          kind: "kernel.stateChanged",
          payload: {
            modelId: "kernel.turn.state",
            action: "kernel.turn.requestCancel",
            previousTag: "running",
            nextTag: "stopping",
            metadata: {},
          },
          correlation: { turnId: TURN_ID },
        },
      ],
    });
    expect(cancelCalls).toBe(0); // not yet — only inside the launched operation's own run()

    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    expect(operation.label).toBe("kernel.turn.cancel");

    const events = await operation.run();
    expect(events).toEqual([]);
    expect(cancelCalls).toBe(1);
  });

  test('a repeated cancel while already "stopping" is an accepted no-op (§8.4 point 4), not a failure', () => {
    const { handlerContext, setActiveTurnId, getLaunchedOperations } = buildTestContext();
    setActiveTurnId(TURN_ID);
    admitTo(handlerContext, ["beginAdmission", "finishAdmission", "beginAttempt", "beginStopping"]);

    const outcome = turnHandlers["turn.cancel"]({ turnId: TURN_ID }, handlerContext);

    expect(outcome).toEqual({ disposition: "no-op", events: [] });
    expect(handlerContext.machines.turn.phase()).toBe("stopping");
    expect(getLaunchedOperations()).toHaveLength(0);
  });

  test('a repeated cancel while already "terminalizing" is an accepted no-op', () => {
    const { handlerContext, setActiveTurnId, getLaunchedOperations } = buildTestContext();
    setActiveTurnId(TURN_ID);
    admitTo(handlerContext, [
      "beginAdmission",
      "finishAdmission",
      "beginAttempt",
      "beginStopping",
      "beginTerminalization",
    ]);

    const outcome = turnHandlers["turn.cancel"]({ turnId: TURN_ID }, handlerContext);

    expect(outcome).toEqual({ disposition: "no-op", events: [] });
    expect(handlerContext.machines.turn.phase()).toBe("terminalizing");
    expect(getLaunchedOperations()).toHaveLength(0);
  });

  test('an "idle" turn (no admission ever ran) is defensively rejected as a no-op — unreachable via a correctly-wired guard, kept explicit', () => {
    const { handlerContext, setActiveTurnId, getLaunchedOperations } = buildTestContext();
    setActiveTurnId(TURN_ID);

    const outcome = turnHandlers["turn.cancel"]({ turnId: TURN_ID }, handlerContext);

    expect(outcome).toEqual({ disposition: "no-op", events: [] });
    expect(handlerContext.machines.turn.phase()).toBe("idle");
    expect(getLaunchedOperations()).toHaveLength(0);
  });
});
