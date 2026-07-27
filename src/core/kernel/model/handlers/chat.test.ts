import { describe, expect, spyOn, test } from "bun:test";

import { atom, context, wrap } from "@reatom/core";

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
import type {
  ChatHandleV1,
  ChatHeaderV1,
  ChatLoadResultV1,
  ChatMutations,
  ChatReader,
} from "core/ports";
import {
  type FakeChatStore,
  type FakeProjectStore,
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
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

import type { KernelDeps } from "../../types";
import { chatHandlers } from "./chat";
import type { HandlerContext, PreviewSourceKindV1, ProjectTrustV1 } from "./types";

/**
 * `chat.ts`'s own test suite (kernel-assembly WP-1 task 9, Step B — `chat` family).
 *
 * Two kinds of `ChatMutations` double are used, deliberately, not one:
 *
 * - {@link createFakeChatStore} (`core/ports/fakes`), the SHARED oracle fake, for every
 *   test that only cares about CALL WIRING (which method was called, with which
 *   argument, how many times) and FAILURE PROPAGATION (`failNext`) — its own returned
 *   `chatId` format never matters for those assertions.
 * - {@link createChatMutationsStub}, a small LOCAL double defined in this file, for the
 *   two tests that must additionally validate an emitted event's payload against
 *   `eventPayloadV1SchemaByKind` (the task brief's own requirement: "validate emitted
 *   payloads against the protocol schemas ... not just count events"). This is
 *   necessary because `createFakeChatStore`'s own `create()` mints `chatId` as
 *   `` `fake-chat-${n}` `` (`chat-store.ts`'s own source) — a readable test id, not a
 *   canonical UUIDv7 — so feeding it straight into `chatChangedPayloadV1Schema`
 *   (`activeChatId`/`chatId: uuidv7Schema`, `core/protocol/model/event-payload.ts`)
 *   would fail on ID FORMAT alone, never on anything this handler actually gets wrong.
 *   In production this gap does not exist: a real `ChatMutations` adapter mints a real
 *   UUIDv7 (`infrastructure/uuid`'s `uuidv7()`, used everywhere else in this codebase for
 *   exactly this purpose) the same way `chat.switch`'s `payload.chatId` already arrives
 *   pre-validated as a canonical UUIDv7 by `decodeCommandEnvelope` before this handler is
 *   ever reached. The local stub simply stands in for that real adapter behavior; it is
 *   not a second, competing fake for `core/ports/fakes` to reconcile with, and this file
 *   never edits `chat-store.ts` to "fix" its id format, matching this task's own
 *   deliverable boundary (`chat.ts` + `chat.test.ts` only).
 *
 * WP-10 Task 5 adds a THIRD local double, {@link createChatReaderStub}, for the same
 * reason as `createChatMutationsStub`: `createFakeChatStore`'s own `open()` only
 * recognizes a chatId it minted itself via `create()` (`fake-chat-N` format), so a test
 * that needs `ChatReader.open` to recognize an arbitrary, schema-valid UUIDv7 chatId
 * (to validate the resulting `chat.changed`/`chat.records` payloads against their real
 * protocol schemas) needs a purpose-built single-chat reader instead.
 */

function slugClock(): Clock {
  return { now: () => new Date(1_700_000_000_000) };
}

interface ChatMutationsStubCall {
  readonly method: "create" | "switchActive";
  readonly chatId?: string;
}

/** A minimal, locally-defined `ChatMutations` double — see this file's header comment for why. */
function createChatMutationsStub(options?: {
  readonly createResult?: () => Promise<FailureDtoV1 | ChatHeaderV1>;
  readonly switchResult?: (chatId: string) => Promise<FailureDtoV1 | undefined>;
}): ChatMutations & { readonly calls: readonly ChatMutationsStubCall[] } {
  const calls: ChatMutationsStubCall[] = [];
  return {
    calls,
    async create(): Promise<FailureDtoV1 | ChatHeaderV1> {
      calls.push({ method: "create" });
      if (options?.createResult !== undefined) return options.createResult();
      return { chatId: uuidv7(), createdAt: "2024-01-01T00:00:00.000Z" };
    },
    async switchActive(chatId: string): Promise<FailureDtoV1 | undefined> {
      calls.push({ method: "switchActive", chatId });
      if (options?.switchResult !== undefined) return options.switchResult(chatId);
      return undefined;
    },
  };
}

interface ChatReaderStubCall {
  readonly method: "open";
  readonly chatId: string;
}

/** A minimal, single-chat `ChatReader` double — see this file's header comment for why. */
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
      return [];
    },
  };
}

