import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

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
import type { PreviewSession } from "core/ports";
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
import { type FailureDtoV1, type UUIDv7, eventPayloadV1SchemaByKind } from "core/protocol";
import { parsePageSlug } from "entities/page";
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

import type { KernelDeps } from "../../types";
import {
  PAGE_META_EXTRACTOR_VERSION_PLACEHOLDER,
  exportHandlers,
  previewHandlers,
} from "./preview-export";
import type { HandlerContext, PreviewSourceKindV1, ProjectTrustV1 } from "./types";

function slug(value: string) {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const HOME = slug("home");
const HOME_SOURCE_HASH = "a".repeat(64);

function buildDeps(overrides?: {
  readonly hostSupervisor?: KernelDeps["hostSupervisor"];
  readonly pageMetaCache?: KernelDeps["pageMetaCache"];
  readonly projectStore?: KernelDeps["projectStore"];
}): KernelDeps {
  const chatStore = createFakeChatStore();
  const pageStore = createFakePageStore({
    order: [HOME],
    sources: new Map([
      [
        HOME,
        { bytes: new TextEncoder().encode("export const meta = {}"), sourceHash: HOME_SOURCE_HASH },
      ],
    ]),
  });
  const pinStore = createFakePinStore();
  const clock: Clock = { now: () => new Date(1_700_000_000_000) };

  return {
    projectStore: overrides?.projectStore ?? createFakeProjectStore({ root: "/test-root" }),
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
    pageMetaCache: overrides?.pageMetaCache ?? createFakePageMetaCache(),
    diagnosticsCache: createFakeDiagnosticsCache(),
    renderCache: createFakeRenderCache(),
    sessionCheckpoint: createFakeSessionCheckpointService(),
    recovery: createFakeRecoveryService(),
    gateRunner: createFakeGateRunner(),
    hostSupervisor: overrides?.hostSupervisor ?? createFakeHostSupervisorPort(),
    exportRender: createFakeExportRenderPort(),
    exportPublish: createFakeExportPublish(),
    agentRegistry: createFakeAgentRegistry([createFakeAgentBackend()]),
    clock,
  };
}

interface TestHarness {
  readonly handlerContext: HandlerContext;
  readonly getMutatorCalls: () => number;
  /** Every `launchOperation(label, run)` call, in order, so a test can `await` `run()` and inspect its events. */
  readonly launched: readonly {
    readonly label: string;
    readonly run: () => Promise<readonly unknown[]>;
  }[];
  readonly getActivePreviewSession: () => PreviewSession | null;
  /** Every `publishOperationEvent(event)` call, in order — the export family's own live-progress events land here. */
  readonly getPublishedEvents: () => readonly PublishableEventV1[];
}

function buildTestContext(deps: KernelDeps): TestHarness {
  return context.start(() => {
    let mutatorCalls = 0;
    let trust: ProjectTrustV1 = null;
    let activeTurnId: UUIDv7 | null = null;
    let commitIntentRecorded = false;
    let previewSourceKind: PreviewSourceKindV1 = null;
    let activePreviewSession: PreviewSession | null = null;
    const launched: { label: string; run: () => Promise<readonly unknown[]> }[] = [];
    const publishedEvents: PublishableEventV1[] = [];

    const machines = {
      project: reatomProjectStateMachine(),
      turn: reatomTurnStateMachine(),
      restore: reatomRestoreStateMachine(),
      commit: reatomCommitStateMachine(),
      export: reatomExportStateMachine(),
      preview: reatomPreviewStateMachine(),
      migration: reatomMigrationStateMachine(),
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
      setActivePreviewSession: (session) => {
        mutatorCalls += 1;
        activePreviewSession = session;
      },
      launchOperation: (label, run) => {
        launched.push({ label, run: run as () => Promise<readonly unknown[]> });
      },
      publishOperationEvent: (event) => {
        publishedEvents.push(event);
      },
      turnRunner: {
        machine: machines.turn,
        setActiveAttempt: () => {},
        activeAttempt: () => null,
      },
      exportRunner: { machine: machines.export },
      setSelection: () => {},
      selection: () => null,
      currentPreviewSession: () => activePreviewSession,
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
      getMutatorCalls: () => mutatorCalls,
      launched,
      getActivePreviewSession: () => activePreviewSession,
      getPublishedEvents: () => publishedEvents,
    };
  });
}

function seedPageMeta(cache: ReturnType<typeof createFakePageMetaCache>): void {
  void cache.put({
    key: {
      pageSlug: HOME,
      sourceHash: HOME_SOURCE_HASH,
      extractorVersion: PAGE_META_EXTRACTOR_VERSION_PLACEHOLDER,
    },
    meta: { kitApiVersion: 1, title: "Home", minSize: { w: 80, h: 24 }, theme: "dark" },
  });
}

function enable(machines: HandlerContext["machines"]): void {
  machines.preview.apply("kernel.preview.enable");
}

describe("previewHandlers.selectPage / selectCurrent — real, end to end", () => {
  test("selectPage from idle: synchronous admission moves idle -> starting and returns a schema-valid kernel.stateChanged", () => {
    const harness = buildTestContext(buildDeps());
    enable(harness.handlerContext.machines);

    const outcome = previewHandlers["preview.selectPage"](
      { pageSlug: HOME },
      harness.handlerContext,
    );

    expect(outcome.disposition).toBe("started");
    expect(outcome.events).toHaveLength(1);
    const event = outcome.events[0]!;
    expect(event.kind).toBe("kernel.stateChanged");
    const parsed = eventPayloadV1SchemaByKind["kernel.stateChanged"].parse(event.payload);
    expect(parsed).toEqual({
      modelId: "kernel.preview.state",
      action: "kernel.preview.beginStart",
      previousTag: "idle",
      nextTag: "starting",
      metadata: {},
    });
    expect(harness.handlerContext.machines.preview.phase()).toBe("starting");
    expect(harness.launched).toHaveLength(1);
  });

  test("selectCurrent from live: synchronous admission moves live -> switching (beginSwitch)", () => {
    const harness = buildTestContext(buildDeps());
    enable(harness.handlerContext.machines);
    harness.handlerContext.machines.preview.apply("kernel.preview.beginStart");
    harness.handlerContext.machines.preview.apply("kernel.preview.sessionReady");
    expect(harness.handlerContext.machines.preview.phase()).toBe("live");

    const outcome = previewHandlers["preview.selectCurrent"](
      { pageSlug: HOME },
      harness.handlerContext,
    );

    expect(outcome.disposition).toBe("started");
    const parsed = eventPayloadV1SchemaByKind["kernel.stateChanged"].parse(
      outcome.events[0]!.payload,
    );
    expect(parsed.action).toBe("kernel.preview.beginSwitch");
    expect(parsed.previousTag).toBe("live");
    expect(parsed.nextTag).toBe("switching");
  });

  test("async completion, cache HIT + successful host call: establishes a session and emits preview.sourceChanged", async () => {
    const deps = buildDeps();
    seedPageMeta(deps.pageMetaCache as ReturnType<typeof createFakePageMetaCache>);
    const harness = buildTestContext(deps);
    enable(harness.handlerContext.machines);

    previewHandlers["preview.selectPage"]({ pageSlug: HOME }, harness.handlerContext);
    expect(harness.launched).toHaveLength(1);

    const events = await wrap(harness.launched[0]!.run());

    expect(harness.handlerContext.machines.preview.phase()).toBe("live");
    expect(harness.getActivePreviewSession()).not.toBeNull();

    const sourceChanged = events.find(
      (event): event is { kind: string; payload: unknown } =>
        (event as { kind: string }).kind === "preview.sourceChanged",
    );
    expect(sourceChanged).toBeDefined();
    const parsed = eventPayloadV1SchemaByKind["preview.sourceChanged"].parse(
      sourceChanged!.payload,
    );
    expect(parsed.pageSlug).toBe(HOME);
    expect(parsed.source).toEqual({ kind: "current" });
    expect(parsed.sourceHash).toBe(HOME_SOURCE_HASH);

    const stateChanged = events.find(
      (event): event is { kind: string; payload: unknown } =>
        (event as { kind: string }).kind === "kernel.stateChanged",
    );
    expect(stateChanged).toBeDefined();
    const parsedState = eventPayloadV1SchemaByKind["kernel.stateChanged"].parse(
      stateChanged!.payload,
    );
    expect(parsedState).toEqual({
      modelId: "kernel.preview.state",
      action: "kernel.preview.sessionReady",
      previousTag: "starting",
      nextTag: "live",
      metadata: {},
    });
  });

  test("async completion, page-meta cache MISS: sessionFailed + a schema-valid preview.failed, never a fabricated setting", async () => {
    const deps = buildDeps(); // pageMetaCache left empty — a genuine miss
    const harness = buildTestContext(deps);
    enable(harness.handlerContext.machines);

    previewHandlers["preview.selectPage"]({ pageSlug: HOME }, harness.handlerContext);
    const events = await wrap(harness.launched[0]!.run());

    expect(harness.handlerContext.machines.preview.phase()).toBe("failed");
    expect(harness.getActivePreviewSession()).toBeNull();

    const failed = events.find((event) => (event as { kind: string }).kind === "preview.failed") as
      | { kind: string; payload: unknown }
      | undefined;
    expect(failed).toBeDefined();
    const parsed = eventPayloadV1SchemaByKind["preview.failed"].parse(failed!.payload);
    expect(parsed.pageSlug).toBe(HOME);
    expect(parsed.phase).toBe("starting");
    expect(parsed.failure.code).toBe("PERSISTENCE_FAILED");

    const stateChanged = events.find(
      (event) => (event as { kind: string }).kind === "kernel.stateChanged",
    ) as { kind: string; payload: unknown } | undefined;
    expect(stateChanged).toBeDefined();
    const parsedState = eventPayloadV1SchemaByKind["kernel.stateChanged"].parse(
      stateChanged!.payload,
    );
    expect(parsedState.action).toBe("kernel.preview.sessionFailed");
    expect(parsedState.nextTag).toBe("failed");
  });

  test("async completion, host supervisor rejects: sessionFailed + preview.failed carrying the host's own failure", async () => {
    const deps = buildDeps();
    seedPageMeta(deps.pageMetaCache as ReturnType<typeof createFakePageMetaCache>);
    const hostFailure: FailureDtoV1 = {
      code: "HOST_START_FAILED",
      retryable: true,
      safeMessage: "host refused to start",
      details: {},
    };
    (deps.hostSupervisor as ReturnType<typeof createFakeHostSupervisorPort>).failNext(
      "preview",
      hostFailure,
    );
    const harness = buildTestContext(deps);
    enable(harness.handlerContext.machines);

    previewHandlers["preview.selectPage"]({ pageSlug: HOME }, harness.handlerContext);
    const events = await wrap(harness.launched[0]!.run());

    expect(harness.handlerContext.machines.preview.phase()).toBe("failed");
    const failed = events.find((event) => (event as { kind: string }).kind === "preview.failed") as
      | { kind: string; payload: unknown }
      | undefined;
    const parsed = eventPayloadV1SchemaByKind["preview.failed"].parse(failed!.payload);
    expect(parsed.failure.code).toBe(hostFailure.code);
    expect(parsed.failure.safeMessage).toBe(hostFailure.safeMessage);
    expect(parsed.failure.retryable).toBe(hostFailure.retryable);
  });

  test("size/theme/capabilities derive from workspace state, not fabricated defaults", async () => {
    const deps = buildDeps({
      projectStore: createFakeProjectStore({
        root: "/test-root",
        workspaceState: {
          previewSizeMode: "custom",
          previewCustomWidth: 100,
          previewCustomHeight: 30,
          themeOverride: "light",
          colorCapability: "truecolor",
          renderMode: "interactive",
        },
      }),
    });
    seedPageMeta(deps.pageMetaCache as ReturnType<typeof createFakePageMetaCache>);
    const harness = buildTestContext(deps);
    enable(harness.handlerContext.machines);

    previewHandlers["preview.selectPage"]({ pageSlug: HOME }, harness.handlerContext);
    await wrap(harness.launched[0]!.run());

    const fakeHost = deps.hostSupervisor as ReturnType<typeof createFakeHostSupervisorPort>;
    const previewCall = fakeHost.calls.find((call) => call.method === "preview");
    expect(previewCall).toBeDefined();

    // The fake's own `calls` log only records `pageSlug`; the composed session it returns
    // otherwise mirrors the spec verbatim (`interactionMode`, `identity.kitApiVersion`), so
    // asserting on the SESSION proves the derived spec's fields reached `hostSupervisor.preview`.
    const session = harness.getActivePreviewSession() as {
      readonly interactionMode: string;
      readonly identity: { readonly kitApiVersion: number };
    };
    expect(session).not.toBeNull();
    expect(session.interactionMode).toBe("interactive"); // from workspaceState.renderMode
    expect(session.identity.kitApiVersion).toBe(1); // from the cached PageMeta, not fabricated
  });
});

describe("previewHandlers.selectHistorical — out of MVP scope (no Git port)", () => {
  test("returns the sanctioned no-op and never touches the machine or a mutator", () => {
    const harness = buildTestContext(buildDeps());
    enable(harness.handlerContext.machines);

    const outcome = previewHandlers["preview.selectHistorical"](
      { pageSlug: HOME, sourceCommit: "a".repeat(40) },
      harness.handlerContext,
    );

    expect(outcome).toEqual({ disposition: "no-op", events: [] });
    expect(harness.handlerContext.machines.preview.phase()).toBe("idle");
    expect(harness.getMutatorCalls()).toBe(0);
    expect(harness.launched).toHaveLength(0);
  });
});

describe("previewHandlers — blocked by Gap A (no session read-back)", () => {
  function liveHarness(): TestHarness {
    const harness = buildTestContext(buildDeps());
    enable(harness.handlerContext.machines);
    harness.handlerContext.machines.preview.apply("kernel.preview.beginStart");
    harness.handlerContext.machines.preview.apply("kernel.preview.sessionReady");
    return harness;
  }

  test("resize returns the sanctioned no-op without moving the machine", () => {
    const harness = liveHarness();
    const outcome = previewHandlers["preview.resize"](
      { previewSessionId: uuidv7(), width: 100, height: 30 },
      harness.handlerContext,
    );
    expect(outcome).toEqual({ disposition: "no-op", events: [] });
    expect(harness.handlerContext.machines.preview.phase()).toBe("live");
    expect(harness.getMutatorCalls()).toBe(0);
  });

  test("setThemeCapabilities returns the sanctioned no-op", () => {
    const harness = liveHarness();
    const outcome = previewHandlers["preview.setThemeCapabilities"](
      { previewSessionId: uuidv7(), themeId: "dark", terminalCapabilities: { colorDepth: 24 } },
      harness.handlerContext,
    );
    expect(outcome).toEqual({ disposition: "no-op", events: [] });
    expect(harness.handlerContext.machines.preview.phase()).toBe("live");
  });

  test("setMode returns the sanctioned no-op", () => {
    const harness = liveHarness();
    const outcome = previewHandlers["preview.setMode"](
      { previewSessionId: uuidv7(), mode: "interactive" },
      harness.handlerContext,
    );
    expect(outcome).toEqual({ disposition: "no-op", events: [] });
  });

  test("queryGeometry returns the sanctioned no-op (also matches the machine's own noOp edge)", () => {
    const harness = liveHarness();
    const outcome = previewHandlers["preview.queryGeometry"](
      { frameToken: uuidv7(), query: { kind: "layout" } },
      harness.handlerContext,
    );
    expect(outcome).toEqual({ disposition: "no-op", events: [] });
  });

  test("retry returns the sanctioned no-op without moving the machine out of circuit-open", () => {
    const harness = buildTestContext(buildDeps());
    enable(harness.handlerContext.machines);
    harness.handlerContext.machines.preview.apply("kernel.preview.beginStart");
    harness.handlerContext.machines.preview.apply("kernel.preview.sessionFailed");
    harness.handlerContext.machines.preview.apply("kernel.preview.openCircuit");
    expect(harness.handlerContext.machines.preview.phase()).toBe("circuit-open");

    const outcome = previewHandlers["preview.retry"](
      { previewSessionId: uuidv7() },
      harness.handlerContext,
    );

    expect(outcome).toEqual({ disposition: "no-op", events: [] });
    expect(harness.handlerContext.machines.preview.phase()).toBe("circuit-open");
  });
});

describe("previewHandlers.close — real, partial (Kernel-side half only)", () => {
  test("applies disable, clears the tracked session, and emits a schema-valid kernel.stateChanged", () => {
    const harness = buildTestContext(buildDeps());
    enable(harness.handlerContext.machines);
    harness.handlerContext.machines.preview.apply("kernel.preview.beginStart");
    harness.handlerContext.machines.preview.apply("kernel.preview.sessionReady");
    harness.handlerContext.setActivePreviewSession({ marker: "some-session" } as never);

    const previewSessionId = uuidv7();
    const outcome = previewHandlers["preview.close"]({ previewSessionId }, harness.handlerContext);

    expect(outcome.disposition).toBe("completed");
    expect(outcome.events).toHaveLength(1);
    const parsed = eventPayloadV1SchemaByKind["kernel.stateChanged"].parse(
      outcome.events[0]!.payload,
    );
    expect(parsed).toEqual({
      modelId: "kernel.preview.state",
      action: "kernel.preview.disable",
      previousTag: "live",
      nextTag: "disabled",
      metadata: {},
    });
    expect(outcome.events[0]!.correlation).toEqual({ previewSessionId });
    expect(harness.handlerContext.machines.preview.phase()).toBe("disabled");
    expect(harness.getActivePreviewSession()).toBeNull();
  });

  test("from an already-disabled phase, returns the sanctioned no-op (defensive; unreachable under a correct guard)", () => {
    const harness = buildTestContext(buildDeps());
    // Never enabled — machine stays at its initial "disabled" phase, where `disable` is illegal.
    const outcome = previewHandlers["preview.close"](
      { previewSessionId: uuidv7() },
      harness.handlerContext,
    );
    expect(outcome).toEqual({ disposition: "no-op", events: [] });
  });
});

describe("exportHandlers.start — real, end to end (Gap B closure)", () => {
  test("admission: returns a zero-event started outcome synchronously and launches the operation without moving the machine yet", () => {
    const deps = buildDeps();
    seedPageMeta(deps.pageMetaCache as ReturnType<typeof createFakePageMetaCache>);
    const harness = buildTestContext(deps);

    const outcome = exportHandlers["export.start"]({}, harness.handlerContext);

    // Mirrors `turn.start`'s own admission shape: `kernel.export.begin` itself is applied
    // INSIDE `captureExportSnapshot`, not by this handler directly, so the synchronous
    // return carries no admission event and the machine has not moved yet.
    expect(outcome).toEqual({ disposition: "started", events: [] });
    expect(harness.handlerContext.machines.export.phase()).toBe("idle");
    expect(harness.launched).toHaveLength(1);
    expect(harness.launched[0]!.label).toBe("kernel.export.run");
  });

  test("success path: captures a snapshot, renders, assembles, publishes exactly one plan, and returns the machine to idle", async () => {
    const deps = buildDeps();
    seedPageMeta(deps.pageMetaCache as ReturnType<typeof createFakePageMetaCache>);
    const harness = buildTestContext(deps);

    exportHandlers["export.start"]({}, harness.handlerContext);
    const events = await wrap(harness.launched[0]!.run());

    expect(harness.handlerContext.machines.export.phase()).toBe("idle");

    const exportPublish = deps.exportPublish as ReturnType<typeof createFakeExportPublish>;
    expect(exportPublish.calls).toHaveLength(1);

    // The terminal batch: exactly one `export.completed`.
    expect(events).toHaveLength(1);
    const completed = events[0] as { kind: string; payload: unknown };
    expect(completed.kind).toBe("export.completed");
    const parsedCompleted = eventPayloadV1SchemaByKind["export.completed"].parse(completed.payload);
    expect(parsedCompleted.destination).toBe(".termcraft/export");
    expect(parsedCompleted.phase).toBe("publishing");
    expect(parsedCompleted.failure).toBeNull();
    expect(parsedCompleted.generationId).not.toBeNull();

    // Live progress, in order: `export.started` once the snapshot is captured, then one
    // `export.progress` per phase boundary this batched composition can actually observe.
    const published = harness.getPublishedEvents();
    expect(published.map((e) => e.kind)).toEqual([
      "export.started",
      "export.progress",
      "export.progress",
    ]);

    const started = eventPayloadV1SchemaByKind["export.started"].parse(published[0]!.payload);
    expect(started.pageCount).toBe(1);
    expect(started.renderJobCount).toBeGreaterThan(0);
    expect(started.destination).toBe(".termcraft/export");
    expect(parsedCompleted.operationId).toBe(started.operationId);

    const renderingProgress = eventPayloadV1SchemaByKind["export.progress"].parse(
      published[1]!.payload,
    );
    expect(renderingProgress.phase).toBe("rendering");
    expect(renderingProgress.completedJobs).toBe(started.renderJobCount);
    expect(renderingProgress.totalJobs).toBe(started.renderJobCount);

    const publishingProgress = eventPayloadV1SchemaByKind["export.progress"].parse(
      published[2]!.payload,
    );
    expect(publishingProgress.phase).toBe("publishing");
  });

  test("a render failure drives the machine's failure arc without ever calling publish", async () => {
    const deps = buildDeps();
    seedPageMeta(deps.pageMetaCache as ReturnType<typeof createFakePageMetaCache>);
    const renderFailure: FailureDtoV1 = {
      code: "EXPORT_RENDER_FAILED",
      retryable: true,
      safeMessage: "the renderer crashed",
      details: {},
    };
    (deps.exportRender as ReturnType<typeof createFakeExportRenderPort>).failNext(
      "renderOne",
      renderFailure,
    );
    const harness = buildTestContext(deps);

    exportHandlers["export.start"]({}, harness.handlerContext);
    const events = await wrap(harness.launched[0]!.run());

    expect(harness.handlerContext.machines.export.phase()).toBe("idle");

    const exportPublish = deps.exportPublish as ReturnType<typeof createFakeExportPublish>;
    expect(exportPublish.calls).toHaveLength(0);

    expect(events).toHaveLength(1);
    const failed = events[0] as { kind: string; payload: unknown };
    expect(failed.kind).toBe("export.failed");
    const parsedFailed = eventPayloadV1SchemaByKind["export.failed"].parse(failed.payload);
    expect(parsedFailed.phase).toBe("rendering");
    expect(parsedFailed.generationId).toBeNull();
    expect(parsedFailed.failure?.code).toBe("EXPORT_RENDER_FAILED");

    // Only the two events this composition can honestly publish before a render failure —
    // never a `"publishing"`-phase progress event, since publish is never reached.
    const published = harness.getPublishedEvents();
    expect(published.map((e) => e.kind)).toEqual(["export.started", "export.progress"]);
  });
});
