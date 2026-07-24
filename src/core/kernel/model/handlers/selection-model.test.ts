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
import type { PublishableEventV1 } from "core/mailbox";
import type { BackendCapabilities, PageSourceV1 } from "core/ports";
import {
  type FakeProjectStore,
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
import { type FailureDtoV1, type UUIDv7, eventPayloadV1SchemaByKind } from "core/protocol";
import { type PageSlug, parsePageSlug } from "entities/page";
import type { Clock } from "infrastructure/clock";

import type { KernelDeps } from "../../types";
import { modelHandlers, selectionHandlers } from "./selection-model";
import type { HandlerContext, PreviewSourceKindV1, ProjectTrustV1 } from "./types";

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const HOME = slug("home");

const FAKE_BACKEND_CAPABILITIES: BackendCapabilities = {
  backendId: "claude",
  models: [
    { model: "sonnet", efforts: ["low", "medium", "high"] },
    { model: "opus", efforts: ["high", "xhigh"] },
  ],
  confinement: "canUseTool",
  sessionWorkspaceBinding: "fixed",
};

interface LaunchedOperation {
  readonly label: string;
  readonly run: () => Promise<readonly PublishableEventV1[]>;
}

interface TestContext {
  readonly handlerContext: HandlerContext;
  readonly projectStore: FakeProjectStore;
  readonly getMutatorCalls: () => number;
  readonly getLaunchedOperations: () => readonly LaunchedOperation[];
}

/**
 * Matches `deferred.test.ts`/`index.test.ts`'s own `buildDeps`/`buildTestContext` shape — a
 * real `HandlerContext` (real machines inside one Reatom frame, real fakes from
 * `core/ports/fakes`) plus a `launchOperation` fake that CAPTURES every call (label + the
 * `run` closure) instead of invoking it, so a test can `await` a specific launched
 * operation's terminal events on its own schedule and assert them against the real protocol
 * schemas — never just count them.
 */
function buildTestContext(options?: {
  readonly pageSources?: ReadonlyMap<PageSlug, PageSourceV1>;
  readonly backends?: readonly ReturnType<typeof createFakeAgentBackend>[];
}): TestContext {
  return context.start(() => {
    let mutatorCalls = 0;
    const launched: LaunchedOperation[] = [];
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

    const chatStore = createFakeChatStore();
    const pageSources = options?.pageSources ?? new Map<PageSlug, PageSourceV1>();
    const pageStore = createFakePageStore({ order: [...pageSources.keys()], sources: pageSources });
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
      agentRegistry: createFakeAgentRegistry(
        options?.backends ?? [createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES })],
      ),
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
      publishOperationEvent: () => {},
      turnRunner: {
        machine: machines.turn,
        setActiveAttempt: () => {},
        activeAttempt: () => null,
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
      projectStore,
      getMutatorCalls: () => mutatorCalls,
      getLaunchedOperations: () => launched,
    };
  });
}

describe('selectionHandlers["selection.clear"]', () => {
  test("unconditionally emits a schema-valid selection.changed(null) as a completed outcome", () => {
    const { handlerContext, getMutatorCalls, getLaunchedOperations } = buildTestContext();

    const outcome = selectionHandlers["selection.clear"]({}, handlerContext);

    expect(outcome).toEqual({
      disposition: "completed",
      events: [{ kind: "selection.changed", payload: null }],
    });
    expect(eventPayloadV1SchemaByKind["selection.changed"].safeParse(null).success).toBe(true);
    // Selection has no machine of its own and no Kernel-held mutator on `HandlerContext` —
    // clearing never touches a machine, a mutator, or `launchOperation`.
    expect(getMutatorCalls()).toBe(0);
    expect(getLaunchedOperations()).toHaveLength(0);
  });
});

