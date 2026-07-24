import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

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
  readonly deps: KernelDeps;
  readonly setActiveTurnId: (turnId: UUIDv7 | null) => void;
  readonly getLaunchedOperations: () => readonly LaunchedOperation[];
  readonly getPublishedEvents: () => readonly PublishableEventV1[];
  readonly getMutatorCalls: () => number;
}

/**
 * `overrides` lets a test swap in its own `createFake*` instances (e.g. a `projectStore`
 * with a real `backend`/`model`/`effort`/`activeChatId` already set, or a `chatStore` the
 * test itself minted a chat through) so it can drive them directly after dispatch — mirrors
 * `kernel.test.ts`'s own `buildDeps(overrides)` precedent.
 */
function buildTestContext(overrides?: Partial<KernelDeps>): TestContext {
  return context.start(() => {
    let mutatorCalls = 0;
    const launched: LaunchedOperation[] = [];
    const publishedEvents: PublishableEventV1[] = [];
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
      ...overrides,
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
      publishOperationEvent: (event) => {
        publishedEvents.push(event);
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
      exportRunner: { machine: machines.export },
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
      deps,
      setActiveTurnId: (next) => {
        activeTurnId = next;
      },
      getLaunchedOperations: () => launched,
      getPublishedEvents: () => publishedEvents,
      getMutatorCalls: () => mutatorCalls,
    };
  });
}

