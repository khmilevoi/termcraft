import { describe, expect, spyOn, test } from "bun:test";

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
import {
  type FakePageStore,
  type FakePinStore,
  type FakeProjectStore,
  type FakeProjectWriteCoordinator,
  createFakeAgentBackend,
  createFakeAgentPromptSource,
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
import type { PinEvent } from "entities/pin";
import type { Clock } from "infrastructure/clock";

import type { KernelDeps } from "../../types";
import { pageHandlers, pinHandlers } from "./page-pin";
import type { HandlerContext, PreviewSourceKindV1, ProjectTrustV1 } from "./types";

/**
 * `page-pin.ts`'s own test suite (kernel-assembly WP-1 task 9, Step C2 — the `page`+`pin`
 * family). Test harness mirrors `chat.test.ts`/`selection-model.test.ts`'s own
 * `buildTestContext` shape exactly (a real `HandlerContext` over the shared `core/ports/
 * fakes` set, `launchOperation` recording rather than invoking, so a test drives its
 * launched operation's `run()` by hand).
 */

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

function clockAt(iso: string): Clock {
  return { now: () => new Date(iso) };
}

const NOW = "2024-06-01T12:00:00.000Z";

const FAILURE: FailureDtoV1 = {
  code: "PERSISTENCE_FAILED",
  retryable: false,
  safeMessage: "disk unavailable",
  details: {},
};

interface LaunchedOperation {
  readonly label: string;
  readonly run: () => Promise<readonly PublishableEventV1[]>;
}

interface TestFixture {
  readonly handlerContext: HandlerContext;
  readonly pageStore: FakePageStore;
  readonly pinStore: FakePinStore;
  readonly projectStore: FakeProjectStore;
  readonly mutex: FakeProjectWriteCoordinator;
  readonly getMutatorCalls: () => number;
  readonly getLaunches: () => readonly LaunchedOperation[];
}

function buildTestContext(options?: {
  readonly pageOrder?: readonly PageSlug[];
  readonly pageSources?: ReadonlyMap<
    PageSlug,
    { readonly bytes: Uint8Array; readonly sourceHash: string }
  >;
  readonly workspaceActivePageSlug?: PageSlug | null;
}): TestFixture {
  return context.start(() => {
    const clock = clockAt(NOW);
    const pageStore = createFakePageStore({
      order: options?.pageOrder ?? [],
      sources: options?.pageSources,
    });
    const pinStore = createFakePinStore();
    const projectStore = createFakeProjectStore({
      root: "/test-root",
      workspaceState: { activePageSlug: options?.workspaceActivePageSlug ?? null },
    });
    const mutex = createFakeProjectWriteCoordinator();
    const chatStore = createFakeChatStore({ clock });

    const deps: KernelDeps = {
      projectStore,
      chatReader: chatStore,
      chatMutations: chatStore,
      pageReader: pageStore,
      pageMutations: pageStore,
      pinReader: pinStore,
      pinMutations: pinStore,
      turnTransactions: createFakeTurnTransactionService(),
      projectWrite: mutex,
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
      agentPromptSource: createFakeAgentPromptSource(),
      clock,
    };

    let mutatorCalls = 0;
    let trust: ProjectTrustV1 = null;
    let activeTurnId: UUIDv7 | null = null;
    let commitIntentRecorded = false;
    let previewSourceKind: PreviewSourceKindV1 = null;
    const launches: LaunchedOperation[] = [];

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
    const geometryTokenLedger = createGeometryTokenLedger({ clock });

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
        launches.push({ label, run });
      },
      publishOperationEvent: () => {},
      turnRunner: {
        machine: machines.turn,
        setActiveAttempt: () => {},
        activeAttempt: () => null,
      },
      exportRunner: { machine: machines.export },
      setSelection: () => {},
      selection: () => null,
      currentPreviewSession: () => null,
      currentPageDescriptors: () => [],
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
      pageStore,
      pinStore,
      projectStore,
      mutex,
      getMutatorCalls: () => mutatorCalls,
      getLaunches: () => launches,
    };
  });
}

function onlyLaunch(launches: readonly LaunchedOperation[]): LaunchedOperation {
  expect(launches).toHaveLength(1);
  const [launch] = launches;
  if (launch === undefined) throw new Error("expected exactly one launched operation");
  return launch;
}

function onlyEvent(events: readonly PublishableEventV1[]): PublishableEventV1 {
  expect(events).toHaveLength(1);
  const [event] = events;
  if (event === undefined) throw new Error("expected exactly one published event");
  return event;
}