describe('selectionHandlers["selection.set"]', () => {
  test("returns a synchronous started outcome and launches exactly one operation", () => {
    const { handlerContext, getLaunchedOperations } = buildTestContext({
      pageSources: new Map([[HOME, { bytes: new Uint8Array(), sourceHash: "a".repeat(64) }]]),
    });

    const outcome = selectionHandlers["selection.set"](
      { pageSlug: HOME, elementId: "el-1" },
      handlerContext,
    );

    expect(outcome).toEqual({ disposition: "started", events: [] });
    expect(getLaunchedOperations()).toHaveLength(1);
    expect(getLaunchedOperations()[0]?.label).toBe("kernel.selection.set");
  });

  test("the launched operation resolves a schema-valid selection.changed once the page source is read", async () => {
    const sourceHash = "b".repeat(64);
    const { handlerContext, getLaunchedOperations } = buildTestContext({
      pageSources: new Map([[HOME, { bytes: new Uint8Array([1, 2, 3]), sourceHash }]]),
    });

    selectionHandlers["selection.set"]({ pageSlug: HOME, elementId: "el-1" }, handlerContext);
    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    const events = await operation.run();

    expect(events).toEqual([
      { kind: "selection.changed", payload: { pageSlug: HOME, elementId: "el-1", sourceHash } },
    ]);
    const [event] = events;
    if (event === undefined) throw new Error("expected exactly one event");
    expect(eventPayloadV1SchemaByKind["selection.changed"].safeParse(event.payload).success).toBe(
      true,
    );
  });

  test("the launched operation resolves to zero events when the page cannot be resolved (no failure event kind exists for selection)", async () => {
    const { handlerContext, getLaunchedOperations } = buildTestContext({ pageSources: new Map() });

    selectionHandlers["selection.set"]({ pageSlug: HOME, elementId: "el-1" }, handlerContext);
    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    const events = await operation.run();

    expect(events).toEqual([]);
  });
});

describe('modelHandlers["model.select"]', () => {
  test("an unknown backendId is a synchronous rejection-shaped no-op — never a throw, never an async launch", () => {
    const { handlerContext, getLaunchedOperations, getMutatorCalls } = buildTestContext();

    const outcome = modelHandlers["model.select"](
      { backend: "unknown", model: "sonnet", effort: "high" },
      handlerContext,
    );

    expect(outcome).toEqual({ disposition: "no-op", events: [] });
    expect(getLaunchedOperations()).toHaveLength(0);
    expect(getMutatorCalls()).toBe(0);
  });

  test("a model the backend does not offer is also a synchronous no-op", () => {
    const { handlerContext, getLaunchedOperations } = buildTestContext();

    const outcome = modelHandlers["model.select"](
      { backend: "claude", model: "haiku", effort: "high" },
      handlerContext,
    );

    expect(outcome).toEqual({ disposition: "no-op", events: [] });
    expect(getLaunchedOperations()).toHaveLength(0);
  });

  test("an effort the chosen model does not offer is also a synchronous no-op", () => {
    const { handlerContext, getLaunchedOperations } = buildTestContext();

    // "low" is valid for sonnet but not for opus (matches core/chats/model/model-select.test.ts).
    const outcome = modelHandlers["model.select"](
      { backend: "claude", model: "opus", effort: "low" },
      handlerContext,
    );

    expect(outcome).toEqual({ disposition: "no-op", events: [] });
    expect(getLaunchedOperations()).toHaveLength(0);
  });

  test("a valid triple returns a synchronous started outcome and launches exactly one operation", () => {
    const { handlerContext, getLaunchedOperations } = buildTestContext();

    const outcome = modelHandlers["model.select"](
      { backend: "claude", model: "sonnet", effort: "medium" },
      handlerContext,
    );

    expect(outcome).toEqual({ disposition: "started", events: [] });
    expect(getLaunchedOperations()).toHaveLength(1);
    expect(getLaunchedOperations()[0]?.label).toBe("kernel.model.select");
  });

  test("the launched operation persists the validated triple through ProjectStore.writeWorkspaceState", async () => {
    const { handlerContext, projectStore, getLaunchedOperations } = buildTestContext();

    modelHandlers["model.select"](
      { backend: "claude", model: "sonnet", effort: "medium" },
      handlerContext,
    );
    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    const events = await operation.run();

    // No EventKindV1 member exists for a model-selection change (verified against the closed
    // 43-kind `EventPayloadByKindV1` map) — the persisted fact is only observable through
    // `ProjectStore.readWorkspaceState`, never through a published event.
    expect(events).toEqual([]);
    const workspace = await projectStore.readWorkspaceState();
    if ("code" in workspace) throw workspace;
    expect(workspace.state.backend).toBe("claude");
    expect(workspace.state.model).toBe("sonnet");
    expect(workspace.state.effort).toBe("medium");
  });

  test("the launched operation resolves to zero events when the workspace-state write fails", async () => {
    const { handlerContext, projectStore, getLaunchedOperations } = buildTestContext();
    const FAILURE: FailureDtoV1 = {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: "disk unavailable",
      details: {},
    };
    projectStore.failNext("writeWorkspaceState", FAILURE);

    modelHandlers["model.select"](
      { backend: "claude", model: "sonnet", effort: "medium" },
      handlerContext,
    );
    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    const events = await operation.run();

    expect(events).toEqual([]);
  });
});
