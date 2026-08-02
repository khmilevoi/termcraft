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
import {
  type DesignTreeReader,
  type HostSessionSpecV1,
  type HostSupervisorPort,
  PAGE_META_EXTRACTOR_VERSION,
  type PreviewSession,
} from "core/ports";
import {
  createFakeAgentBackend,
  createFakeAgentPromptSource,
  createFakeAgentRegistry,
  createFakeChatStore,
  createFakeDesignStoreForPages,
  createFakeDiagnosticsCache,
  createFakeExportPublish,
  createFakeExportRenderPort,
  createFakeGateRunner,
  createFakeHostSupervisorPort,
  createFakePageMetaCache,
  createFakePinStore,
  createFakePreviewSession,
  createFakeProjectStore,
  createFakeProjectWriteCoordinator,
  createFakeRecoveryService,
  createFakeRenderCache,
  createFakeSessionCheckpointService,
  createFakeStagingService,
  createFakeTrustGate,
  createFakeTurnTransactionService,
  defaultFakeEntry,
} from "core/ports/fakes";
import {
  createFrameBroker,
  createFrameTokenLedger,
  createGeometryTokenLedger,
  createPreviewBackpressure,
  createPreviewSessionCommands,
} from "core/preview";
import { createPageRemovePlanLedger } from "core/project/model/page-remove-plan";
import {
  type FailureDtoV1,
  type FrameIdentityV1,
  type UUIDv7,
  eventPayloadV1SchemaByKind,
} from "core/protocol";
import { type PageSlug, parsePageSlug } from "entities/page";
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

import type { KernelDeps } from "../../types";
import { exportHandlers, hostCircuitOpenedEvents, previewHandlers } from "./preview-export";
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
  const pageStore = createFakeDesignStoreForPages({
    pages: [
      {
        pageSlug: HOME,
        bytes: new TextEncoder().encode("export const meta = {}"),
        sha256: HOME_SOURCE_HASH,
      },
    ],
  });
  const pinStore = createFakePinStore();
  const clock: Clock = { now: () => new Date(1_700_000_000_000) };

  return {
    projectStore: overrides?.projectStore ?? createFakeProjectStore({ root: "/test-root" }),
    chatReader: chatStore,
    chatMutations: chatStore,
    designReader: pageStore,
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
    agentPromptSource: createFakeAgentPromptSource(),
    clock,
  };
}

interface TestHarness {
  readonly handlerContext: HandlerContext;
  readonly getMutatorCalls: () => number;
  /**
   * Every `launchOperation(label, run)` call, in order, so a test can `await` `run()` and
   * inspect its events. Typed against the SAME `PublishableEventV1[]` `HandlerContext
   * .launchOperation`'s own `run` parameter already promises (fix round 1, Minor finding) —
   * `run` is stored verbatim below, never cast to a widened `unknown[]`, so every call site
   * reads `events[n]!.kind`/`.payload`/`.correlation` directly instead of bouncing through an
   * ad-hoc `as {...}` shape.
   */
  readonly launched: readonly {
    readonly label: string;
    readonly run: () => Promise<readonly PublishableEventV1[]>;
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
    const launched: { label: string; run: () => Promise<readonly PublishableEventV1[]> }[] = [];
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
    // Hoisted (not built inline in the `HandlerContext` literal below) so `setActivePreviewSession`
    // can close over it and mirror `kernel.ts`'s own real cross-wiring — see that mutator's
    // comment just below.
    const previewSessionCommands = createPreviewSessionCommands({
      machine: machines.preview,
      hostSupervisor: deps.hostSupervisor,
      frameBroker: createFrameBroker(),
      frameTokenLedger,
      geometryTokenLedger,
      backpressure: createPreviewBackpressure(),
    });

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
      // Mirrors `kernel.ts`'s own real `setActivePreviewSession` — it ALSO seeds/clears
      // `previewSessionCommands`'s own internal session tracking (`noteSessionEstablished`/
      // `noteSessionClosed`), which is what lets `resize`/`setMode`/`setThemeCapabilities`/
      // `retry`/`queryGeometry`/`close` (routed through `context.previewSessionCommands`
      // since Task 10) find a real, live session to act on. `spec` (DEFECT 2 CLOSURE) is
      // forwarded verbatim, exactly like `kernel.ts`'s own real implementation — never
      // reconstructed here either.
      setActivePreviewSession: (session, spec) => {
        mutatorCalls += 1;
        activePreviewSession = session;
        if (session === null) {
          previewSessionCommands.noteSessionClosed();
          return;
        }
        previewSessionCommands.noteSessionEstablished(session, spec);
      },
      launchOperation: (label, run) => {
        launched.push({ label, run });
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
      currentPageDescriptors: () => [],
      previewSessionCommands,
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
      extractorVersion: PAGE_META_EXTRACTOR_VERSION,
    },
    meta: { kitApiVersion: 1, title: "Home", minSize: { w: 80, h: 24 }, theme: "dark" },
  });
}

function enable(machines: HandlerContext["machines"]): void {
  machines.preview.apply("kernel.preview.enable");
}

/**
 * Dispatches `preview.selectPage` and awaits the launched async half to settle, returning
 * its published events — the shared "establish a live session" setup every test below that
 * needs one (real or blocked-kind routing) starts from.
 */