// ---------------------------------------------------------------------------
// page.renameTitle
// ---------------------------------------------------------------------------

describe("pageHandlers['page.renameTitle']", () => {
  test("returns a synchronous started outcome with no admission events, launches exactly one operation, and never touches a Kernel-held mutator", () => {
    const { handlerContext, getLaunches, getMutatorCalls } = buildTestContext({
      pageOrder: [slug("home")],
    });

    const outcome = pageHandlers["page.renameTitle"](
      { pageSlug: slug("home"), title: "New title" },
      handlerContext,
    );

    expect(outcome).toEqual({ disposition: "started", events: [] });
    expect(getLaunches()).toHaveLength(1);
    expect(getMutatorCalls()).toBe(0);
  });

  test("its launched operation rewrites the title through PageMutations and invalidates any active remove plan, resolving with no events", async () => {
    const { handlerContext, pageStore, getLaunches } = buildTestContext({
      pageOrder: [slug("home")],
      pageSources: new Map([
        [slug("home"), { bytes: new Uint8Array(), sourceHash: "a".repeat(64) }],
      ]),
    });
    const plan = handlerContext.pageRemovePlanLedger.mint({
      pageSlug: slug("home"),
      sourceHash: "a".repeat(64),
      orderedPageSlugs: [slug("home")],
      activePageSlug: slug("home"),
    });
    if (plan instanceof Error) throw plan;

    pageHandlers["page.renameTitle"](
      { pageSlug: slug("home"), title: "New title" },
      handlerContext,
    );
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    expect(events).toEqual([]);
    expect(pageStore.calls).toEqual([
      { method: "renameTitle", pageSlug: slug("home"), title: "New title" },
    ]);
    expect(handlerContext.pageRemovePlanLedger.current()).toBeNull();
  });

  test("when PageMutations.renameTitle fails, its launched operation logs the failure and resolves with no events", async () => {
    const { handlerContext, pageStore, getLaunches } = buildTestContext({
      pageOrder: [slug("home")],
    });
    pageStore.failNext("renameTitle", FAILURE);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    pageHandlers["page.renameTitle"](
      { pageSlug: slug("home"), title: "New title" },
      handlerContext,
    );
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    expect(events).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// page.reorder
// ---------------------------------------------------------------------------

describe("pageHandlers['page.reorder']", () => {
  test("returns a synchronous started outcome with no admission events and launches exactly one operation", () => {
    const { handlerContext, getLaunches } = buildTestContext({
      pageOrder: [slug("home"), slug("about")],
    });

    const outcome = pageHandlers["page.reorder"](
      { pageSlugs: [slug("about"), slug("home")] },
      handlerContext,
    );

    expect(outcome).toEqual({ disposition: "started", events: [] });
    expect(getLaunches()).toHaveLength(1);
  });

  test("its launched operation replaces the page order and invalidates any active remove plan, resolving with no events", async () => {
    const { handlerContext, pageStore, getLaunches } = buildTestContext({
      pageOrder: [slug("home"), slug("about")],
    });
    const plan = handlerContext.pageRemovePlanLedger.mint({
      pageSlug: slug("home"),
      sourceHash: "a".repeat(64),
      orderedPageSlugs: [slug("home"), slug("about")],
      activePageSlug: slug("home"),
    });
    if (plan instanceof Error) throw plan;

    pageHandlers["page.reorder"]({ pageSlugs: [slug("about"), slug("home")] }, handlerContext);
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    expect(events).toEqual([]);
    const listed = await pageStore.listSlugs();
    expect(listed).toEqual([slug("about"), slug("home")]);
    expect(handlerContext.pageRemovePlanLedger.current()).toBeNull();
  });

  test("an invalid permutation logs a warning, performs no write, and still resolves with no events", async () => {
    const { handlerContext, pageStore, getLaunches } = buildTestContext({
      pageOrder: [slug("home"), slug("about")],
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    pageHandlers["page.reorder"]({ pageSlugs: [slug("home")] }, handlerContext);
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    expect(events).toEqual([]);
    expect(pageStore.calls.some((c) => c.method === "reorder")).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// page.removePlan
// ---------------------------------------------------------------------------

describe("pageHandlers['page.removePlan']", () => {
  test("returns a synchronous started outcome with no admission events and launches exactly one operation", () => {
    const { handlerContext, getLaunches } = buildTestContext({ pageOrder: [slug("home")] });

    const outcome = pageHandlers["page.removePlan"]({ pageSlug: slug("home") }, handlerContext);

    expect(outcome).toEqual({ disposition: "started", events: [] });
    expect(getLaunches()).toHaveLength(1);
  });

  test("its launched operation gathers fresh facts, mints a plan through the Kernel ledger, and publishes a page.removePlanReady event that parses against eventPayloadV1SchemaByKind", async () => {
    const { handlerContext, getLaunches } = buildTestContext({
      pageOrder: [slug("home"), slug("about")],
      pageSources: new Map([
        [slug("home"), { bytes: new Uint8Array(), sourceHash: "a".repeat(64) }],
      ]),
      workspaceActivePageSlug: slug("home"),
    });

    pageHandlers["page.removePlan"]({ pageSlug: slug("home") }, handlerContext);
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    const event = onlyEvent(events);
    expect(event.kind).toBe("page.removePlanReady");
    const parsed = eventPayloadV1SchemaByKind["page.removePlanReady"].safeParse(event.payload);
    expect(parsed.success).toBe(true);
    expect((event.payload as { pageSlug: string }).pageSlug).toBe(slug("home"));
    expect(handlerContext.pageRemovePlanLedger.current()).not.toBeNull();
  });

  test("when reading the page source fails, its launched operation logs the failure and resolves with no events, minting no plan", async () => {
    const { handlerContext, pageStore, getLaunches } = buildTestContext({
      pageOrder: [slug("home")],
    });
    pageStore.failNext("readSource", FAILURE);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    pageHandlers["page.removePlan"]({ pageSlug: slug("home") }, handlerContext);
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    expect(events).toEqual([]);
    expect(handlerContext.pageRemovePlanLedger.current()).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("when reading workspace state fails, its launched operation logs the failure and mints no plan", async () => {
    const { handlerContext, projectStore, getLaunches } = buildTestContext({
      pageOrder: [slug("home")],
      pageSources: new Map([
        [slug("home"), { bytes: new Uint8Array(), sourceHash: "a".repeat(64) }],
      ]),
    });
    projectStore.failNext("readWorkspaceState", FAILURE);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    pageHandlers["page.removePlan"]({ pageSlug: slug("home") }, handlerContext);
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    expect(events).toEqual([]);
    expect(handlerContext.pageRemovePlanLedger.current()).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// page.removeDiscardPlan
// ---------------------------------------------------------------------------

describe("pageHandlers['page.removeDiscardPlan']", () => {
  test("discards the matching plan synchronously (no launched operation) and returns a completed outcome", () => {
    const { handlerContext, getLaunches } = buildTestContext({ pageOrder: [slug("home")] });
    const plan = handlerContext.pageRemovePlanLedger.mint({
      pageSlug: slug("home"),
      sourceHash: "a".repeat(64),
      orderedPageSlugs: [slug("home")],
      activePageSlug: slug("home"),
    });
    if (plan instanceof Error) throw plan;

    const outcome = pageHandlers["page.removeDiscardPlan"](
      { pageRemovePlanId: plan.pageRemovePlanId },
      handlerContext,
    );

    expect(outcome).toEqual({ disposition: "completed", events: [] });
    expect(handlerContext.pageRemovePlanLedger.current()).toBeNull();
    expect(getLaunches()).toHaveLength(0);
  });

  test("returns a no-op outcome, synchronously, for a non-matching plan id", () => {
    const { handlerContext, getLaunches } = buildTestContext();

    const outcome = pageHandlers["page.removeDiscardPlan"](
      { pageRemovePlanId: "0192f6f0-0000-7000-8000-000000000099" },
      handlerContext,
    );

    expect(outcome).toEqual({ disposition: "no-op", events: [] });
    expect(getLaunches()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// page.removeConfirm
// ---------------------------------------------------------------------------

describe("pageHandlers['page.removeConfirm']", () => {
  function setupConfirmScenario() {
    const { handlerContext, pageStore, projectStore, mutex, getLaunches } = buildTestContext({
      pageOrder: [slug("home"), slug("about")],
      pageSources: new Map([
        [slug("home"), { bytes: new Uint8Array(), sourceHash: "a".repeat(64) }],
        [slug("about"), { bytes: new Uint8Array(), sourceHash: "b".repeat(64) }],
      ]),
      workspaceActivePageSlug: slug("about"),
    });
    const plan = handlerContext.pageRemovePlanLedger.mint({
      pageSlug: slug("about"),
      sourceHash: "b".repeat(64),
      orderedPageSlugs: [slug("home"), slug("about")],
      activePageSlug: slug("about"),
    });
    if (plan instanceof Error) throw plan;
    return { handlerContext, pageStore, projectStore, mutex, getLaunches, plan };
  }

  test("returns a synchronous started outcome with no admission events and launches exactly one operation", () => {
    const { handlerContext, plan, getLaunches } = setupConfirmScenario();

    const outcome = pageHandlers["page.removeConfirm"](
      { pageRemovePlanId: plan.pageRemovePlanId },
      handlerContext,
    );

    expect(outcome).toEqual({ disposition: "started", events: [] });
    expect(getLaunches()).toHaveLength(1);
  });

  test("its launched operation acquires the mutex, removes the page, releases the mutex, discards the plan, and resolves with no events", async () => {
    const { handlerContext, pageStore, mutex, plan, getLaunches } = setupConfirmScenario();

    pageHandlers["page.removeConfirm"]({ pageRemovePlanId: plan.pageRemovePlanId }, handlerContext);
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    expect(events).toEqual([]);
    const listed = await pageStore.listSlugs();
    expect(listed).toEqual([slug("home")]);
    expect(handlerContext.pageRemovePlanLedger.current()).toBeNull();
    expect(mutex.calls.some((c) => c.method === "release")).toBe(true);
  });

  test("reports not-found (logged) and still releases the mutex for a non-matching plan id", async () => {
    const { handlerContext, mutex, getLaunches } = setupConfirmScenario();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    pageHandlers["page.removeConfirm"](
      { pageRemovePlanId: "0192f6f0-0000-7000-8000-000000000099" },
      handlerContext,
    );
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    expect(events).toEqual([]);
    expect(mutex.calls.some((c) => c.method === "release")).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("logs and performs no write when gathering fresh facts fails (the failure branch, not drift)", async () => {
    const { handlerContext, pageStore, mutex, plan, getLaunches } = setupConfirmScenario();
    pageStore.failNext("readSource", FAILURE);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    pageHandlers["page.removeConfirm"]({ pageRemovePlanId: plan.pageRemovePlanId }, handlerContext);
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    expect(events).toEqual([]);
    expect(pageStore.calls.some((c) => c.method === "remove")).toBe(false);
    expect(mutex.calls.some((c) => c.method === "release")).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("logs and performs no write when the plan has genuinely drifted stale (page order changed since mint)", async () => {
    const { handlerContext, pageStore, mutex, plan, getLaunches } = setupConfirmScenario();
    // Bypass the plan-invalidating `reorder()` model function (`page-mutations.ts`) — call
    // the raw port directly so the underlying page order changes WITHOUT the active plan
    // being invalidated, producing a REAL `detectPageRemovePlanDrift` mismatch
    // (`orderedPageSlugs`/`pageOrderHash`), not merely a read failure (the previous test's
    // own, differently-shaped, case).
    await pageStore.reorder([slug("about"), slug("home")]);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    pageHandlers["page.removeConfirm"]({ pageRemovePlanId: plan.pageRemovePlanId }, handlerContext);
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    expect(events).toEqual([]);
    expect(pageStore.calls.some((c) => c.method === "remove")).toBe(false);
    expect(mutex.calls.some((c) => c.method === "release")).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    const [warnMessage] = warnSpy.mock.calls[0] ?? [];
    expect(typeof warnMessage).toBe("string");
    expect(warnMessage as string).toContain("stale");
    expect(warnMessage as string).toContain("orderedPageSlugs");
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// pin.create
// ---------------------------------------------------------------------------

function frameIdentity() {
  return {
    previewSessionId: "0192f6f0-0000-7000-8000-0000000000a1" as const,
    nonce: "a".repeat(32),
    sourceHash: "b".repeat(64),
    frameSeq: "1" as const,
  };
}

describe("pinHandlers['pin.create']", () => {
  test("returns a synchronous started outcome with no admission events and launches exactly one operation", () => {
    const { handlerContext, getLaunches } = buildTestContext();

    const outcome = pinHandlers["pin.create"](
      { geometryToken: "0192f6f0-0000-7000-8000-0000000000ff", text: "hi" },
      handlerContext,
    );

    expect(outcome).toEqual({ disposition: "started", events: [] });
    expect(getLaunches()).toHaveLength(1);
  });

  test("its launched operation consumes a resolving geometry token and publishes a pins.changed event that parses against eventPayloadV1SchemaByKind", async () => {
    const { handlerContext, pinStore, getLaunches } = buildTestContext();
    const identity = frameIdentity();
    const frameToken = handlerContext.frameTokenLedger.mint(identity);
    const acked = handlerContext.frameTokenLedger.acknowledge(frameToken);
    if (acked instanceof Error) throw acked;
    const geometryToken = handlerContext.geometryTokenLedger.mint({
      identity,
      pageSlug: "home",
      elementId: "btn-submit",
      fx: 0.5,
      fy: 0.5,
    });

    pinHandlers["pin.create"]({ geometryToken, text: "why is this red?" }, handlerContext);
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    const event = onlyEvent(events);
    expect(event.kind).toBe("pins.changed");
    const parsed = eventPayloadV1SchemaByKind["pins.changed"].safeParse(event.payload);
    expect(parsed.success).toBe(true);
    expect(pinStore.calls.some((c) => c.method === "appendStandaloneEvent")).toBe(true);
  });

  test("a rejected (stale/unknown) geometry token logs a warning, appends nothing, and resolves with no events", async () => {
    const { handlerContext, pinStore, getLaunches } = buildTestContext();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    pinHandlers["pin.create"](
      { geometryToken: "0192f6f0-0000-7000-8000-0000000000ff", text: "hi" },
      handlerContext,
    );
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    expect(events).toEqual([]);
    expect(pinStore.calls).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("when PinMutations.appendStandaloneEvent fails, its launched operation logs the failure and resolves with no events", async () => {
    const { handlerContext, pinStore, getLaunches } = buildTestContext();
    pinStore.failNext("appendStandaloneEvent", FAILURE);
    const identity = frameIdentity();
    const frameToken = handlerContext.frameTokenLedger.mint(identity);
    const acked = handlerContext.frameTokenLedger.acknowledge(frameToken);
    if (acked instanceof Error) throw acked;
    const geometryToken = handlerContext.geometryTokenLedger.mint({
      identity,
      pageSlug: "home",
      elementId: "btn-submit",
      fx: 0.5,
      fy: 0.5,
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    pinHandlers["pin.create"]({ geometryToken, text: "hi" }, handlerContext);
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    expect(events).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// pin.setStatus
// ---------------------------------------------------------------------------

const PIN_ID = "0192f6f0-0000-7000-8000-0000000000a1";

function createdPinEvent(): PinEvent {
  return {
    kind: "pin:created",
    recordId: "0192f6f0-0000-7000-8000-000000000001",
    pinId: PIN_ID,
    element: "btn-submit",
    fx: 0.5,
    fy: 0.5,
    text: "why is this red?",
    ts: "2024-01-01T00:00:00.000Z",
  };
}

describe("pinHandlers['pin.setStatus']", () => {
  test("returns a synchronous started outcome with no admission events and launches exactly one operation", () => {
    const { handlerContext, getLaunches } = buildTestContext();

    const outcome = pinHandlers["pin.setStatus"](
      { pinId: PIN_ID, status: "resolved" },
      handlerContext,
    );

    expect(outcome).toEqual({ disposition: "started", events: [] });
    expect(getLaunches()).toHaveLength(1);
  });

  test("its launched operation resolves the pin's page, appends the status event, and publishes a pins.changed event that parses against eventPayloadV1SchemaByKind", async () => {
    const { handlerContext, pinStore, getLaunches } = buildTestContext();
    await pinStore.appendStandaloneEvent(slug("home"), createdPinEvent());

    pinHandlers["pin.setStatus"]({ pinId: PIN_ID, status: "resolved" }, handlerContext);
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    const event = onlyEvent(events);
    expect(event.kind).toBe("pins.changed");
    const parsed = eventPayloadV1SchemaByKind["pins.changed"].safeParse(event.payload);
    expect(parsed.success).toBe(true);
    const payload = event.payload as { affectedPins: readonly { status: string }[] };
    expect(payload.affectedPins[0]?.status).toBe("resolved");
  });

  test("when no page owns the pinId, its launched operation logs the miss and resolves with no events", async () => {
    const { handlerContext, getLaunches } = buildTestContext();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    pinHandlers["pin.setStatus"]({ pinId: PIN_ID, status: "resolved" }, handlerContext);
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    expect(events).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("when resolving the pin's page fails, its launched operation logs the failure and resolves with no events", async () => {
    const { handlerContext, pinStore, getLaunches } = buildTestContext();
    pinStore.failNext("findPageForPin", FAILURE);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    pinHandlers["pin.setStatus"]({ pinId: PIN_ID, status: "resolved" }, handlerContext);
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    expect(events).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("when reading the raw pin-event log fails, its launched operation logs the failure and resolves with no events", async () => {
    const { handlerContext, pinStore, getLaunches } = buildTestContext();
    await pinStore.appendStandaloneEvent(slug("home"), createdPinEvent());
    pinStore.failNext("readEvents", FAILURE);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    pinHandlers["pin.setStatus"]({ pinId: PIN_ID, status: "resolved" }, handlerContext);
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    expect(events).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