interface LaunchedOperation {
  readonly label: string;
  readonly run: () => Promise<readonly PublishableEventV1[]>;
}

interface TestFixture {
  readonly handlerContext: HandlerContext;
  readonly chatStore: FakeChatStore;
  readonly projectStore: FakeProjectStore;
  readonly getMutatorCalls: () => number;
  readonly getLaunches: () => readonly LaunchedOperation[];
}

/** Builds a real `HandlerContext` over the shared `core/ports/fakes` set — matches `deferred.test.ts`/`index.test.ts`'s own `buildTestContext` shape. */
function buildTestContext(overrides?: {
  readonly chatMutations?: ChatMutations;
  readonly chatReader?: ChatReader;
}): TestFixture {
  return context.start(() => {
    const chatStore = createFakeChatStore({ clock: slugClock() });
    const projectStore = createFakeProjectStore({ root: "/test-root" });
    const pageStore = createFakePageStore({ order: [] });
    const pinStore = createFakePinStore();
    const clock = slugClock();

    const deps: KernelDeps = {
      projectStore,
      chatReader: overrides?.chatReader ?? chatStore,
      chatMutations: overrides?.chatMutations ?? chatStore,
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
      chatStore,
      projectStore,
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

describe("chatHandlers['chat.create']", () => {
  test("returns a synchronous started outcome with no admission events, launches exactly one operation, and never touches a Kernel-held mutator", () => {
    const { handlerContext, getLaunches, getMutatorCalls } = buildTestContext();

    const outcome = chatHandlers["chat.create"]({}, handlerContext);

    expect(outcome).toEqual({ disposition: "started", events: [] });
    expect(getLaunches()).toHaveLength(1);
    expect(getMutatorCalls()).toBe(0);
  });

  test("its launched operation calls ChatMutations.create exactly once and publishes a chat.changed event plus an empty chat.records event", async () => {
    const { handlerContext, chatStore, getLaunches } = buildTestContext();

    chatHandlers["chat.create"]({}, handlerContext);
    const launch = onlyLaunch(getLaunches());

    const events = await launch.run();

    expect(chatStore.calls).toEqual([{ method: "create" }]);
    expect(events).toHaveLength(2);

    const changedEvent = events[0]!;
    expect(changedEvent.kind).toBe("chat.changed");
    const payload = changedEvent.payload as {
      readonly activeChatId: string;
      readonly added: readonly {
        readonly chatId: string;
        readonly createdAt: string;
        readonly displayName: string | null;
      }[];
      readonly updated: readonly unknown[];
      readonly removedChatIds: readonly unknown[];
    };
    expect(payload.updated).toEqual([]);
    expect(payload.removedChatIds).toEqual([]);
    expect(payload.added).toHaveLength(1);
    expect(payload.added[0]?.chatId).toBe(payload.activeChatId);
    expect(payload.added[0]?.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(payload.added[0]?.displayName).toBeNull();

    const recordsEvent = events[1]!;
    expect(recordsEvent.kind).toBe("chat.records");
    expect(recordsEvent.payload).toEqual({
      chatId: payload.activeChatId,
      records: [],
      prevCursor: null,
    });
  });

  test("its launched operation persists the newly created chat as active via ProjectStore.writeWorkspaceState — so turn.start's durable read sees it right after /new (seam finding, no-turn-after-create regression)", async () => {
    const { handlerContext, projectStore, getLaunches } = buildTestContext();

    chatHandlers["chat.create"]({}, handlerContext);
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    const changedEvent = events[0]!;
    const payload = changedEvent.payload as { readonly activeChatId: string };

    expect(projectStore.calls).toEqual([
      { method: "writeWorkspaceState", patch: { activeChatId: payload.activeChatId } },
    ]);

    const readBack = await projectStore.readWorkspaceState();
    if ("code" in readBack) throw new Error("expected a successful workspace state read");
    expect(readBack.state.activeChatId).toBe(payload.activeChatId);
  });

  test("when the create succeeds but persisting it via ProjectStore.writeWorkspaceState fails, its launched operation still logs the persistence failure and still publishes chat.changed + chat.records", async () => {
    const { handlerContext, projectStore, getLaunches } = buildTestContext();
    const persistFailure: FailureDtoV1 = {
      code: "PERSISTENCE_FAILED",
      retryable: true,
      safeMessage: "workspace.local.toml locked",
      details: {},
    };
    projectStore.failNext("writeWorkspaceState", persistFailure);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    chatHandlers["chat.create"]({}, handlerContext);
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    expect(warnSpy).toHaveBeenCalled();
    expect(events).toHaveLength(2);
    expect(events[0]!.kind).toBe("chat.changed");
    expect(events[1]!.kind).toBe("chat.records");
    warnSpy.mockRestore();
  });

  test("its launched operation, given a real ChatMutations.create response, publishes chat.changed and chat.records payloads that both parse against eventPayloadV1SchemaByKind", async () => {
    const stub = createChatMutationsStub();
    const { handlerContext, getLaunches } = buildTestContext({ chatMutations: stub });

    chatHandlers["chat.create"]({}, handlerContext);
    const launch = onlyLaunch(getLaunches());

    const events = await launch.run();

    expect(events).toHaveLength(2);
    expect(events[0]!.kind).toBe("chat.changed");
    expect(events[1]!.kind).toBe("chat.records");
    for (const event of events) {
      const schema =
        eventPayloadV1SchemaByKind[event.kind as keyof typeof eventPayloadV1SchemaByKind];
      expect(schema.safeParse(event.payload).success).toBe(true);
    }
  });

  test("when ChatMutations.create fails, its launched operation logs the failure and resolves with no events", async () => {
    const failure: FailureDtoV1 = {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: "disk full",
      details: {},
    };
    const stub = createChatMutationsStub({ createResult: async () => failure });
    const { handlerContext, getLaunches } = buildTestContext({ chatMutations: stub });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    chatHandlers["chat.create"]({}, handlerContext);
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    expect(events).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("chatHandlers['chat.switch']", () => {
  test("returns a synchronous started outcome with no admission events, launches exactly one operation, and never touches a Kernel-held mutator", () => {
    const { handlerContext, getLaunches, getMutatorCalls } = buildTestContext();

    const outcome = chatHandlers["chat.switch"]({ chatId: uuidv7() }, handlerContext);

    expect(outcome).toEqual({ disposition: "started", events: [] });
    expect(getLaunches()).toHaveLength(1);
    expect(getMutatorCalls()).toBe(0);
  });

  test("its launched operation switches the active chat, persists it via ProjectStore.writeWorkspaceState, loads the tail, and publishes chat.changed + chat.records — both parsing against eventPayloadV1SchemaByKind", async () => {
    const mutationsStub = createChatMutationsStub();
    const chatId = uuidv7();
    const header: ChatHeaderV1 = { chatId, createdAt: "2024-06-01T00:00:00.000Z" };
    const chatReader = createChatReaderStub(chatId, header, { records: [], prevCursor: null });
    const { handlerContext, projectStore, getLaunches } = buildTestContext({
      chatMutations: mutationsStub,
      chatReader,
    });

    chatHandlers["chat.switch"]({ chatId }, handlerContext);
    const launch = onlyLaunch(getLaunches());

    const events = await launch.run();

    expect(mutationsStub.calls).toEqual([{ method: "switchActive", chatId }]);
    expect(projectStore.calls).toEqual([
      { method: "writeWorkspaceState", patch: { activeChatId: chatId } },
    ]);
    expect(chatReader.calls).toEqual([{ method: "open", chatId }]);
    expect(events).toHaveLength(2);

    const changedEvent = events[0]!;
    expect(changedEvent.kind).toBe("chat.changed");
    expect(eventPayloadV1SchemaByKind["chat.changed"].safeParse(changedEvent.payload).success).toBe(
      true,
    );
    expect(changedEvent.payload).toEqual({
      activeChatId: chatId,
      added: [],
      updated: [{ chatId, createdAt: header.createdAt, displayName: null }],
      removedChatIds: [],
    });

    const recordsEvent = events[1]!;
    expect(recordsEvent.kind).toBe("chat.records");
    expect(eventPayloadV1SchemaByKind["chat.records"].safeParse(recordsEvent.payload).success).toBe(
      true,
    );
    expect(recordsEvent.payload).toEqual({ chatId, records: [], prevCursor: null });
  });

  test("when the tail loads with records, its launched operation maps them in order into chat.records and derives the summary's displayName from the first user record", async () => {
    const mutationsStub = createChatMutationsStub();
    const chatId = uuidv7();
    const header: ChatHeaderV1 = { chatId, createdAt: "2024-06-01T00:00:00.000Z" };
    const userRecordId = uuidv7();
    const userTurnId = uuidv7();
    const agentRecordId = uuidv7();
    const chatReader = createChatReaderStub(chatId, header, {
      records: [
        {
          kind: "user",
          recordId: userRecordId,
          turnId: userTurnId,
          text: "Add a dark theme toggle",
          ts: "2024-06-01T00:00:01.000Z",
        },
        {
          kind: "agent",
          recordId: agentRecordId,
          turnId: userTurnId,
          text: "Done",
          changedPages: [],
          warnings: [],
          ts: "2024-06-01T00:00:02.000Z",
        },
      ],
      prevCursor: null,
    });
    const { handlerContext, getLaunches } = buildTestContext({
      chatMutations: mutationsStub,
      chatReader,
    });

    chatHandlers["chat.switch"]({ chatId }, handlerContext);
    const events = await onlyLaunch(getLaunches()).run();

    expect(events).toHaveLength(2);
    expect(events[0]!.payload).toMatchObject({
      updated: [{ chatId, createdAt: header.createdAt, displayName: "Add a dark theme toggle" }],
    });

    const recordsEvent = events[1]!;
    expect(recordsEvent.kind).toBe("chat.records");
    expect(eventPayloadV1SchemaByKind["chat.records"].safeParse(recordsEvent.payload).success).toBe(
      true,
    );
    expect(recordsEvent.payload).toEqual({
      chatId,
      records: [
        {
          kind: "user",
          recordId: userRecordId,
          turnId: userTurnId,
          text: "Add a dark theme toggle",
          selection: null,
          pins: [],
          ts: "2024-06-01T00:00:01.000Z",
        },
        {
          kind: "agent",
          recordId: agentRecordId,
          turnId: userTurnId,
          text: "Done",
          changedPages: [],
          warnings: [],
          ts: "2024-06-01T00:00:02.000Z",
        },
      ],
      prevCursor: null,
    });
  });

  test("when loading the tail fails, its launched operation still publishes only chat.changed (no summary, no chat.records) and logs the failure", async () => {
    const mutationsStub = createChatMutationsStub();
    const chatId = uuidv7();
    const chatReader = createChatReaderStub(
      chatId,
      { chatId, createdAt: "2024-06-01T00:00:00.000Z" },
      {
        code: "PERSISTENCE_FAILED",
        retryable: false,
        safeMessage: "disk read failed",
        details: {},
      },
    );
    const { handlerContext, getLaunches } = buildTestContext({
      chatMutations: mutationsStub,
      chatReader,
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    chatHandlers["chat.switch"]({ chatId }, handlerContext);
    const events = await onlyLaunch(getLaunches()).run();

    expect(warnSpy).toHaveBeenCalled();
    const event = onlyEvent(events);
    expect(event.kind).toBe("chat.changed");
    expect(event.payload).toEqual({
      activeChatId: chatId,
      added: [],
      updated: [],
      removedChatIds: [],
    });
    warnSpy.mockRestore();
  });

  test("when ChatMutations.switchActive fails (unknown chatId), its launched operation logs the failure, never persists to ProjectStore, and resolves with no events", async () => {
    const { handlerContext, chatStore, projectStore, getLaunches } = buildTestContext();
    const chatId = uuidv7();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    chatHandlers["chat.switch"]({ chatId }, handlerContext);
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    expect(chatStore.calls).toEqual([{ method: "switchActive", chatId }]);
    expect(projectStore.calls).toEqual([]);
    expect(events).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("when the switch succeeds but persisting it via ProjectStore.writeWorkspaceState fails, its launched operation still logs the persistence failure and still publishes the chat.changed event", async () => {
    const stub = createChatMutationsStub();
    const { handlerContext, projectStore, getLaunches } = buildTestContext({ chatMutations: stub });
    const chatId = uuidv7();
    const persistFailure: FailureDtoV1 = {
      code: "PERSISTENCE_FAILED",
      retryable: true,
      safeMessage: "workspace.local.toml locked",
      details: {},
    };
    projectStore.failNext("writeWorkspaceState", persistFailure);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    chatHandlers["chat.switch"]({ chatId }, handlerContext);
    const launch = onlyLaunch(getLaunches());
    const events = await launch.run();

    expect(warnSpy).toHaveBeenCalled();
    const event = onlyEvent(events);
    expect(event.kind).toBe("chat.changed");
    expect(event.payload).toEqual({
      activeChatId: chatId,
      added: [],
      updated: [],
      removedChatIds: [],
    });
    warnSpy.mockRestore();
  });

  test("wraps every port call in its chain — a Reatom write triggered mid-tail-load lands in the ORIGINAL calling frame, never a dropped one (RTM-A04 regression, review finding)", async () => {
    const chatId = uuidv7();
    const header: ChatHeaderV1 = { chatId, createdAt: "2024-06-01T00:00:00.000Z" };
    const mutationsStub = createChatMutationsStub();
    // A dedicated atom this test uses to detect WHICH Reatom frame is active when
    // `ChatReader.open` runs. Each `context.start(...)` frame owns its own isolated atom
    // store (`node_modules/@reatom/core`'s `frame.state.store`) — so a write that lands in
    // the WRONG frame (the shared global default, restored by a raw, unwrapped `await`) is
    // invisible to a reader captured against the RIGHT frame, and vice versa. This is the
    // same isolation `core/chats/model/create.test.ts`'s own header describes for
    // `ChatDirectory`, applied here with a throwaway probe since `chat.switch` itself has no
    // atom of its own to observe.
    const frameMarker = atom(0, "test.chat.switch.frameMarker");
    const chatReader: ChatReader = {
      async open(): Promise<ChatHandleV1> {
        // Written at whatever frame is active the INSTANT `open()` is invoked — the exact
        // point `loadActiveChatTail`'s own `wrap(context.deps.chatReader.open(chatId))`
        // synchronously calls it. If every earlier port call in the chain (`switchActive`,
        // `writeWorkspaceState`) is properly wrapped, that frame is the one this test's own
        // outer `context.start(...)` established below; if either is a raw, unwrapped
        // `await` (the bug this test pins), it is the shared global default instead.
        frameMarker.set(1);
        return {
          header,
          async loadTail() {
            return { records: [], prevCursor: null };
          },
          async loadBefore() {
            throw new Error("not used in this test");
          },
        };
      },
      async readAppendBase() {
        throw new Error("not used in this test");
      },
      async list() {
        throw new Error("not used in this test");
      },
    };

    // Everything synchronous — building the fixture, dispatching `chat.switch`, and
    // STARTING (not awaiting) the launched operation's `run()` — happens inside ONE
    // `context.start(...)` call, matching `create.test.ts`'s own discipline: a
    // `context.start(cb)` frame pops the instant `cb()` returns, so `readMarker` (captured
    // here via `wrap(...)`, which re-associates its own frame on every call regardless of
    // what is later active) is the only safe way to read this frame's state after the fact.
    const { readMarker, callPromise } = context.start(() => {
      const { handlerContext, getLaunches } = buildTestContext({
        chatMutations: mutationsStub,
        chatReader,
      });
      chatHandlers["chat.switch"]({ chatId }, handlerContext);
      const launch = onlyLaunch(getLaunches());
      return { callPromise: launch.run(), readMarker: wrap(() => frameMarker()) };
    });

    await callPromise;

    expect(readMarker()).toBe(1);
  });
});