async function selectPageAndSettle(
  harness: TestHarness,
  payload: { readonly pageSlug: PageSlug },
): Promise<readonly PublishableEventV1[]> {
  previewHandlers["preview.selectPage"](payload, harness.handlerContext);
  const launchedEntry = harness.launched[harness.launched.length - 1]!;
  return wrap(launchedEntry.run());
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

  test("a successful selectPage persists the page as the machine-local active one", async () => {
    const projectStore = createFakeProjectStore({
      root: "/test-root",
      workspaceState: { activePageSlug: null },
    });
    const deps = buildDeps({ projectStore });
    seedPageMeta(deps.pageMetaCache as ReturnType<typeof createFakePageMetaCache>);
    const harness = buildTestContext(deps);
    enable(harness.handlerContext.machines);

    await selectPageAndSettle(harness, { pageSlug: HOME });

    const read = await wrap(projectStore.readWorkspaceState());
    expect("code" in read ? read : read.state.activePageSlug).toBe(HOME);
  });

  test("a FAILED selectPage persists nothing — the active page is only what the user is really looking at", async () => {
    const projectStore = createFakeProjectStore({
      root: "/test-root",
      workspaceState: { activePageSlug: null },
    });
    const failure: FailureDtoV1 = {
      code: "HOST_START_FAILED",
      retryable: true,
      safeMessage: "host refused to start",
      details: {},
    };
    const hostSupervisor = createFakeHostSupervisorPort();
    hostSupervisor.failNext("preview", failure);
    const deps = buildDeps({ projectStore, hostSupervisor });
    seedPageMeta(deps.pageMetaCache as ReturnType<typeof createFakePageMetaCache>);
    const harness = buildTestContext(deps);
    enable(harness.handlerContext.machines);

    await selectPageAndSettle(harness, { pageSlug: HOME });

    const read = await wrap(projectStore.readWorkspaceState());
    expect("code" in read ? read : read.state.activePageSlug).toBeNull();
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

    const sourceChanged = events.find((event) => event.kind === "preview.sourceChanged");
    expect(sourceChanged).toBeDefined();
    const parsed = eventPayloadV1SchemaByKind["preview.sourceChanged"].parse(
      sourceChanged!.payload,
    );
    expect(parsed.pageSlug).toBe(HOME);
    expect(parsed.source).toEqual({ kind: "current" });
    expect(parsed.sourceHash).toBe(HOME_SOURCE_HASH);
    // Fix round 1, Finding 3: the id is the Kernel-tracked one `previewSessionCommands`
    // itself now reports — never a second, independently-minted `uuidv7()` (this file's own
    // header, "ONE NARROWER GAP" / "FIX ROUND 1, FINDING 3").
    const trackedId = harness.handlerContext.previewSessionCommands.currentPreviewSessionId();
    if (trackedId === null)
      throw new Error("expected previewSessionCommands to report a live previewSessionId");
    expect(parsed.previewSessionId).toBe(trackedId);

    const stateChanged = events.find((event) => event.kind === "kernel.stateChanged");
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

  test("publishes an event of KIND preview.sessionReady — the only arm that lets the UI leave an error state", async () => {
    const deps = buildDeps({
      projectStore: createFakeProjectStore({
        root: "/test-root",
        workspaceState: { themeOverride: "light", renderMode: "interactive" },
      }),
    });
    seedPageMeta(deps.pageMetaCache as ReturnType<typeof createFakePageMetaCache>);
    const harness = buildTestContext(deps);
    enable(harness.handlerContext.machines);

    previewHandlers["preview.selectPage"]({ pageSlug: HOME }, harness.handlerContext);
    const events = await wrap(harness.launched[0]!.run());

    // The machine's own `kernel.stateChanged{action:"kernel.preview.sessionReady"}` is NOT
    // this event: `ui/mirror`'s reducer switches on event KIND, so a transition record can
    // never move `PreviewMirror` out of `{phase:"failed"}` — and `Workspace.tsx` tests
    // `failed` before it tests for a live frame, pinning the error panel over a streaming
    // preview forever.
    const readyIndex = events.findIndex((event) => event.kind === "preview.sessionReady");
    expect(readyIndex).toBeGreaterThanOrEqual(0);

    const parsed = eventPayloadV1SchemaByKind["preview.sessionReady"].parse(
      events[readyIndex]!.payload,
    );
    // Every field traced back to something real, never minted for the event.
    const commands = harness.handlerContext.previewSessionCommands;
    expect(parsed.previewSessionId).toBe(commands.currentPreviewSessionId()!);
    expect(parsed.nonce).toBe(commands.currentNonce()!);
    expect(parsed.pageSlug).toBe(HOME);
    expect(parsed.sourceHash).toBe(HOME_SOURCE_HASH);
    expect(parsed.interactionMode).toBe("interactive"); // workspaceState.renderMode
    expect(parsed.theme).toBe("light"); // workspaceState.themeOverride, not the PageMeta default
    expect(parsed.initialFrameSeq).toBe("0"); // host frameSeq is monotonic from "1": none yet

    // Order is load-bearing — `ui/mirror` applies `preview.sourceChanged` only while already
    // `ready`, so a sourceChanged published first would be dropped.
    const sourceChangedIndex = events.findIndex((event) => event.kind === "preview.sourceChanged");
    expect(sourceChangedIndex).toBeGreaterThan(readyIndex);
  });

  test("async completion, page-meta cache MISS: extracts the page's meta through the Gate, establishes the session, and caches the entry", async () => {
    const deps = buildDeps(); // pageMetaCache left empty — a genuine miss
    const harness = buildTestContext(deps);
    enable(harness.handlerContext.machines);

    previewHandlers["preview.selectPage"]({ pageSlug: HOME }, harness.handlerContext);
    const events = await wrap(harness.launched[0]!.run());

    // A miss is a CACHE miss, not a "this page has no settings" verdict: the Gate's own
    // contract-only extraction is the real source, so the session comes up for real.
    expect(harness.handlerContext.machines.preview.phase()).toBe("live");
    expect(harness.getActivePreviewSession()).not.toBeNull();
    expect(events.some((event) => event.kind === "preview.sourceChanged")).toBe(true);

    // The extraction is written back under the SAME key the read missed on, so the next
    // preview of this unchanged source is a hit and never re-extracts.
    const cache = deps.pageMetaCache as ReturnType<typeof createFakePageMetaCache>;
    const put = cache.calls.find((call) => call.method === "put");
    expect(put).toBeDefined();
    expect(put!.key).toEqual({
      pageSlug: HOME,
      sourceHash: HOME_SOURCE_HASH,
      extractorVersion: PAGE_META_EXTRACTOR_VERSION,
    });
  });

  test("async completion, cache MISS and the page contract does not parse: sessionFailed + a preview.failed naming the real contract error", async () => {
    const deps = buildDeps(); // pageMetaCache left empty — a genuine miss
    (deps.gateRunner as ReturnType<typeof createFakeGateRunner>).queueExtractPageMetaResult({
      meta: null,
      errors: [
        {
          kind: "contract",
          code: "MISSING_META_FIELD",
          message: 'meta is missing the required "theme" field',
        },
      ],
    });
    const harness = buildTestContext(deps);
    enable(harness.handlerContext.machines);

    previewHandlers["preview.selectPage"]({ pageSlug: HOME }, harness.handlerContext);
    const events = await wrap(harness.launched[0]!.run());

    expect(harness.handlerContext.machines.preview.phase()).toBe("failed");
    expect(harness.getActivePreviewSession()).toBeNull();

    const failed = events.find((event) => event.kind === "preview.failed");
    expect(failed).toBeDefined();
    const parsed = eventPayloadV1SchemaByKind["preview.failed"].parse(failed!.payload);
    expect(parsed.pageSlug).toBe(HOME);
    expect(parsed.phase).toBe("starting");
    expect(parsed.failure.code).toBe("PERSISTENCE_FAILED");
    // The panel must name the defect in the page, not an opaque cache-internals message.
    expect(parsed.failure.safeMessage).toContain('meta is missing the required "theme" field');

    // An unresolvable contract is never cached — a later fix to the page must not be shadowed
    // by a poisoned entry.
    const cache = deps.pageMetaCache as ReturnType<typeof createFakePageMetaCache>;
    expect(cache.calls.some((call) => call.method === "put")).toBe(false);

    const stateChanged = events.find((event) => event.kind === "kernel.stateChanged");
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
    const failed = events.find((event) => event.kind === "preview.failed");
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

  test("resolves a page's source through CANONICAL storage — the host reads it with Bun.file", async () => {
    const specs: HostSessionSpecV1[] = [];
    // A minimal, purpose-built `HostSupervisorPort` (not the shared `createFakeHostSupervisorPort`
    // fake — its own `calls` log only records `pageSlug`, not the full spec this test needs to
    // inspect) that records every spec it is called with.
    const hostSupervisor: HostSupervisorPort = {
      preview: async (spec) => {
        specs.push(spec);
        return createFakePreviewSession({
          mode: spec.mode,
          pageSlug: spec.pageSlug,
          sourceHash: spec.sourceHash,
          kitApiVersion: spec.kitApiVersion,
          sessionId: "fake-session",
        });
      },
      liveCount: () => 0,
      stopAll: async () => {},
      onEvent: () => () => {},
    };
    const deps = buildDeps({ hostSupervisor });
    seedPageMeta(deps.pageMetaCache as ReturnType<typeof createFakePageMetaCache>);
    const harness = buildTestContext(deps);
    enable(harness.handlerContext.machines);

    await selectPageAndSettle(harness, { pageSlug: HOME });

    // CANONICAL storage is `<root>/.termcraft/design/<entry>` as of the design tree — the
    // entry comes from `design/pages.json`, never from the slug (this fixture's own entry is
    // `screens/<slug>/view.tsx`, which no slug-derivation in the old code could produce).
    expect(specs[0]?.sourcePath).toBe(
      `${deps.projectStore.root}/.termcraft/design/${defaultFakeEntry(HOME)}`,
    );
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

describe("previewHandlers — resize/setMode/setThemeCapabilities/queryGeometry — real, routed through the composed session router (Gap A closure)", () => {
  /** A real live session, established the same way `selectCurrentSource` does today — not a manually-forced phase. */
  async function liveHarnessWithSession(): Promise<TestHarness> {
    const deps = buildDeps();
    seedPageMeta(deps.pageMetaCache as ReturnType<typeof createFakePageMetaCache>);
    const harness = buildTestContext(deps);
    enable(harness.handlerContext.machines);
    await selectPageAndSettle(harness, { pageSlug: HOME });
    expect(harness.handlerContext.machines.preview.phase()).toBe("live");
    return harness;
  }

  test("resize calls the real session's own resize and publishes a live -> live kernel.stateChanged", async () => {
    const harness = await liveHarnessWithSession();
    const previewSessionId = uuidv7();

    const outcome = previewHandlers["preview.resize"](
      { previewSessionId, width: 100, height: 30 },
      harness.handlerContext,
    );
    expect(outcome.disposition).toBe("started");
    expect(harness.launched.length).toBeGreaterThan(0);

    const events = await wrap(harness.launched[harness.launched.length - 1]!.run());
    expect(events).toHaveLength(1);
    const parsed = eventPayloadV1SchemaByKind["kernel.stateChanged"].parse(events[0]!.payload);
    expect(parsed).toEqual({
      modelId: "kernel.preview.state",
      action: "kernel.preview.resize",
      previousTag: "live",
      nextTag: "live",
      metadata: {},
    });
    expect(events[0]!.correlation).toEqual({ previewSessionId });

    const session = harness.getActivePreviewSession() as ReturnType<
      typeof createFakePreviewSession
    >;
    expect(
      session.calls.some(
        (call) => call.method === "resize" && call.size.w === 100 && call.size.h === 30,
      ),
    ).toBe(true);
  });

  test("setMode calls the real session's own setMode and publishes a live -> live kernel.stateChanged", async () => {
    const harness = await liveHarnessWithSession();
    const previewSessionId = uuidv7();

    previewHandlers["preview.setMode"](
      { previewSessionId, mode: "interactive" },
      harness.handlerContext,
    );
    const events = await wrap(harness.launched[harness.launched.length - 1]!.run());
    expect(events).toHaveLength(1);
    const parsed = eventPayloadV1SchemaByKind["kernel.stateChanged"].parse(events[0]!.payload);
    expect(parsed.action).toBe("kernel.preview.setMode");

    const session = harness.getActivePreviewSession() as ReturnType<
      typeof createFakePreviewSession
    >;
    expect(
      session.calls.some((call) => call.method === "setMode" && call.mode === "interactive"),
    ).toBe(true);
  });

  test("setThemeCapabilities calls the real session's own setTheme and publishes a live -> live kernel.stateChanged", async () => {
    const harness = await liveHarnessWithSession();
    const previewSessionId = uuidv7();

    previewHandlers["preview.setThemeCapabilities"](
      { previewSessionId, themeId: "dark", terminalCapabilities: { colorDepth: 24 } },
      harness.handlerContext,
    );
    const events = await wrap(harness.launched[harness.launched.length - 1]!.run());
    expect(events).toHaveLength(1);
    const parsed = eventPayloadV1SchemaByKind["kernel.stateChanged"].parse(events[0]!.payload);
    expect(parsed.action).toBe("kernel.preview.setThemeCapabilities");

    const session = harness.getActivePreviewSession() as ReturnType<
      typeof createFakePreviewSession
    >;
    expect(
      session.calls.some(
        (call) =>
          call.method === "setTheme" &&
          call.theme === "dark" &&
          call.capabilities.colorDepth === 24,
      ),
    ).toBe(true);
  });

  test("queryGeometry verifies the frame token, routes to the real session, and publishes preview.geometryResult", async () => {
    const harness = await liveHarnessWithSession();
    const identity: FrameIdentityV1 = {
      previewSessionId: uuidv7(),
      nonce: "a".repeat(32),
      sourceHash: HOME_SOURCE_HASH,
      frameSeq: "0",
    };
    const frameToken = harness.handlerContext.frameTokenLedger.mint(identity);
    harness.handlerContext.frameTokenLedger.acknowledge(frameToken);

    const outcome = previewHandlers["preview.queryGeometry"](
      { frameToken, query: { kind: "layout" } },
      harness.handlerContext,
    );
    expect(outcome.disposition).toBe("started");

    const events = await wrap(harness.launched[harness.launched.length - 1]!.run());
    expect(events).toHaveLength(1);
    const parsed = eventPayloadV1SchemaByKind["preview.geometryResult"].parse(events[0]!.payload);
    expect(parsed.queryKind).toBe("layout");
    expect(parsed.frameTokenId).toBe(frameToken);
    expect(parsed.frameIdentity).toEqual(identity);
    // `FakePreviewSession.query`'s own default (no `queueQueryResult` call in this test).
    expect(parsed.result).toEqual({ kind: "checkHit", hit: null });
    expect(parsed.geometryToken).toBeNull();
  });

  test("queryGeometry with an unrecognized frame token is refused before ever reaching the session", async () => {
    const harness = await liveHarnessWithSession();

    previewHandlers["preview.queryGeometry"](
      { frameToken: uuidv7(), query: { kind: "layout" } },
      harness.handlerContext,
    );
    const events = await wrap(harness.launched[harness.launched.length - 1]!.run());
    expect(events).toHaveLength(0);

    const session = harness.getActivePreviewSession() as ReturnType<
      typeof createFakePreviewSession
    >;
    expect(session.calls.some((call) => call.method === "query")).toBe(false);
  });
});

describe("previewHandlers.retry — real routing, and Task 10's own documented `lastSpec` gap", () => {
  async function circuitOpenHarness(): Promise<TestHarness> {
    const harness = buildTestContext(buildDeps());
    enable(harness.handlerContext.machines);
    harness.handlerContext.machines.preview.apply("kernel.preview.beginStart");
    harness.handlerContext.machines.preview.apply("kernel.preview.sessionFailed");
    harness.handlerContext.machines.preview.apply("kernel.preview.openCircuit");
    expect(harness.handlerContext.machines.preview.phase()).toBe("circuit-open");
    return harness;
  }

  test('today, retry always lands on session-commands.ts\'s own "no remembered spec" branch: retryCircuit applies for real, and the handler recovers the machine to "failed" instead of stranding it at "starting" (fix round 1, Finding 1)', async () => {
    const harness = await circuitOpenHarness();
    const previewSessionId = uuidv7();

    const outcome = previewHandlers["preview.retry"]({ previewSessionId }, harness.handlerContext);
    expect(outcome.disposition).toBe("started");

    const events = await wrap(harness.launched[harness.launched.length - 1]!.run());
    // A refused retry recovers the machine and publishes only its two transitions — there is no
    // live session to announce.
    expect(events).toHaveLength(2);
    const first = eventPayloadV1SchemaByKind["kernel.stateChanged"].parse(events[0]!.payload);
    expect(first).toEqual({
      modelId: "kernel.preview.state",
      action: "kernel.preview.retryCircuit",
      previousTag: "circuit-open",
      nextTag: "starting",
      metadata: {},
    });
    const second = eventPayloadV1SchemaByKind["kernel.stateChanged"].parse(events[1]!.payload);
    expect(second).toEqual({
      modelId: "kernel.preview.state",
      action: "kernel.preview.sessionFailed",
      previousTag: "starting",
      nextTag: "failed",
      metadata: {},
    });
    // Recovered, not stranded: `failed` (unlike `starting`) has real exits —
    // beginStart/beginSwitch/openCircuit are all legal again from here.
    expect(harness.handlerContext.machines.preview.phase()).toBe("failed");
    expect(harness.handlerContext.machines.preview.canApply("kernel.preview.beginStart")).toBe(
      true,
    );
    expect(harness.handlerContext.machines.preview.canApply("kernel.preview.openCircuit")).toBe(
      true,
    );
    expect(harness.getActivePreviewSession()).toBeNull();
  });

  test("once the router's own lastSpec is seeded (simulating a fully-rewired selectPage), a successful retry reports both retryCircuit and sessionReady", async () => {
    const harness = await circuitOpenHarness();
    // Simulates the router having already established a prior session the way `selectPage`
    // would once it also routes establishment through `previewSessionCommands` (this file's
    // header, "ONE NARROWER GAP") — calling the router directly here, bypassing
    // `preview-export.ts`'s own handler, purely to seed `lastSpec` for this test.
    const spec: HostSessionSpecV1 = {
      mode: "preview",
      interactionMode: "static",
      pageSlug: HOME,
      sourcePath: "/test-root/.termcraft/pages/home/page.tsx",
      sourceHash: HOME_SOURCE_HASH,
      kitApiVersion: 1,
      size: { w: 80, h: 24 },
      theme: "dark",
      capabilities: { colorDepth: 16 },
    };
    await wrap(harness.handlerContext.previewSessionCommands.selectPage(spec));
    // `selectPage` itself just moved the machine `circuit-open -> starting -> live` (via its
    // own internal `establishSession`) — reset back to `circuit-open` so this test can drive
    // the SAME handler-level `preview.retry` path as the test above, now with `lastSpec` set.
    harness.handlerContext.machines.preview.apply("kernel.preview.sessionFailed");
    harness.handlerContext.machines.preview.apply("kernel.preview.openCircuit");
    expect(harness.handlerContext.machines.preview.phase()).toBe("circuit-open");

    const previewSessionId = uuidv7();
    previewHandlers["preview.retry"]({ previewSessionId }, harness.handlerContext);
    const events = await wrap(harness.launched[harness.launched.length - 1]!.run());

    // The two machine transitions PLUS the pair that actually moves the UI out of its error
    // panel — `preview.sessionReady` then `preview.sourceChanged`. Publishing only the
    // transitions left `PreviewMirror` on `{phase:"circuit-open"}`, and `Workspace.tsx` tests
    // that phase before it tests for a live frame, so a recovered preview streamed frames behind
    // a permanently pinned "preview stopped after repeated failures" panel.
    expect(events.map((event) => event.kind)).toEqual([
      "kernel.stateChanged",
      "kernel.stateChanged",
      "preview.sessionReady",
      "preview.sourceChanged",
    ]);
    const ready = eventPayloadV1SchemaByKind["preview.sessionReady"].parse(events[2]!.payload);
    // Read from the re-established session and the spec it was reissued with — never minted.
    expect(ready.previewSessionId).toBe(
      harness.handlerContext.previewSessionCommands.currentPreviewSessionId()!,
    );
    expect(ready.nonce).toBe(harness.handlerContext.previewSessionCommands.currentNonce()!);
    expect(ready.pageSlug).toBe(HOME);
    const first = eventPayloadV1SchemaByKind["kernel.stateChanged"].parse(events[0]!.payload);
    expect(first).toEqual({
      modelId: "kernel.preview.state",
      action: "kernel.preview.retryCircuit",
      previousTag: "circuit-open",
      nextTag: "starting",
      metadata: {},
    });
    const second = eventPayloadV1SchemaByKind["kernel.stateChanged"].parse(events[1]!.payload);
    expect(second).toEqual({
      modelId: "kernel.preview.state",
      action: "kernel.preview.sessionReady",
      previousTag: "starting",
      nextTag: "live",
      metadata: {},
    });
    expect(harness.handlerContext.machines.preview.phase()).toBe("live");
    // Fix round 1, Finding 2: a successful retry must sync `activePreview` with whichever
    // session the router's own `establishSession` actually left behind — the NEW one this
    // retry established, read back via `previewSessionCommands.currentSession()` — never
    // leave the router and `activePreview` pointing at two different sessions.
    expect(harness.getActivePreviewSession()).not.toBeNull();
    expect(harness.getActivePreviewSession()).toBe(
      harness.handlerContext.previewSessionCommands.currentSession(),
    );
  });

  test("with lastSpec seeded, a re-establishment that fails still recovers to failed and clears activePreview (fix round 1, Finding 2's failure-path symmetry)", async () => {
    const deps = buildDeps();
    const harness = buildTestContext(deps);
    enable(harness.handlerContext.machines);

    const spec: HostSessionSpecV1 = {
      mode: "preview",
      interactionMode: "static",
      pageSlug: HOME,
      sourcePath: "/test-root/.termcraft/pages/home/page.tsx",
      sourceHash: HOME_SOURCE_HASH,
      kitApiVersion: 1,
      size: { w: 80, h: 24 },
      theme: "dark",
      capabilities: { colorDepth: 16 },
    };
    // Seeds `lastSpec` the same bypass way the test above does, then drives the machine back
    // to `circuit-open` so `preview.retry` is legal again.
    await wrap(harness.handlerContext.previewSessionCommands.selectPage(spec));
    harness.handlerContext.machines.preview.apply("kernel.preview.sessionFailed");
    harness.handlerContext.machines.preview.apply("kernel.preview.openCircuit");
    expect(harness.handlerContext.machines.preview.phase()).toBe("circuit-open");

    const hostFailure: FailureDtoV1 = {
      code: "HOST_START_FAILED",
      retryable: true,
      safeMessage: "host refused to restart",
      details: {},
    };
    (deps.hostSupervisor as ReturnType<typeof createFakeHostSupervisorPort>).failNext(
      "preview",
      hostFailure,
    );

    const previewSessionId = uuidv7();
    previewHandlers["preview.retry"]({ previewSessionId }, harness.handlerContext);
    const events = await wrap(harness.launched[harness.launched.length - 1]!.run());

    expect(events).toHaveLength(2);
    const first = eventPayloadV1SchemaByKind["kernel.stateChanged"].parse(events[0]!.payload);
    expect(first).toEqual({
      modelId: "kernel.preview.state",
      action: "kernel.preview.retryCircuit",
      previousTag: "circuit-open",
      nextTag: "starting",
      metadata: {},
    });
    const second = eventPayloadV1SchemaByKind["kernel.stateChanged"].parse(events[1]!.payload);
    expect(second).toEqual({
      modelId: "kernel.preview.state",
      action: "kernel.preview.sessionFailed",
      previousTag: "starting",
      nextTag: "failed",
      metadata: {},
    });
    expect(harness.handlerContext.machines.preview.phase()).toBe("failed");
    // The router's own `establishSession` already cleared its `currentSession` on failure —
    // `activePreview` must not be left pointing at the stale prior session.
    expect(harness.getActivePreviewSession()).toBeNull();
    expect(harness.handlerContext.previewSessionCommands.currentSession()).toBeNull();
  });
});

/**
 * DEFECTS 1+2 CLOSURE — the whole route, end to end: a real host failure carrying
 * `HOST_CIRCUIT_OPEN` must actually open the circuit and publish a schema-valid
 * `preview.circuitOpened` (defect 1 — `openCircuit` was never applied by production
 * code, so `circuit-open`, and therefore `preview.retry`, was unreachable), and a
 * subsequent `preview.retry` must actually succeed by reissuing the spec the router
 * remembers (defect 2 — `noteSessionEstablished` never threaded the spec `preview-export
 * .ts`'s own `selectCurrentSource` already has in hand, so `lastSpec` stayed `null`
 * forever in production and `retry()` always refused). Neither fix alone closes the
 * feature: this test drives both, in the order production actually reaches them.
 */
describe("previewHandlers — DEFECTS 1+2 CLOSURE: HOST_CIRCUIT_OPEN -> circuit-open + preview.circuitOpened -> preview.retry -> a re-established live session", () => {
  test("a live session's later establishment failure carrying HOST_CIRCUIT_OPEN opens the circuit and publishes preview.circuitOpened; preview.retry then reissues the remembered spec and re-establishes a live session", async () => {
    const deps = buildDeps();
    seedPageMeta(deps.pageMetaCache as ReturnType<typeof createFakePageMetaCache>);
    const harness = buildTestContext(deps);
    enable(harness.handlerContext.machines);

    // First establishment succeeds — DEFECT 2's fix threads the real spec into
    // `previewSessionCommands`'s own `lastSpec` via `setActivePreviewSession(session, spec)`.
    await selectPageAndSettle(harness, { pageSlug: HOME });
    expect(harness.handlerContext.machines.preview.phase()).toBe("live");

    // A second establishment attempt for the SAME page — this time the host reports the
    // real `HOST_CIRCUIT_OPEN` code `host/adapters/host-supervisor.ts`'s own
    // `toHostFailureDto` maps from `SupervisorError`'s `CIRCUIT_OPEN`.
    // NOT annotated `: FailureDtoV1` — that interface's `code` is the wide 30-member
    // `OperationalFailureCode` union, which loses the `"HOST_CIRCUIT_OPEN"` literal and
    // makes the `toEqual(circuitFailure)` comparison below fail to typecheck against
    // `failureDtoV1Schema`'s own discriminated-union inference. `satisfies` keeps the
    // literal while still checking structural conformance to `FailureDtoV1`.
    const circuitFailure = {
      code: "HOST_CIRCUIT_OPEN",
      retryable: false,
      safeMessage: "restart budget exhausted (3 in 60000ms)",
      details: { supervisorErrorCode: "CIRCUIT_OPEN" },
    } as const satisfies FailureDtoV1;
    (deps.hostSupervisor as ReturnType<typeof createFakeHostSupervisorPort>).failNext(
      "preview",
      circuitFailure,
    );

    previewHandlers["preview.selectCurrent"]({ pageSlug: HOME }, harness.handlerContext);
    const failEvents = await wrap(harness.launched[harness.launched.length - 1]!.run());

    // DEFECT 1: `openCircuit` really applied — the machine actually reaches circuit-open.
    expect(harness.handlerContext.machines.preview.phase()).toBe("circuit-open");

    const stateChanges = failEvents.filter((e) => e.kind === "kernel.stateChanged");
    const actions = stateChanges.map(
      (e) => eventPayloadV1SchemaByKind["kernel.stateChanged"].parse(e.payload).action,
    );
    expect(actions).toEqual(["kernel.preview.sessionFailed", "kernel.preview.openCircuit"]);

    // preview.failed still publishes too (the sessionFailed transition genuinely applied).
    expect(failEvents.some((e) => e.kind === "preview.failed")).toBe(true);

    const circuitOpened = failEvents.find((e) => e.kind === "preview.circuitOpened");
    expect(circuitOpened).toBeDefined();
    const parsedCircuit = eventPayloadV1SchemaByKind["preview.circuitOpened"].parse(
      circuitOpened!.payload,
    );
    expect(parsedCircuit.pageSlug).toBe(HOME);
    expect(parsedCircuit.sourceHash).toBe(HOME_SOURCE_HASH);
    expect(parsedCircuit.finalFailure).toEqual(circuitFailure);
    // `retryCircuit` is legal from `circuit-open` (the machine just reached it) — a real,
    // live read off the machine, never hardcoded.
    expect(parsedCircuit.retryCapability).toEqual({ available: true });

    // DEFECT 2: preview.retry now actually succeeds — `lastSpec` (seeded by the FIRST,
    // successful establishment above) is reissued, never refused for "no remembered spec".
    const previewSessionId = uuidv7();
    const retryOutcome = previewHandlers["preview.retry"](
      { previewSessionId },
      harness.handlerContext,
    );
    expect(retryOutcome.disposition).toBe("started");
    const retryEvents = await wrap(harness.launched[harness.launched.length - 1]!.run());

    const retryActions = retryEvents
      .filter((e) => e.kind === "kernel.stateChanged")
      .map((e) => eventPayloadV1SchemaByKind["kernel.stateChanged"].parse(e.payload).action);
    expect(retryActions).toEqual(["kernel.preview.retryCircuit", "kernel.preview.sessionReady"]);

    expect(harness.handlerContext.machines.preview.phase()).toBe("live");
    expect(harness.getActivePreviewSession()).not.toBeNull();
    expect(harness.getActivePreviewSession()).toBe(
      harness.handlerContext.previewSessionCommands.currentSession(),
    );

    // The host actually saw two `preview()` calls with the SAME reissued page: the failed
    // one and the retry's own re-establishment — proving the SAME spec was reissued, not a
    // reconstructed stand-in.
    const fakeHost = deps.hostSupervisor as ReturnType<typeof createFakeHostSupervisorPort>;
    expect(fakeHost.calls.filter((c) => c.method === "preview").map((c) => c.pageSlug)).toEqual([
      HOME,
      HOME,
      HOME,
    ]);
  });
});

describe("previewHandlers.close — real, end to end (Gap A closure)", () => {
  test("applies disable, clears the tracked session, calls the real session's own close(), and emits a schema-valid kernel.stateChanged", async () => {
    const deps = buildDeps();
    seedPageMeta(deps.pageMetaCache as ReturnType<typeof createFakePageMetaCache>);
    const harness = buildTestContext(deps);
    enable(harness.handlerContext.machines);
    await selectPageAndSettle(harness, { pageSlug: HOME });
    expect(harness.handlerContext.machines.preview.phase()).toBe("live");
    const session = harness.getActivePreviewSession() as ReturnType<
      typeof createFakePreviewSession
    >;

    const previewSessionId = uuidv7();
    const outcome = previewHandlers["preview.close"]({ previewSessionId }, harness.handlerContext);
    expect(outcome.disposition).toBe("started");

    const events = await wrap(harness.launched[harness.launched.length - 1]!.run());

    expect(events).toHaveLength(1);
    const parsed = eventPayloadV1SchemaByKind["kernel.stateChanged"].parse(events[0]!.payload);
    expect(parsed).toEqual({
      modelId: "kernel.preview.state",
      action: "kernel.preview.disable",
      previousTag: "live",
      nextTag: "disabled",
      metadata: {},
    });
    expect(events[0]!.correlation).toEqual({ previewSessionId });
    expect(harness.handlerContext.machines.preview.phase()).toBe("disabled");
    expect(harness.getActivePreviewSession()).toBeNull();
    // The host-side half Gap A used to block: the real session's own close() was called.
    expect(session.calls.some((call) => call.method === "close")).toBe(true);
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

    // WP-5 Task B3: `publishExport` also reads the current pointer (D-Q5) before building
    // the plan — a genuine second call on this same fake, scoped out below so this test
    // still asserts exactly one `publish()`.
    const exportPublish = deps.exportPublish as ReturnType<typeof createFakeExportPublish>;
    expect(exportPublish.calls.filter((c) => c.method === "publish")).toHaveLength(1);

    // The terminal batch: exactly one `export.completed`.
    expect(events).toHaveLength(1);
    const completed = events[0]!;
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
    const failed = events[0]!;
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

  test('pre-publish re-resolve failure: never emits a publishing progress event, the terminal export.failed carries phase "rendering", and publish is never called', async () => {
    const deps = buildDeps();
    seedPageMeta(deps.pageMetaCache as ReturnType<typeof createFakePageMetaCache>);

    // The initial `resolveExportPageInputs` (before capture) must succeed — only the
    // SECOND call (the pre-publish re-resolve) fails, exactly the failure this test pins.
    // `design/pages.json` is read once per whole-page-list pass, in this fixed order for a
    // one-page project: (1) `resolveExportPageInputs` before capture, (2)
    // `captureExportSnapshot`'s own permit-held read, (3) `resolveExportPageInputs` AGAIN for
    // the pre-publish re-resolve — the one this test makes fail — and (4) `publishExport`,
    // which this failure means is never reached. Failing from the third is what puts the
    // failure in the pre-publish window specifically, with the export machine already in
    // `rendering`; the assertions below would not distinguish it from an earlier failure.
    let readManifestCalls = 0;
    const flakyDesignReader: DesignTreeReader = {
      readTreeFile: (relPath) => deps.designReader.readTreeFile(relPath),
      listTree: () => deps.designReader.listTree(),
      readManifest: async () => {
        readManifestCalls += 1;
        if (readManifestCalls < 3) return deps.designReader.readManifest();
        return {
          code: "PERSISTENCE_FAILED",
          retryable: false,
          safeMessage: "readManifest failed on the pre-publish re-resolve",
          details: {},
        };
      },
    };
    const harness = buildTestContext({ ...deps, designReader: flakyDesignReader });

    exportHandlers["export.start"]({}, harness.handlerContext);
    const events = await wrap(harness.launched[0]!.run());

    expect(harness.handlerContext.machines.export.phase()).toBe("idle");

    const exportPublish = deps.exportPublish as ReturnType<typeof createFakeExportPublish>;
    expect(exportPublish.calls).toHaveLength(0);

    expect(events).toHaveLength(1);
    const failed = events[0]!;
    expect(failed.kind).toBe("export.failed");
    const parsedFailed = eventPayloadV1SchemaByKind["export.failed"].parse(failed.payload);
    expect(parsedFailed.phase).toBe("rendering");
    expect(parsedFailed.generationId).toBeNull();
    expect(parsedFailed.failure?.code).toBe("PERSISTENCE_FAILED");

    // The re-resolve fails BEFORE publishing genuinely begins — a client must never see a
    // "publishing" progress event for a phase the operation never entered.
    const published = harness.getPublishedEvents();
    expect(published.map((e) => e.kind)).toEqual(["export.started", "export.progress"]);
    const renderingProgress = eventPayloadV1SchemaByKind["export.progress"].parse(
      published[1]!.payload,
    );
    expect(renderingProgress.phase).toBe("rendering");
  });

  test('pre-capture failure: resolveExportPageInputs fails before captureExportSnapshot is ever called — publishes a schema-valid export.failed with phase "idle" instead of being swallowed', async () => {
    const deps = buildDeps();
    seedPageMeta(deps.pageMetaCache as ReturnType<typeof createFakePageMetaCache>);

    // Fails on the FIRST call — resolveExportPageInputs never even reaches
    // captureExportSnapshot, so the export machine never leaves "idle".
    const failingDesignReader: DesignTreeReader = {
      readTreeFile: (relPath) => deps.designReader.readTreeFile(relPath),
      listTree: () => deps.designReader.listTree(),
      readManifest: async () => ({
        code: "PERSISTENCE_FAILED",
        retryable: false,
        safeMessage: "readManifest failed before capture",
        details: {},
      }),
    };
    const harness = buildTestContext({ ...deps, designReader: failingDesignReader });

    exportHandlers["export.start"]({}, harness.handlerContext);
    const events = await wrap(harness.launched[0]!.run());

    expect(harness.handlerContext.machines.export.phase()).toBe("idle");

    const exportPublish = deps.exportPublish as ReturnType<typeof createFakeExportPublish>;
    expect(exportPublish.calls).toHaveLength(0);

    expect(events).toHaveLength(1);
    const failed = events[0]!;
    expect(failed.kind).toBe("export.failed");
    const parsedFailed = eventPayloadV1SchemaByKind["export.failed"].parse(failed.payload);
    expect(parsedFailed.phase).toBe("idle");
    expect(parsedFailed.generationId).toBeNull();
    expect(parsedFailed.failure?.code).toBe("PERSISTENCE_FAILED");

    // Capture never began — no export.started, no export.progress, nothing else.
    const published = harness.getPublishedEvents();
    expect(published).toHaveLength(0);
  });
});

/**
 * The reported defect's actual fix. Every describe above reaches `circuit-open` through an
 * ESTABLISHMENT failure — the `hostSupervisor.preview()` CALL itself returned
 * `HOST_CIRCUIT_OPEN`, so a command was in flight to attribute it to. This one covers the
 * opposite arrival: a session that established fine and crash-looped later, whose failure
 * reaches the Kernel unsolicited over `HostSupervisorPort.onEvent`.
 */
describe("hostCircuitOpenedEvents — a LIVE session's host crash-loop", () => {
  const RENDER_CRASH = "PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function";

  async function liveHarness() {
    const deps = buildDeps();
    seedPageMeta(deps.pageMetaCache as ReturnType<typeof createFakePageMetaCache>);
    const harness = buildTestContext(deps);
    enable(harness.handlerContext.machines);
    await selectPageAndSettle(harness, { pageSlug: HOME });
    expect(harness.handlerContext.machines.preview.phase()).toBe("live");
    return harness;
  }

  test("applies sessionFailed then openCircuit and publishes preview.circuitOpened carrying the host's own message and the real attempt count", async () => {
    const harness = await liveHarness();

    const events = hostCircuitOpenedEvents(
      harness.handlerContext,
      uuidv7(),
      HOME,
      HOME_SOURCE_HASH,
      {
        attempts: 4,
        safeMessage: RENDER_CRASH,
        hostFailureCode: "DESIGN_RENDER_FAILED",
      },
    );

    expect(harness.handlerContext.machines.preview.phase()).toBe("circuit-open");

    const actions = events
      .filter((e) => e.kind === "kernel.stateChanged")
      .map((e) => eventPayloadV1SchemaByKind["kernel.stateChanged"].parse(e.payload).action);
    expect(actions).toEqual(["kernel.preview.sessionFailed", "kernel.preview.openCircuit"]);

    const opened = events.find((e) => e.kind === "preview.circuitOpened");
    expect(opened).toBeDefined();
    const payload = eventPayloadV1SchemaByKind["preview.circuitOpened"].parse(opened!.payload);
    // The supervisor's REAL tally, not `KERNEL_ESTABLISH_ATTEMPTS_PER_COMMAND`'s stand-in 1.
    expect(payload.attempts).toBe(4);
    expect(payload.finalFailure.code).toBe("HOST_CIRCUIT_OPEN");
    expect(payload.finalFailure.safeMessage).toBe(RENDER_CRASH);
    expect(payload.retryCapability).toEqual({ available: true });
  });

  test("carries the failing incarnation's code in details, so the UI branches on evidence rather than re-deriving it", async () => {
    const harness = await liveHarness();

    const events = hostCircuitOpenedEvents(
      harness.handlerContext,
      uuidv7(),
      HOME,
      HOME_SOURCE_HASH,
      {
        attempts: 1,
        safeMessage: "scratch dir creation failed: EACCES (mkdtemp)",
        hostFailureCode: "SPAWN_FAILED",
      },
    );

    const opened = events.find((e) => e.kind === "preview.circuitOpened");
    const payload = eventPayloadV1SchemaByKind["preview.circuitOpened"].parse(opened!.payload);
    expect(payload.finalFailure.details.hostFailureCode).toBe("SPAWN_FAILED");
    // A deterministic ProtocolError opens the circuit on the FIRST failure — one incarnation,
    // zero restarts. The count is reported as measured, never rounded up to the budget.
    expect(payload.attempts).toBe(1);
  });

  test("omits hostFailureCode entirely when the event carried none — absent is not DESIGN_RENDER_FAILED", async () => {
    const harness = await liveHarness();

    const events = hostCircuitOpenedEvents(
      harness.handlerContext,
      uuidv7(),
      HOME,
      HOME_SOURCE_HASH,
      {
        attempts: 4,
        safeMessage: "the preview host stopped",
        hostFailureCode: undefined,
      },
    );

    const opened = events.find((e) => e.kind === "preview.circuitOpened");
    const payload = eventPayloadV1SchemaByKind["preview.circuitOpened"].parse(opened!.payload);
    expect("hostFailureCode" in payload.finalFailure.details).toBe(false);
  });

  test("returns no events when the machine cannot legally take sessionFailed", () => {
    const harness = buildTestContext(buildDeps());
    // `disabled` — sessionFailed has no edge from here, so a late or duplicate circuitOpened
    // is dropped rather than published a second time.
    expect(harness.handlerContext.machines.preview.phase()).toBe("disabled");

    const events = hostCircuitOpenedEvents(
      harness.handlerContext,
      uuidv7(),
      HOME,
      HOME_SOURCE_HASH,
      {
        attempts: 4,
        safeMessage: "boom",
        hostFailureCode: "DESIGN_RENDER_FAILED",
      },
    );

    expect(events).toEqual([]);
    expect(harness.handlerContext.machines.preview.phase()).toBe("disabled");
  });
});
