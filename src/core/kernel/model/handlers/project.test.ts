import { describe, expect, spyOn, test } from "bun:test";

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
import type { ChatHeaderV1, ChatLoadResultV1, ChatReader, PreviewSession } from "core/ports";
import {
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
import {
  type CommandPayloadByKindV1,
  type EventKindV1,
  type FailureDtoV1,
  type UUIDv7,
  eventPayloadV1SchemaByKind,
} from "core/protocol";
import type { ChatRecord } from "entities/chat";
import { parsePageSlug } from "entities/page";
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

import type { KernelDeps } from "../../types";
import { projectHandlers } from "./project";
import type { HandlerContext, PreviewSourceKindV1, ProjectTrustV1 } from "./types";

/**
 * `project.create` / `project.open` / `project.retryOpen` / `project.close` /
 * `project.setTrust` — Task 9 Step B, the `project` family (`./project.ts`'s own header
 * documents the design; this file proves it against the real fakes).
 *
 * Every test lives inside ONE `context.start(async () => {...})` call — construction,
 * the handler call, awaiting a captured `launchOperation` `run`, and assertions all in the
 * same frame — matching `core/project/model/open-sequence.test.ts`'s own established
 * precedent: a plain, unwrapped `await` mid-test would resume outside the frame the
 * machines were built in, reading back stuck initial phases instead of what the run
 * actually did.
 *
 * Every emitted event is validated against `eventPayloadV1SchemaByKind` — not just
 * counted — per the task brief.
 */

function slug(value: string) {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const FAKE_SOURCE_HASH = "a".repeat(64);

const FAILURE: FailureDtoV1 = {
  code: "PERSISTENCE_FAILED",
  retryable: false,
  safeMessage: "boom",
  details: {},
};

interface ChatReaderStubCall {
  readonly method: "open";
  readonly chatId: string;
}

/**
 * A minimal, single-chat `ChatReader` double (WP-10 Task 6) — `core/ports/fakes`'s shared
 * `createFakeChatStore` only recognizes a chatId it minted itself via `create()`
 * (`fake-chat-N` format), so a test that needs `ChatReader.open` to recognize an
 * arbitrary, schema-valid UUIDv7 `activeChatId` (to validate the resulting
 * `chat.changed`/`chat.records` payloads against their real protocol schemas) needs this
 * local double instead — the same precedent `handlers/chat.test.ts`'s own
 * `createChatReaderStub` already establishes for `chat.switch`.
 *
 * `list()` reports this SAME chat's own facts (fix-bundle Task 7) — its `firstUserText` is
 * derived from `loadTailResult`'s own first `user` record when `loadTailResult` is not itself
 * a failure, `null` otherwise — rather than a second, independently-specified fixture a caller
 * would have to keep in sync with `loadTailResult` by hand.
 */
function createChatReaderStub(
  chatId: string,
  header: ChatHeaderV1,
  loadTailResult: FailureDtoV1 | ChatLoadResultV1,
): ChatReader & { readonly calls: readonly ChatReaderStubCall[] } {
  const calls: ChatReaderStubCall[] = [];
  const unknownChat = (requestedChatId: string): FailureDtoV1 => ({
    code: "PERSISTENCE_FAILED",
    retryable: false,
    safeMessage: `chat-reader stub only knows chatId ${chatId}, not ${requestedChatId}`,
    details: { chatId: requestedChatId },
  });
  const firstUserText =
    "code" in loadTailResult
      ? null
      : (loadTailResult.records.find(
          (record): record is Extract<ChatRecord, { readonly kind: "user" }> =>
            record.kind === "user",
        )?.text ?? null);

  return {
    calls,
    async open(requestedChatId: string) {
      calls.push({ method: "open", chatId: requestedChatId });
      if (requestedChatId !== chatId) return unknownChat(requestedChatId);
      return {
        header,
        async loadTail() {
          return loadTailResult;
        },
        async loadBefore() {
          return unknownChat(requestedChatId);
        },
      };
    },
    async readAppendBase(requestedChatId: string) {
      return unknownChat(requestedChatId);
    },
    async list() {
      return [{ chatId, createdAt: header.createdAt, firstUserText }];
    },
  };
}

interface TestHarness {
  readonly handlerContext: HandlerContext;
  readonly getTrust: () => ProjectTrustV1;
  readonly getPreviewSession: () => PreviewSession | null;
  readonly getLaunchOperations: () => readonly {
    readonly label: string;
    readonly run: () => Promise<readonly import("core/mailbox").PublishableEventV1[]>;
  }[];
  readonly deps: KernelDeps;
  readonly machines: HandlerContext["machines"];
}

/**
 * Builds a real `HandlerContext` — real machines, real fake ports — matching
 * `handlers/index.test.ts`'s own `buildTestContext` shape, PLUS a `launchOperation` fake
 * that CAPTURES every `(label, run)` call instead of discarding it, so a test can await
 * the operation's own terminal events. Must be called synchronously from inside an active
 * `context.start(...)` frame — see this file's header.
 */
function buildTestContext(options?: {
  readonly projectStore?: ReturnType<typeof createFakeProjectStore>;
  readonly pageReader?: ReturnType<typeof createFakePageStore>;
  readonly recovery?: ReturnType<typeof createFakeRecoveryService>;
  readonly trustGate?: ReturnType<typeof createFakeTrustGate>;
  readonly chatReader?: ChatReader;
  readonly exportPublish?: ReturnType<typeof createFakeExportPublish>;
}): TestHarness {
  let trust: ProjectTrustV1 = null;
  let activeTurnId: UUIDv7 | null = null;
  let commitIntentRecorded = false;
  let previewSourceKind: PreviewSourceKindV1 = null;
  let previewSession: PreviewSession | null = null;
  const launchOperations: {
    label: string;
    run: () => Promise<readonly import("core/mailbox").PublishableEventV1[]>;
  }[] = [];

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
  const pageStore = options?.pageReader ?? createFakePageStore({ order: [] });
  const pinStore = createFakePinStore();
  const clock: Clock = { now: () => new Date(1_700_000_000_000) };

  const deps: KernelDeps = {
    projectStore: options?.projectStore ?? createFakeProjectStore({ root: "/test-root" }),
    chatReader: options?.chatReader ?? chatStore,
    chatMutations: chatStore,
    pageReader: pageStore,
    pageMutations: pageStore,
    pinReader: pinStore,
    pinMutations: pinStore,
    turnTransactions: createFakeTurnTransactionService(),
    projectWrite: createFakeProjectWriteCoordinator(),
    staging: createFakeStagingService(),
    trustGate: options?.trustGate ?? createFakeTrustGate(),
    pageMetaCache: createFakePageMetaCache(),
    diagnosticsCache: createFakeDiagnosticsCache(),
    renderCache: createFakeRenderCache(),
    sessionCheckpoint: createFakeSessionCheckpointService(),
    recovery: options?.recovery ?? createFakeRecoveryService(),
    gateRunner: createFakeGateRunner(),
    hostSupervisor: createFakeHostSupervisorPort(),
    exportRender: createFakeExportRenderPort(),
    exportPublish: options?.exportPublish ?? createFakeExportPublish(),
    agentRegistry: createFakeAgentRegistry([createFakeAgentBackend()]),
    agentPromptSource: createFakeAgentPromptSource(),
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
      trust = next;
    },
    setActiveTurnId: (next) => {
      activeTurnId = next;
    },
    setCommitIntentRecorded: (next) => {
      commitIntentRecorded = next;
    },
    setPreviewSourceKind: (next) => {
      previewSourceKind = next;
    },
    setActivePreviewSession: (session) => {
      previewSession = session;
    },
    launchOperation: (label, run) => {
      launchOperations.push({ label, run });
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
    currentPreviewSession: () => previewSession,
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
    getTrust: () => trust,
    getPreviewSession: () => previewSession,
    getLaunchOperations: () => launchOperations,
    deps,
    machines,
  };
}

/** Validates one event's payload against its OWN kind's real protocol schema — never just counted. */
function expectValidEvent(event: { readonly kind: string; readonly payload: unknown }): void {
  const schema = eventPayloadV1SchemaByKind[event.kind as keyof typeof eventPayloadV1SchemaByKind];
  const parsed = schema.safeParse(event.payload);
  if (!parsed.success) {
    throw new Error(
      `event "${event.kind}" failed schema validation: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
}

/** Finds the one event of `kind` in `events`, narrowing `.payload` to that kind's own shape — never a bare `as`. */
function findEvent<K extends EventKindV1>(
  events: readonly PublishableEventV1[],
  kind: K,
): PublishableEventV1<K> | undefined {
  return events.find((event): event is PublishableEventV1<K> => event.kind === kind);
}

// --- project.close ---------------------------------------------------------------------------

describe("project.close", () => {
  test("started admission (beginClose) then finishClose once the lease releases", async () => {
    await context.start(async () => {
      const harness = buildTestContext();
      harness.machines.project.apply("beginOpen");
      harness.machines.project.apply("finishOpen"); // precondition: "ready", matching what the guard already confirmed

      const outcome = projectHandlers["project.close"]({}, harness.handlerContext);

      expect(outcome.disposition).toBe("started");
      expect(outcome.operationId).toBeDefined();
      expect(outcome.events).toHaveLength(1);
      expectValidEvent(outcome.events[0]!);
      expect(outcome.events[0]!.payload).toMatchObject({
        modelId: "kernel.project.state",
        action: "kernel.project.beginClose",
        previousTag: "ready",
        nextTag: "closing",
      });

      const launches = harness.getLaunchOperations();
      expect(launches).toHaveLength(1);
      expect(launches[0]!.label).toBe("kernel.project.close");

      const terminalEvents = await wrap(launches[0]!.run());

      expect(terminalEvents).toHaveLength(1);
      expectValidEvent(terminalEvents[0]!);
      expect(terminalEvents[0]!.payload).toMatchObject({
        action: "kernel.project.finishClose",
        previousTag: "closing",
        nextTag: "closed",
        // §10 smoke closeout (bug 2): a project-scoped identity must not outlive the
        // project it belongs to — mirrors this same event's own `finishOpen` counterpart.
        metadata: { projectId: null },
      });
      expect(harness.machines.project.phase()).toBe("closed");
      expect(harness.getPreviewSession()).toBeNull();
      expect(harness.deps.projectStore.close).toBeDefined();
    });
  });
});

// --- project.setTrust -------------------------------------------------------------------------

describe("project.setTrust", () => {
  test("flips the trust flag synchronously, then durably persists the grant", async () => {
    await context.start(async () => {
      const harness = buildTestContext();
      harness.machines.project.apply("beginOpen");
      harness.machines.project.apply("finishOpen"); // precondition: "ready"

      const payload: CommandPayloadByKindV1["project.setTrust"] = {
        trust: "trusted",
        workspaceIdentity: "ws-1",
      };
      const outcome = projectHandlers["project.setTrust"](payload, harness.handlerContext);

      expect(outcome.disposition).toBe("started");
      // Gap A (spec §2.2): granting trust on an already-open project ALSO enables preview
      // synchronously, in the same admission — `enablePreviewIfTrusted`'s second call site.
      expect(outcome.events).toHaveLength(2);
      for (const event of outcome.events) expectValidEvent(event);
      expect(outcome.events[0]!.payload).toMatchObject({
        action: "kernel.project.setTrust",
        previousTag: "ready",
        nextTag: "ready",
        // §10 smoke closeout (bug 2): the just-flipped trust decision rides this event's
        // own metadata too, alongside the pre-existing `workspaceIdentity` — the channel an
        // already-subscribed `ui/mirror` reads to leave `trust-prompt`/`read-only` for
        // `workspace` (`./project.ts`'s header).
        metadata: { workspaceIdentity: "ws-1", trust: "trusted" },
      });
      expect(outcome.events[1]!.payload).toMatchObject({
        modelId: "kernel.preview.state",
        action: "kernel.preview.enable",
        previousTag: "disabled",
        nextTag: "idle",
      });
      // The Kernel-visible trust flag is already flipped BEFORE the async operation runs.
      expect(harness.getTrust()).toBe("trusted");
      expect(harness.machines.preview.phase()).toBe("idle");

      const launches = harness.getLaunchOperations();
      expect(launches).toHaveLength(1);
      const terminalEvents = await wrap(launches[0]!.run());

      expect(terminalEvents).toEqual([]);
    });
  });

  test("an untrusted-read-only decision never durably grants", async () => {
    await context.start(async () => {
      const trustGate = createFakeTrustGate();
      const harness = buildTestContext({ trustGate });
      harness.machines.project.apply("beginOpen");
      harness.machines.project.apply("finishOpen");

      const payload: CommandPayloadByKindV1["project.setTrust"] = {
        trust: "untrusted-read-only",
        workspaceIdentity: "ws-1",
      };
      projectHandlers["project.setTrust"](payload, harness.handlerContext);
      expect(harness.getTrust()).toBe("untrusted-read-only");

      const launches = harness.getLaunchOperations();
      await wrap(launches[0]!.run());

      expect(trustGate.calls.some((call) => call.method === "grant")).toBe(false);
    });
  });
});

// --- project.create ----------------------------------------------------------------------------

describe("project.create", () => {
  test("started admission (beginCreate) then a full open sequence to ready", async () => {
    await context.start(async () => {
      const home = slug("home");
      const projectStore = createFakeProjectStore({
        root: "/fake-root",
        manifest: { projectId: "fake-project-1", pages: [home] },
        workspaceState: { activePageSlug: null, activeChatId: null },
      });
      const pageReader = createFakePageStore({
        order: [home],
        sources: new Map([
          [
            home,
            {
              bytes: new TextEncoder().encode("export const meta = {}"),
              sourceHash: FAKE_SOURCE_HASH,
            },
          ],
        ]),
      });
      const trustGate = createFakeTrustGate();
      const harness = buildTestContext({ projectStore, pageReader, trustGate });

      const payload: CommandPayloadByKindV1["project.create"] = {
        root: "/fake-root",
        creationDefaults: { trust: "trusted", workspaceIdentity: "ws-1" },
        text: "hello",
      };
      const outcome = projectHandlers["project.create"](payload, harness.handlerContext);

      expect(outcome.disposition).toBe("started");
      expect(outcome.events).toHaveLength(1);
      expectValidEvent(outcome.events[0]!);
      expect(outcome.events[0]!.payload).toMatchObject({
        action: "kernel.project.beginCreate",
        previousTag: "closed",
        nextTag: "opening",
      });

      const launches = harness.getLaunchOperations();
      expect(launches).toHaveLength(1);
      expect(launches[0]!.label).toBe("kernel.project.beginCreate");

      const terminalEvents = await wrap(launches[0]!.run());

      // Gap A (spec §2.2): a trusted project's ready sequence now enables preview FIRST — after
      // trust, before the page descriptors and `finishOpen` that follow it.
      expect(terminalEvents).toHaveLength(3);
      for (const event of terminalEvents) expectValidEvent(event);

      expect(terminalEvents[0]!.kind).toBe("kernel.stateChanged");
      expect(terminalEvents[0]!.payload).toMatchObject({
        modelId: "kernel.preview.state",
        action: "kernel.preview.enable",
        previousTag: "disabled",
        nextTag: "idle",
      });

      expect(terminalEvents[1]!.kind).toBe("page.descriptorsChanged");
      expect(terminalEvents[1]!.payload).toMatchObject({
        reason: "project-open",
        activePageSlug: home,
      });
      const descriptorsPayload = terminalEvents[1]!.payload;
      if (descriptorsPayload === null || !("descriptors" in descriptorsPayload)) {
        throw new Error("expected a page.descriptorsChanged payload");
      }
      expect(descriptorsPayload.descriptors).toHaveLength(1);

      expect(terminalEvents[2]!.kind).toBe("kernel.stateChanged");
      expect(terminalEvents[2]!.payload).toMatchObject({
        action: "kernel.project.finishOpen",
        previousTag: "opening",
        nextTag: "ready",
        // §10 smoke closeout (bug 2): the just-opened project's real identity now rides
        // this event's own metadata — the ONE channel an already-subscribed client (never
        // sent a second kernel.snapshot) or `ui/mirror`'s own `apply()` can observe it
        // through. See `./project.ts`'s header for the full rationale.
        metadata: { projectId: "fake-project-1", trust: "trusted" },
      });

      expect(harness.machines.project.phase()).toBe("ready");
      expect(harness.machines.preview.phase()).toBe("idle");
      expect(harness.getTrust()).toBe("trusted");
      expect(trustGate.calls.some((call) => call.method === "grant")).toBe(true);
    });
  });

  test("blocks (does not durably grant) when the manifest cannot be read", async () => {
    await context.start(async () => {
      const projectStore = createFakeProjectStore({ root: "/fake-root" });
      projectStore.failNext("readManifest", FAILURE);
      const harness = buildTestContext({ projectStore });

      const payload: CommandPayloadByKindV1["project.create"] = {
        root: "/fake-root",
        creationDefaults: { trust: "trusted", workspaceIdentity: "ws-1" },
        text: "hello",
      };
      projectHandlers["project.create"](payload, harness.handlerContext);

      const launches = harness.getLaunchOperations();
      const terminalEvents = await wrap(launches[0]!.run());

      expect(terminalEvents).toHaveLength(1);
      expectValidEvent(terminalEvents[0]!);
      expect(terminalEvents[0]!.payload).toMatchObject({
        action: "kernel.project.blockOpen",
        previousTag: "opening",
        nextTag: "blocked",
      });
      const blockedPayload = terminalEvents[0]!.payload;
      if (blockedPayload === null || !("metadata" in blockedPayload)) {
        throw new Error("expected a kernel.stateChanged payload");
      }
      expect((blockedPayload.metadata as { reason: string }).reason).toBe("manifest-read-failed");
      expect(harness.machines.project.phase()).toBe("blocked");
      expect(harness.getTrust()).toBeNull();
    });
  });
});

// --- project.open ------------------------------------------------------------------------------

describe("project.open", () => {
  test("resolves to trusted when a prior grant already covers this exact subject", async () => {
    await context.start(async () => {
      const home = slug("home");
      const projectStore = createFakeProjectStore({
        root: "/fake-root",
        manifest: { projectId: "fake-project-1", pages: [home] },
        workspaceState: { activePageSlug: home, activeChatId: null },
      });
      const pageReader = createFakePageStore({
        order: [home],
        sources: new Map([
          [
            home,
            {
              bytes: new TextEncoder().encode("export const meta = {}"),
              sourceHash: FAKE_SOURCE_HASH,
            },
          ],
        ]),
      });
      const trustGate = createFakeTrustGate();
      const subject = await trustGate.buildSubject("/fake-root", "fake-project-1", null);
      if ("code" in subject) throw new Error("unexpected failure building the fake subject");
      await trustGate.grant(subject);

      const harness = buildTestContext({ projectStore, pageReader, trustGate });

      const outcome = projectHandlers["project.open"](
        { root: "/fake-root" },
        harness.handlerContext,
      );
      expect(outcome.events[0]!.payload).toMatchObject({
        action: "kernel.project.beginOpen",
        previousTag: "closed",
        nextTag: "opening",
      });

      const launches = harness.getLaunchOperations();
      const terminalEvents = await wrap(launches[0]!.run());
      for (const event of terminalEvents) expectValidEvent(event);

      expect(harness.getTrust()).toBe("trusted");
      expect(harness.machines.project.phase()).toBe("ready");
    });
  });

  test("opens ready but untrusted-read-only with no prior grant and no interactive channel", async () => {
    await context.start(async () => {
      const home = slug("home");
      const projectStore = createFakeProjectStore({
        root: "/fake-root",
        manifest: { projectId: "fake-project-1", pages: [home] },
        workspaceState: { activePageSlug: home, activeChatId: null },
      });
      const pageReader = createFakePageStore({
        order: [home],
        sources: new Map([
          [
            home,
            {
              bytes: new TextEncoder().encode("export const meta = {}"),
              sourceHash: FAKE_SOURCE_HASH,
            },
          ],
        ]),
      });
      const harness = buildTestContext({ projectStore, pageReader });

      projectHandlers["project.open"]({ root: "/fake-root" }, harness.handlerContext);
      const launches = harness.getLaunchOperations();
      const terminalEvents = await wrap(launches[0]!.run());
      for (const event of terminalEvents) expectValidEvent(event);

      expect(harness.getTrust()).toBe("untrusted-read-only");
      expect(harness.machines.project.phase()).toBe("ready");
    });
  });

  // --- WP-5 Phase C task C4 (D-Q3): TD §12 step 9's export pointer, validated on the LIVE
  // --- production open path (this file's header explains why `runOpenSequence` — which
  // --- validates the same fact, task C3 — is never called here) --------------------------

  test("blocks with reason 'export-pointer-read-failed' when the export pointer is corrupt", async () => {
    await context.start(async () => {
      const home = slug("home");
      const projectStore = createFakeProjectStore({
        root: "/fake-root",
        manifest: { projectId: "fake-project-1", pages: [home] },
        workspaceState: { activePageSlug: home, activeChatId: null },
      });
      const pageReader = createFakePageStore({
        order: [home],
        sources: new Map([
          [
            home,
            {
              bytes: new TextEncoder().encode("export const meta = {}"),
              sourceHash: FAKE_SOURCE_HASH,
            },
          ],
        ]),
      });
      const exportPublish = createFakeExportPublish();
      exportPublish.failNextRead(FAILURE);
      const harness = buildTestContext({ projectStore, pageReader, exportPublish });

      projectHandlers["project.open"]({ root: "/fake-root" }, harness.handlerContext);
      const launches = harness.getLaunchOperations();
      const terminalEvents = await wrap(launches[0]!.run());

      expect(terminalEvents).toHaveLength(1);
      expectValidEvent(terminalEvents[0]!);
      expect(terminalEvents[0]!.payload).toMatchObject({
        action: "kernel.project.blockOpen",
        previousTag: "opening",
        nextTag: "blocked",
      });
      const blockedPayload = terminalEvents[0]!.payload;
      if (blockedPayload === null || !("metadata" in blockedPayload)) {
        throw new Error("expected a kernel.stateChanged payload");
      }
      expect((blockedPayload.metadata as { reason: string }).reason).toBe(
        "export-pointer-read-failed",
      );
      expect(harness.machines.project.phase()).toBe("blocked");
    });
  });

  test("a null export pointer (no export published yet) never blocks — the check runs but absent is valid", async () => {
    await context.start(async () => {
      const home = slug("home");
      const projectStore = createFakeProjectStore({
        root: "/fake-root",
        manifest: { projectId: "fake-project-1", pages: [home] },
        workspaceState: { activePageSlug: home, activeChatId: null },
      });
      const pageReader = createFakePageStore({
        order: [home],
        sources: new Map([
          [
            home,
            {
              bytes: new TextEncoder().encode("export const meta = {}"),
              sourceHash: FAKE_SOURCE_HASH,
            },
          ],
        ]),
      });
      const exportPublish = createFakeExportPublish(); // readPointer() defaults to null
      const harness = buildTestContext({ projectStore, pageReader, exportPublish });

      projectHandlers["project.open"]({ root: "/fake-root" }, harness.handlerContext);
      const launches = harness.getLaunchOperations();
      const terminalEvents = await wrap(launches[0]!.run());
      for (const event of terminalEvents) expectValidEvent(event);

      expect(harness.machines.project.phase()).toBe("ready");
      expect(exportPublish.calls.some((call) => call.method === "readPointer")).toBe(true);
    });
  });

  // --- WP-10 Task 6: restoring the active chat's tail on relaunch (§11, M10) -----------------

  test("restores the active chat's persisted tail on relaunch: chat.changed + chat.records after finishOpen, correlated to the open command", async () => {
    await context.start(async () => {
      const home = slug("home");
      const chatId = uuidv7();
      const projectStore = createFakeProjectStore({
        root: "/fake-root",
        manifest: { projectId: "fake-project-1", pages: [home] },
        workspaceState: { activePageSlug: home, activeChatId: chatId },
      });
      const pageReader = createFakePageStore({
        order: [home],
        sources: new Map([
          [
            home,
            {
              bytes: new TextEncoder().encode("export const meta = {}"),
              sourceHash: FAKE_SOURCE_HASH,
            },
          ],
        ]),
      });
      const header: ChatHeaderV1 = { chatId, createdAt: "2024-06-01T00:00:00.000Z" };
      const userRecordId = uuidv7();
      const userTurnId = uuidv7();
      const chatReader = createChatReaderStub(chatId, header, {
        records: [
          {
            kind: "user",
            recordId: userRecordId,
            turnId: userTurnId,
            text: "Restore my chat",
            ts: "2024-06-01T00:00:01.000Z",
          },
        ],
        prevCursor: null,
      });
      const harness = buildTestContext({ projectStore, pageReader, chatReader });

      const outcome = projectHandlers["project.open"](
        { root: "/fake-root" },
        harness.handlerContext,
      );
      expect(outcome.operationId).toBeDefined();

      const launches = harness.getLaunchOperations();
      const terminalEvents = await wrap(launches[0]!.run());
      for (const event of terminalEvents) expectValidEvent(event);

      expect(chatReader.calls).toEqual([{ method: "open", chatId }]);
      expect(harness.machines.project.phase()).toBe("ready");

      // page.descriptorsChanged, kernel.stateChanged(finishOpen), chat.changed, chat.records —
      // the chat tail is restored AFTER finishOpen, matching this file's own header comment.
      expect(terminalEvents).toHaveLength(4);
      expect(terminalEvents[0]!.kind).toBe("page.descriptorsChanged");
      expect(terminalEvents[1]!.kind).toBe("kernel.stateChanged");
      expect(terminalEvents[1]!.payload).toMatchObject({ action: "kernel.project.finishOpen" });

      const changedEvent = terminalEvents[2]!;
      expect(changedEvent.kind).toBe("chat.changed");
      expect(changedEvent.payload).toEqual({
        activeChatId: chatId,
        // Task 7 (fix-bundle Gap E): `chat.changed` is now fed entirely by `ChatReader.list()`
        // (`listChatSummaries`) — the project's own on-disk listing, not the tail this test's
        // `chatReader` loaded — and that listing always reports its rows as `added`.
        added: [{ chatId, createdAt: header.createdAt, displayName: "Restore my chat" }],
        updated: [],
        removedChatIds: [],
      });

      const recordsEvent = terminalEvents[3]!;
      expect(recordsEvent.kind).toBe("chat.records");
      expect(recordsEvent.payload).toEqual({
        chatId,
        records: [
          {
            kind: "user",
            recordId: userRecordId,
            turnId: userTurnId,
            text: "Restore my chat",
            selection: null,
            pins: [],
            ts: "2024-06-01T00:00:01.000Z",
          },
        ],
        prevCursor: null,
      });
    });
  });

  test("a null activeChatId (no chat yet) emits neither chat.changed nor chat.records, and still finishes open", async () => {
    await context.start(async () => {
      const home = slug("home");
      const projectStore = createFakeProjectStore({
        root: "/fake-root",
        manifest: { projectId: "fake-project-1", pages: [home] },
        workspaceState: { activePageSlug: home, activeChatId: null },
      });
      const pageReader = createFakePageStore({
        order: [home],
        sources: new Map([
          [
            home,
            {
              bytes: new TextEncoder().encode("export const meta = {}"),
              sourceHash: FAKE_SOURCE_HASH,
            },
          ],
        ]),
      });
      const harness = buildTestContext({ projectStore, pageReader });

      projectHandlers["project.open"]({ root: "/fake-root" }, harness.handlerContext);
      const launches = harness.getLaunchOperations();
      const terminalEvents = await wrap(launches[0]!.run());
      for (const event of terminalEvents) expectValidEvent(event);

      expect(terminalEvents.some((event) => event.kind === "chat.changed")).toBe(false);
      expect(terminalEvents.some((event) => event.kind === "chat.records")).toBe(false);
      expect(harness.machines.project.phase()).toBe("ready");
    });
  });

  test("a tail-load failure for the active chat is logged, costs only chat.records — chat.changed still publishes from the listing", async () => {
    await context.start(async () => {
      const home = slug("home");
      const chatId = uuidv7();
      const projectStore = createFakeProjectStore({
        root: "/fake-root",
        manifest: { projectId: "fake-project-1", pages: [home] },
        workspaceState: { activePageSlug: home, activeChatId: chatId },
      });
      const pageReader = createFakePageStore({
        order: [home],
        sources: new Map([
          [
            home,
            {
              bytes: new TextEncoder().encode("export const meta = {}"),
              sourceHash: FAKE_SOURCE_HASH,
            },
          ],
        ]),
      });
      const header: ChatHeaderV1 = { chatId, createdAt: "2024-06-01T00:00:00.000Z" };
      // `loadTailResult` is a failure — `createChatReaderStub`'s own `list()` therefore reports
      // this chat with `firstUserText: null` (its documented derivation), independent of the
      // tail failure below.
      const chatReader = createChatReaderStub(chatId, header, {
        code: "PERSISTENCE_FAILED",
        retryable: false,
        safeMessage: "disk read failed",
        details: {},
      });
      const harness = buildTestContext({ projectStore, pageReader, chatReader });
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      projectHandlers["project.open"]({ root: "/fake-root" }, harness.handlerContext);
      const launches = harness.getLaunchOperations();
      const terminalEvents = await wrap(launches[0]!.run());
      for (const event of terminalEvents) expectValidEvent(event);

      expect(warnSpy).toHaveBeenCalled();
      const changed = findEvent(terminalEvents, "chat.changed");
      expect(changed?.payload).toEqual({
        activeChatId: chatId,
        added: [{ chatId, createdAt: header.createdAt, displayName: null }],
        updated: [],
        removedChatIds: [],
      });
      expect(terminalEvents.some((event) => event.kind === "chat.records")).toBe(false);
      expect(harness.machines.project.phase()).toBe("ready");
      warnSpy.mockRestore();
    });
  });

  // --- fix-bundle Task 7 (Gap E, spec §2.1): the ready sequence publishes the real chat list ---

  test("publishes one chat.changed row per chat on disk, named from each chat's first user record", async () => {
    await context.start(async () => {
      const home = slug("home");
      const chatA = uuidv7();
      const chatB = uuidv7();
      const chatC = uuidv7();
      const projectStore = createFakeProjectStore({
        root: "/fake-root",
        manifest: { projectId: "fake-project-1", pages: [home] },
        workspaceState: { activePageSlug: home, activeChatId: chatA },
      });
      const pageReader = createFakePageStore({
        order: [home],
        sources: new Map([
          [
            home,
            {
              bytes: new TextEncoder().encode("export const meta = {}"),
              sourceHash: FAKE_SOURCE_HASH,
            },
          ],
        ]),
      });
      const chatReader: ChatReader = {
        ...createFakeChatStore(),
        async list() {
          return [
            {
              chatId: chatA,
              createdAt: "2026-07-24T10:00:00.000Z",
              firstUserText: "build a system monitor\nwith gauges",
            },
            { chatId: chatB, createdAt: "2026-07-25T10:00:00.000Z", firstUserText: null },
            {
              chatId: chatC,
              createdAt: "2026-07-26T10:00:00.000Z",
              firstUserText: "add a network sparkline",
            },
          ];
        },
      };
      const harness = buildTestContext({ projectStore, pageReader, chatReader });

      projectHandlers["project.open"]({ root: "/fake-root" }, harness.handlerContext);
      const launches = harness.getLaunchOperations();
      const terminalEvents = await wrap(launches[0]!.run());
      for (const event of terminalEvents) expectValidEvent(event);

      const changed = findEvent(terminalEvents, "chat.changed");
      expect(changed?.payload.added).toEqual([
        {
          chatId: chatA,
          createdAt: "2026-07-24T10:00:00.000Z",
          displayName: "build a system monitor",
        },
        { chatId: chatB, createdAt: "2026-07-25T10:00:00.000Z", displayName: null },
        {
          chatId: chatC,
          createdAt: "2026-07-26T10:00:00.000Z",
          displayName: "add a network sparkline",
        },
      ]);
    });
  });

  test("a tail failure costs only the scrollback — the chat list still publishes", async () => {
    await context.start(async () => {
      const home = slug("home");
      const chatA = uuidv7();
      const projectStore = createFakeProjectStore({
        root: "/fake-root",
        manifest: { projectId: "fake-project-1", pages: [home] },
        workspaceState: { activePageSlug: home, activeChatId: chatA },
      });
      const pageReader = createFakePageStore({
        order: [home],
        sources: new Map([
          [
            home,
            {
              bytes: new TextEncoder().encode("export const meta = {}"),
              sourceHash: FAKE_SOURCE_HASH,
            },
          ],
        ]),
      });
      const chatReader: ChatReader = {
        ...createFakeChatStore(),
        async list() {
          return [{ chatId: chatA, createdAt: "2026-07-24T10:00:00.000Z", firstUserText: "hi" }];
        },
        async open() {
          return FAILURE;
        },
      };
      const harness = buildTestContext({ projectStore, pageReader, chatReader });
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      projectHandlers["project.open"]({ root: "/fake-root" }, harness.handlerContext);
      const launches = harness.getLaunchOperations();
      const terminalEvents = await wrap(launches[0]!.run());
      for (const event of terminalEvents) expectValidEvent(event);

      expect(terminalEvents.some((event) => event.kind === "chat.changed")).toBe(true);
      expect(terminalEvents.some((event) => event.kind === "chat.records")).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  test("a list() failure degrades to the active chat alone", async () => {
    await context.start(async () => {
      const home = slug("home");
      const activeChatId = uuidv7();
      const projectStore = createFakeProjectStore({
        root: "/fake-root",
        manifest: { projectId: "fake-project-1", pages: [home] },
        workspaceState: { activePageSlug: home, activeChatId },
      });
      const pageReader = createFakePageStore({
        order: [home],
        sources: new Map([
          [
            home,
            {
              bytes: new TextEncoder().encode("export const meta = {}"),
              sourceHash: FAKE_SOURCE_HASH,
            },
          ],
        ]),
      });
      const header: ChatHeaderV1 = {
        chatId: activeChatId,
        createdAt: "2026-07-20T08:00:00.000Z",
      };
      // `list()` fails, but `open()` still succeeds for the active chat — `listChatSummaries`'s
      // fallback reads `createdAt` off the SAME real header `open()` returns, never a call-time
      // clock read (review finding, fix round 1: a fabricated "now" would render a month-old
      // chat as brand new and jump it to the top of the newest-first `/chats` sort).
      const chatReader = createChatReaderStub(activeChatId, header, {
        records: [],
        prevCursor: null,
      });
      chatReader.list = async () => FAILURE;
      const harness = buildTestContext({ projectStore, pageReader, chatReader });
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      projectHandlers["project.open"]({ root: "/fake-root" }, harness.handlerContext);
      const launches = harness.getLaunchOperations();
      const terminalEvents = await wrap(launches[0]!.run());
      for (const event of terminalEvents) expectValidEvent(event);

      const changed = findEvent(terminalEvents, "chat.changed");
      expect(changed?.payload.added).toEqual([
        { chatId: activeChatId, createdAt: header.createdAt, displayName: null },
      ]);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});

// --- project.retryOpen --------------------------------------------------------------------------

describe("project.retryOpen", () => {
  test("routes to the named domain, resolves, and reaches ready", async () => {
    await context.start(async () => {
      const home = slug("home");
      const restoreActionId = uuidv7();
      const projectStore = createFakeProjectStore({
        root: "/fake-root",
        manifest: { projectId: "fake-project-1", pages: [home] },
        workspaceState: { activePageSlug: home, activeChatId: null },
      });
      const pageReader = createFakePageStore({
        order: [home],
        sources: new Map([
          [
            home,
            {
              bytes: new TextEncoder().encode("export const meta = {}"),
              sourceHash: FAKE_SOURCE_HASH,
            },
          ],
        ]),
      });
      const recovery = createFakeRecoveryService({
        classifications: new Map([
          [restoreActionId, { kind: "roll-forward", transactionId: restoreActionId }],
        ]),
      });
      const harness = buildTestContext({ projectStore, pageReader, recovery });

      // Precondition the guard already confirmed: project "blocked", the named domain "blocked" too.
      harness.machines.project.apply("beginOpen");
      harness.machines.project.apply("blockOpen");
      harness.machines.restore.apply("kernel.restore.beginRecovery");
      harness.machines.restore.apply("kernel.restore.blockRecovery");

      const payload: CommandPayloadByKindV1["project.retryOpen"] = {
        recovery: { kind: "restore", restoreActionId },
      };
      const outcome = projectHandlers["project.retryOpen"](payload, harness.handlerContext);

      expect(outcome.disposition).toBe("started");
      expect(outcome.events).toHaveLength(2);
      for (const event of outcome.events) expectValidEvent(event);
      expect(outcome.events[0]!.payload).toMatchObject({
        modelId: "kernel.project.state",
        action: "kernel.project.retryOpen",
        previousTag: "blocked",
        nextTag: "opening",
      });
      expect(outcome.events[1]!.payload).toMatchObject({
        modelId: "kernel.restore.state",
        action: "kernel.restore.retryRecovery",
        previousTag: "blocked",
        nextTag: "recovering",
      });

      const launches = harness.getLaunchOperations();
      const terminalEvents = await wrap(launches[0]!.run());
      for (const event of terminalEvents) expectValidEvent(event);

      expect(terminalEvents[0]!.payload).toMatchObject({
        modelId: "kernel.restore.state",
        action: "kernel.restore.complete",
        previousTag: "recovering",
        nextTag: "idle",
      });
      expect(harness.machines.restore.phase()).toBe("idle");
      expect(harness.machines.project.phase()).toBe("ready");
    });
  });

  test("blocks the domain and the project again when still in conflict", async () => {
    await context.start(async () => {
      const restoreActionId = uuidv7();
      const recovery = createFakeRecoveryService({
        classifications: new Map([
          [
            restoreActionId,
            { kind: "conflict", transactionId: restoreActionId, reason: "test-conflict" },
          ],
        ]),
      });
      const harness = buildTestContext({ recovery });

      harness.machines.project.apply("beginOpen");
      harness.machines.project.apply("blockOpen");
      harness.machines.restore.apply("kernel.restore.beginRecovery");
      harness.machines.restore.apply("kernel.restore.blockRecovery");

      const payload: CommandPayloadByKindV1["project.retryOpen"] = {
        recovery: { kind: "restore", restoreActionId },
      };
      projectHandlers["project.retryOpen"](payload, harness.handlerContext);

      const launches = harness.getLaunchOperations();
      const terminalEvents = await wrap(launches[0]!.run());
      for (const event of terminalEvents) expectValidEvent(event);

      expect(terminalEvents).toHaveLength(2);
      expect(terminalEvents[0]!.payload).toMatchObject({
        modelId: "kernel.restore.state",
        action: "kernel.restore.blockRecovery",
        previousTag: "recovering",
        nextTag: "blocked",
      });
      expect(terminalEvents[1]!.payload).toMatchObject({
        modelId: "kernel.project.state",
        action: "kernel.project.blockOpen",
        previousTag: "opening",
        nextTag: "blocked",
      });
      expect(harness.machines.restore.phase()).toBe("blocked");
      expect(harness.machines.project.phase()).toBe("blocked");
    });
  });

  test("an idempotent refusal when the named domain's own phase is inconsistent — nothing moves", async () => {
    await context.start(async () => {
      const harness = buildTestContext();

      harness.machines.project.apply("beginOpen");
      harness.machines.project.apply("blockOpen"); // project: "blocked"
      // restore machine deliberately left at "idle" — inconsistent with the project's own
      // "blocked" phase; `kernel.restore.retryRecovery` is illegal from "idle".

      const payload: CommandPayloadByKindV1["project.retryOpen"] = {
        recovery: { kind: "restore", restoreActionId: uuidv7() },
      };
      const outcome = projectHandlers["project.retryOpen"](payload, harness.handlerContext);

      expect(outcome).toEqual({ disposition: "no-op", events: [] });
      expect(harness.getLaunchOperations()).toHaveLength(0);
      // Atomicity: the project machine must NOT have moved either, even though ITS OWN
      // `retryOpen` edge was legal in isolation.
      expect(harness.machines.project.phase()).toBe("blocked");
    });
  });
});

// --- fix-bundle Task 8 (Gap A, spec §2.2): preview enables once trust resolves ---------------

describe("Gap A — enablePreviewIfTrusted", () => {
  test("enables preview once trust resolves to trusted, before finishOpen", async () => {
    await context.start(async () => {
      const home = slug("home");
      const projectStore = createFakeProjectStore({
        root: "/fake-root",
        manifest: { projectId: "fake-project-1", pages: [home] },
        workspaceState: { activePageSlug: null, activeChatId: null },
      });
      const pageReader = createFakePageStore({
        order: [home],
        sources: new Map([
          [
            home,
            {
              bytes: new TextEncoder().encode("export const meta = {}"),
              sourceHash: FAKE_SOURCE_HASH,
            },
          ],
        ]),
      });
      const trustGate = createFakeTrustGate();
      const harness = buildTestContext({ projectStore, pageReader, trustGate });

      const payload: CommandPayloadByKindV1["project.create"] = {
        root: "/fake-root",
        creationDefaults: { trust: "trusted", workspaceIdentity: "ws-1" },
        text: "hello",
      };
      projectHandlers["project.create"](payload, harness.handlerContext);
      const launches = harness.getLaunchOperations();
      const terminalEvents = await wrap(launches[0]!.run());
      for (const event of terminalEvents) expectValidEvent(event);

      expect(harness.machines.preview.phase()).toBe("idle");

      // `findEvent`-style narrowing (this file's own established idiom) rather than an inline
      // `e.payload.action` check: `PublishableEventV1[]`'s element type is one generic
      // instantiation over the whole `EventKindV1` union, so `payload` does not narrow off a
      // bare `kind ===` comparison without an explicit type predicate.
      const stateChanged = terminalEvents.filter(
        (event): event is PublishableEventV1<"kernel.stateChanged"> =>
          event.kind === "kernel.stateChanged",
      );
      const enableIndex = stateChanged.findIndex(
        (event) => event.payload.action === "kernel.preview.enable",
      );
      const finishIndex = stateChanged.findIndex(
        (event) => event.payload.action === "kernel.project.finishOpen",
      );
      expect(enableIndex).toBeGreaterThanOrEqual(0);
      expect(enableIndex).toBeLessThan(finishIndex);
    });
  });

  test("leaves preview disabled for an untrusted project — preview executes design code", async () => {
    await context.start(async () => {
      const home = slug("home");
      const projectStore = createFakeProjectStore({
        root: "/fake-root",
        manifest: { projectId: "fake-project-1", pages: [home] },
        workspaceState: { activePageSlug: null, activeChatId: null },
      });
      const pageReader = createFakePageStore({
        order: [home],
        sources: new Map([
          [
            home,
            {
              bytes: new TextEncoder().encode("export const meta = {}"),
              sourceHash: FAKE_SOURCE_HASH,
            },
          ],
        ]),
      });
      const harness = buildTestContext({ projectStore, pageReader });

      const payload: CommandPayloadByKindV1["project.create"] = {
        root: "/fake-root",
        creationDefaults: { trust: "untrusted-read-only", workspaceIdentity: "ws-1" },
        text: "hello",
      };
      projectHandlers["project.create"](payload, harness.handlerContext);
      const launches = harness.getLaunchOperations();
      const terminalEvents = await wrap(launches[0]!.run());
      for (const event of terminalEvents) expectValidEvent(event);

      expect(harness.machines.preview.phase()).toBe("disabled");
      expect(harness.machines.project.phase()).toBe("ready");
    });
  });

  test("enables preview when a later project.setTrust grants it", async () => {
    await context.start(async () => {
      const home = slug("home");
      const projectStore = createFakeProjectStore({
        root: "/fake-root",
        manifest: { projectId: "fake-project-1", pages: [home] },
        workspaceState: { activePageSlug: null, activeChatId: null },
      });
      const pageReader = createFakePageStore({
        order: [home],
        sources: new Map([
          [
            home,
            {
              bytes: new TextEncoder().encode("export const meta = {}"),
              sourceHash: FAKE_SOURCE_HASH,
            },
          ],
        ]),
      });
      const harness = buildTestContext({ projectStore, pageReader });

      const createPayload: CommandPayloadByKindV1["project.create"] = {
        root: "/fake-root",
        creationDefaults: { trust: "untrusted-read-only", workspaceIdentity: "ws-1" },
        text: "hello",
      };
      projectHandlers["project.create"](createPayload, harness.handlerContext);
      const createLaunches = harness.getLaunchOperations();
      await wrap(createLaunches[0]!.run());
      expect(harness.machines.preview.phase()).toBe("disabled");
      expect(harness.machines.project.phase()).toBe("ready");

      const setTrustPayload: CommandPayloadByKindV1["project.setTrust"] = {
        trust: "trusted",
        workspaceIdentity: "ws-1",
      };
      projectHandlers["project.setTrust"](setTrustPayload, harness.handlerContext);

      expect(harness.machines.preview.phase()).toBe("idle");
    });
  });

  test("a page-list failure after trust resolves still publishes the already-applied preview.enable transition", async () => {
    await context.start(async () => {
      const home = slug("home");
      const projectStore = createFakeProjectStore({
        root: "/fake-root",
        manifest: { projectId: "fake-project-1", pages: [home] },
        workspaceState: { activePageSlug: null, activeChatId: null },
      });
      const pageReader = createFakePageStore({ order: [home] });
      pageReader.failNext("listSlugs", FAILURE);
      const harness = buildTestContext({ projectStore, pageReader });

      const payload: CommandPayloadByKindV1["project.create"] = {
        root: "/fake-root",
        creationDefaults: { trust: "trusted", workspaceIdentity: "ws-1" },
        text: "hello",
      };
      projectHandlers["project.create"](payload, harness.handlerContext);
      const launches = harness.getLaunchOperations();
      const terminalEvents = await wrap(launches[0]!.run());
      for (const event of terminalEvents) expectValidEvent(event);

      // The `disabled -> idle` transition already happened (a REAL machine mutation) before
      // `listSlugs` ever failed — `runProjectReadySequence`'s `page-list-failed` exit
      // (`[...events, ...blockOpen(...)]`) must still publish it, or the Kernel's true state
      // (preview now `idle`) would desync from what every subscriber was told (still
      // `disabled`). This is the invariant the hoisted `events` declaration depends on; any
      // future early return added between the hoist and this exit must carry `events` forward
      // the same way, or this test catches the regression.
      expect(harness.machines.preview.phase()).toBe("idle");
      expect(terminalEvents).toHaveLength(2);
      expect(terminalEvents[0]!.payload).toMatchObject({
        modelId: "kernel.preview.state",
        action: "kernel.preview.enable",
        previousTag: "disabled",
        nextTag: "idle",
      });
      expect(terminalEvents[1]!.payload).toMatchObject({
        action: "kernel.project.blockOpen",
        previousTag: "opening",
        nextTag: "blocked",
      });
      const blockedPayload = terminalEvents[1]!.payload;
      if (blockedPayload === null || !("metadata" in blockedPayload)) {
        throw new Error("expected a kernel.stateChanged payload");
      }
      expect((blockedPayload.metadata as { reason: string }).reason).toBe("page-list-failed");
      expect(harness.machines.project.phase()).toBe("blocked");
    });
  });
});
