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
import type { ChatHeaderV1, ChatMutations } from "core/ports";
import {
  type FakeChatStore,
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
function buildTestContext(overrides?: { readonly chatMutations?: ChatMutations }): TestFixture {
  return context.start(() => {
    const chatStore = createFakeChatStore({ clock: slugClock() });
    const projectStore = createFakeProjectStore({ root: "/test-root" });
    const pageStore = createFakePageStore({ order: [] });
    const pinStore = createFakePinStore();
    const clock = slugClock();

    const deps: KernelDeps = {
      projectStore,
      chatReader: chatStore,
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

  test("its launched operation calls ChatMutations.create exactly once and publishes one internally-consistent chat.changed event", async () => {
    const { handlerContext, chatStore, getLaunches } = buildTestContext();

    chatHandlers["chat.create"]({}, handlerContext);
    const launch = onlyLaunch(getLaunches());

    const events = await launch.run();

    expect(chatStore.calls).toEqual([{ method: "create" }]);
    const event = onlyEvent(events);
    expect(event.kind).toBe("chat.changed");
    const payload = event.payload as {
      readonly activeChatId: string;
      readonly added: readonly { readonly chatId: string; readonly createdAt: string }[];
      readonly updated: readonly unknown[];
      readonly removedChatIds: readonly unknown[];
    };
    expect(payload.updated).toEqual([]);
    expect(payload.removedChatIds).toEqual([]);
    expect(payload.added).toHaveLength(1);
    expect(payload.added[0]?.chatId).toBe(payload.activeChatId);
    expect(payload.added[0]?.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  test("its launched operation, given a real ChatMutations.create response, publishes a payload that parses against eventPayloadV1SchemaByKind", async () => {
    const stub = createChatMutationsStub();
    const { handlerContext, getLaunches } = buildTestContext({ chatMutations: stub });

    chatHandlers["chat.create"]({}, handlerContext);
    const launch = onlyLaunch(getLaunches());

    const events = await launch.run();

    const event = onlyEvent(events);
    expect(event.kind).toBe("chat.changed");
    const parsed = eventPayloadV1SchemaByKind["chat.changed"].safeParse(event.payload);
    expect(parsed.success).toBe(true);
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

  test("its launched operation switches the active chat, persists it via ProjectStore.writeWorkspaceState, and publishes one chat.changed event that parses against eventPayloadV1SchemaByKind", async () => {
    const stub = createChatMutationsStub();
    const { handlerContext, projectStore, getLaunches } = buildTestContext({ chatMutations: stub });
    const chatId = uuidv7();

    chatHandlers["chat.switch"]({ chatId }, handlerContext);
    const launch = onlyLaunch(getLaunches());

    const events = await launch.run();

    expect(stub.calls).toEqual([{ method: "switchActive", chatId }]);
    expect(projectStore.calls).toEqual([
      { method: "writeWorkspaceState", patch: { activeChatId: chatId } },
    ]);
    const event = onlyEvent(events);
    expect(event.kind).toBe("chat.changed");
    const parsed = eventPayloadV1SchemaByKind["chat.changed"].safeParse(event.payload);
    expect(parsed.success).toBe(true);
    expect(event.payload).toEqual({
      activeChatId: chatId,
      added: [],
      updated: [],
      removedChatIds: [],
    });
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
});