describe('turnHandlers["turn.start"]', () => {
  test("starts an operation synchronously, then refuses (logged) when no active chat or agent selection exists yet (Gap 4 closed, but nothing was ever selected in this fixture)", async () => {
    const { handlerContext, getLaunchedOperations } = buildTestContext();

    const outcome = turnHandlers["turn.start"]({ text: "hello" }, handlerContext);

    // Unlike the old no-op: the handler now ALWAYS starts an operation — whether admission
    // proceeds is decided asynchronously, inside it (`selection`/`model` families' own
    // precedent for "nothing about the outcome is known until the promise settles").
    expect(outcome).toEqual({ disposition: "started", events: [] });
    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    expect(operation.label).toBe("kernel.turn.run");

    const events = await operation.run();
    expect(events).toEqual([]);
    // Nothing was ever admitted — the machine never left idle, and activeTurnId was never set.
    expect(handlerContext.machines.turn.phase()).toBe("idle");
    expect(handlerContext.readKernelState().turn.activeTurnId).toBeNull();
  });

  test("real composition: admission -> attempt -> a genuine Gate retry -> finalize -> turn.completed, activeTurnId set then cleared", async () => {
    // A deliberately minimal fixture (zero pages) isolates the admission/attempt/gate-retry/
    // finalize composition this test proves without needing byte-level per-page plumbing —
    // `core/turns/model/run-turn.test.ts`'s own suite already proves per-page composition
    // exhaustively against fakes; this test's job is proving the wiring THIS handler adds
    // (the new Gap-4 ports, the content-caching staging decorator, the live-event stream,
    // activeTurnId set/cleared, the terminal `turn.completed` event), not re-proving `runTurn`
    // itself a second time.
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

    const gateRunner = createFakeGateRunner();
    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });

    const { handlerContext, getLaunchedOperations, getPublishedEvents } = buildTestContext({
      chatReader: chatStore,
      chatMutations: chatStore,
      projectStore: createFakeProjectStore({
        root: "/test-root",
        workspaceState: {
          backend: "claude",
          model: "sonnet",
          effort: "medium",
          activeChatId: chatHeader.chatId,
        },
      }),
      agentRegistry: createFakeAgentRegistry([agentBackend]),
      gateRunner,
    });

    // Forces exactly ONE retry: the manifest-slice check rejects attempt 1's candidate; the
    // fake's own default (once its queue is empty) passes attempt 2 — a genuine Gate retry,
    // driven at the manifest-slice stage since this fixture's own `pageReader` lists zero
    // pages (no per-page `runPage` call is ever made).
    gateRunner.queueRunManifestSliceResult({
      errors: [{ kind: "manifest", code: "MANIFEST_REJECTED", message: "manifest rejected" }],
      slice: null,
    });

    const outcome = turnHandlers["turn.start"]({ text: "please add a page" }, handlerContext);
    expect(outcome).toEqual({ disposition: "started", events: [] });

    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    const runPromise = operation.run();

    /** Drains the microtask queue until `count` events of `kind` have been observed — the same `waitForStartCount` idiom `core/turns/model/run-turn.test.ts` already uses, applied to this handler's own live-published event log instead of a raw backend call log. */
    async function waitForPublishedCount(kind: string, count: number): Promise<void> {
      for (let i = 0; i < 200; i++) {
        if (getPublishedEvents().filter((e) => e.kind === kind).length >= count) return;
        await wrap(Bun.sleep(0));
      }
      throw new Error(`waitForPublishedCount: never observed ${count} "${kind}" event(s)`);
    }

    await waitForPublishedCount("turn.attemptStarted", 1);
    // Admission succeeded and attempt 1 started — the machine left "idle", and the FIRST
    // turn.attemptStarted is what set activeTurnId (this file's header, "LIVE EVENTS").
    expect(handlerContext.machines.turn.phase()).not.toBe("idle");
    const firstAttemptStarted = getPublishedEvents().find((e) => e.kind === "turn.attemptStarted");
    if (firstAttemptStarted === undefined) throw new Error("expected a turn.attemptStarted event");
    const turnId = (firstAttemptStarted.payload as { readonly turnId: string }).turnId;
    expect(handlerContext.readKernelState().turn.activeTurnId).toBe(turnId);

    const firstStart = agentBackend.calls.find((c) => c.method === "startTurn");
    if (firstStart?.method !== "startTurn") throw new Error("expected a startTurn call");
    agentBackend.completeRun(firstStart.fence, {
      kind: "completed",
      finalText: "done-1",
      usage: null,
      sessionId: "s1",
    });

    await waitForPublishedCount("turn.gateRejected", 1);
    await waitForPublishedCount("turn.attemptStarted", 2);
    const secondStart = agentBackend.calls.filter((c) => c.method === "startTurn")[1];
    if (secondStart?.method !== "startTurn") throw new Error("expected a second startTurn call");
    agentBackend.completeRun(secondStart.fence, {
      kind: "completed",
      finalText: "done-2",
      usage: null,
      sessionId: "s2",
    });

    const events = await runPromise;
    expect(events).toHaveLength(1);
    const [terminalEvent] = events;
    if (terminalEvent === undefined) throw new Error("expected exactly one terminal event");
    expect(terminalEvent.kind).toBe("turn.completed");
    expect(
      eventPayloadV1SchemaByKind["turn.completed"].safeParse(terminalEvent.payload).success,
    ).toBe(true);
    const terminalPayload = terminalEvent.payload as {
      readonly turnId: string;
      readonly outcome: string;
    };
    expect(terminalPayload.turnId).toBe(turnId);
    expect(terminalPayload.outcome).toBe("completed");

    // §7.2's success arc settles all the way back to idle, and activeTurnId is cleared —
    // never left dangling on a turn that already committed.
    expect(handlerContext.machines.turn.phase()).toBe("idle");
    expect(handlerContext.readKernelState().turn.activeTurnId).toBeNull();
    // The attempt-handle slot is cleared too (Gap 2's producer side, closed by this task).
    expect(handlerContext.turnRunner.activeAttempt(turnId as UUIDv7)).toBeNull();
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
    const [event] = outcome.events;
    if (event === undefined) throw new Error("expected exactly one event");
    expect(eventPayloadV1SchemaByKind["kernel.stateChanged"].safeParse(event.payload).success).toBe(
      true,
    );
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
    const [event] = outcome.events;
    if (event === undefined) throw new Error("expected exactly one event");
    expect(eventPayloadV1SchemaByKind["kernel.stateChanged"].safeParse(event.payload).success).toBe(
      true,
    );
    expect(cancelCalls).toBe(0); // not yet — only inside the launched operation's own run()

    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    expect(operation.label).toBe("kernel.turn.cancel");

    const events = await operation.run();
    expect(events).toEqual([]);
    expect(cancelCalls).toBe(1);
  });

  test("activeAttempt's turnId-mismatch defensive branch: a registered handle is never returned for a turnId other than the one activeTurnId currently names", () => {
    const { handlerContext, setActiveTurnId } = buildTestContext();
    setActiveTurnId(TURN_ID);
    admitTo(handlerContext, ["beginAdmission", "finishAdmission", "beginAttempt"]);

    const fakeHandle: TurnCancelHandle = { requestCancel: async () => {} };
    handlerContext.turnRunner.setActiveAttempt(fakeHandle);

    const OTHER_TURN_ID = uuidv7();
    expect(handlerContext.turnRunner.activeAttempt(OTHER_TURN_ID)).toBeNull();
    // The SAME handle is still reachable under the turnId it was actually registered for —
    // proving the mismatch above is a targeted defensive check, not a general regression.
    expect(handlerContext.turnRunner.activeAttempt(TURN_ID)).toBe(fakeHandle);
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
