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
import type { BackendCapabilities, GateRunner, TurnTransactionService } from "core/ports";
import {
  type FakeChatStore,
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
import { type Sha256Hex, type UUIDv7, eventPayloadV1SchemaByKind } from "core/protocol";
import type { PageSlug } from "entities/page";
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

/**
 * Wraps a `TurnTransactionService` so its `admit`/`finalize`/`terminalize` calls genuinely
 * advance — and `finalize` genuinely re-checks — the SAME chat append-base `ledger`
 * reports, mirroring the real store's own single-JSONL-file coupling between a chat's
 * readers and its `TurnTransactionService` writers (`store/adapters/chat-store.ts` and
 * `store/adapters/turn-transactions.ts` both read/write the identical file). Without this,
 * `createFakeChatStore`'s own honest, advancing `readAppendBase` (its header: "an honest,
 * deterministic append-base derived from the fake's OWN current in-memory records") never
 * actually observes what `turnTransactions.admit`/`finalize` do, and `createFakeTurnTransactionService`'s
 * own `finalize` implements no CAS check at all ("No real CAS/read-set comparison is
 * implemented" — that file's own header) — the exact fidelity gap the §10 smoke closeout's
 * WP-1 report names ("the kernel fakes passed because their append-base semantics don't
 * advance on admission the way the real store does"). Built here, at the orchestration
 * layer, not inside `core/ports/fakes/turn-transactions.ts` itself — that file's sibling
 * `core/ports/fakes/index.ts` documents "every fake is independent... it is not this ring's
 * job to simulate that coupling on the fakes' behalf."
 */
function withHonestChatAppendBase(
  base: TurnTransactionService,
  ledger: Pick<FakeChatStore, "seedRecords" | "readAppendBase">,
): TurnTransactionService {
  return {
    ...base,
    async admit(input) {
      const result = await base.admit(input);
      if (!("code" in result)) ledger.seedRecords(input.targetChatId, [input.userRecord]);
      return result;
    },
    async finalize(input) {
      const current = await ledger.readAppendBase(input.targetChatId);
      if (!("code" in current)) {
        const stale =
          current.length !== input.readSet.chat.length ||
          current.prefixSha256 !== input.readSet.chat.prefixSha256;
        if (stale) {
          return {
            code: "APPLY_STALE",
            retryable: true,
            safeMessage: `chat ${input.targetChatId}'s append base advanced since this turn's read-set was captured`,
            details: { part: "chat" },
          };
        }
      }
      const result = await base.finalize(input);
      if (!("code" in result)) ledger.seedRecords(input.targetChatId, [input.agentRecord]);
      return result;
    },
    async terminalize(input) {
      const result = await base.terminalize(input);
      if (!("code" in result)) ledger.seedRecords(input.targetChatId, [input.record]);
      return result;
    },
  };
}

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
  /** Every value `context.setCommitIntentRecorded` was ever called with, in call order — the fixlane-K1-turn-spine.json kernel finding's own discriminating proof that the bit genuinely moves now. */
  readonly getCommitIntentRecordedHistory: () => readonly boolean[];
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
    const commitIntentRecordedHistory: boolean[] = [];
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
        commitIntentRecordedHistory.push(next);
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
      getCommitIntentRecordedHistory: () => commitIntentRecordedHistory,
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

  // Triage #13 (fixlane-K1-turn-spine.json): the cheap refusal-branch tests via
  // error-returning fakes — everything below asserts the SAME shape as the test just above
  // (`{disposition:"started", events:[]}`, `operation.run()` resolves to `[]`, the machine
  // never leaves "idle", `activeTurnId` stays `null`), just triggering a LATER refusal branch.

  /** A projectStore with a real, complete agent selection already set — every test below only exercises ONE later refusal. */
  function selectedProjectStore(overrides?: {
    readonly backend?: string;
    readonly model?: string;
    readonly effort?: string;
  }) {
    return createFakeProjectStore({
      root: "/test-root",
      workspaceState: {
        backend: overrides?.backend ?? "claude",
        model: overrides?.model ?? "sonnet",
        effort: overrides?.effort ?? "medium",
        activeChatId: "chat-1",
      },
    });
  }

  async function assertIdempotentRefusal(
    handlerContext: HandlerContext,
    getLaunchedOperations: () => readonly LaunchedOperation[],
  ): Promise<void> {
    const outcome = turnHandlers["turn.start"]({ text: "hello" }, handlerContext);
    expect(outcome).toEqual({ disposition: "started", events: [] });
    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    const events = await operation.run();
    expect(events).toEqual([]);
    expect(handlerContext.machines.turn.phase()).toBe("idle");
    expect(handlerContext.readKernelState().turn.activeTurnId).toBeNull();
  }

  test("refuses (logged) when project.toml's manifest snapshot cannot be read", async () => {
    const projectStore = selectedProjectStore();
    projectStore.failNext("readManifestSnapshot", {
      code: "PERSISTENCE_FAILED",
      retryable: true,
      safeMessage: "manifest snapshot unreadable",
      details: {},
    });
    const { handlerContext, getLaunchedOperations } = buildTestContext({
      projectStore,
      agentRegistry: createFakeAgentRegistry([
        createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES }),
      ]),
    });
    await assertIdempotentRefusal(handlerContext, getLaunchedOperations);
  });

  test("refuses (logged) when resolveAgentSelection finds the backend but not the requested model", async () => {
    const projectStore = selectedProjectStore({ model: "opus" }); // FAKE_BACKEND_CAPABILITIES only offers "sonnet"
    const { handlerContext, getLaunchedOperations } = buildTestContext({
      projectStore,
      agentRegistry: createFakeAgentRegistry([
        createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES }),
      ]),
    });
    await assertIdempotentRefusal(handlerContext, getLaunchedOperations);
  });

  test("refuses (logged) when resolveAgentSelection finds the model but not the requested effort", async () => {
    const projectStore = selectedProjectStore({ effort: "high" }); // FAKE_BACKEND_CAPABILITIES's "sonnet" only offers "medium"
    const { handlerContext, getLaunchedOperations } = buildTestContext({
      projectStore,
      agentRegistry: createFakeAgentRegistry([
        createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES }),
      ]),
    });
    await assertIdempotentRefusal(handlerContext, getLaunchedOperations);
  });

  test("refuses (logged) when a listed page's canonical source cannot be read", async () => {
    const HOME = "home" as PageSlug;
    const pageStore = createFakePageStore({ order: [HOME] }); // no `sources` entry seeded for HOME
    const { handlerContext, getLaunchedOperations } = buildTestContext({
      projectStore: selectedProjectStore(),
      pageReader: pageStore,
      pageMutations: pageStore,
      agentRegistry: createFakeAgentRegistry([
        createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES }),
      ]),
    });
    await assertIdempotentRefusal(handlerContext, getLaunchedOperations);
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
      // Honest advance-on-admission fidelity (see `withHonestChatAppendBase`'s own doc
      // comment) — without this, `finalize()`'s CAS check never re-observes the
      // just-admitted user record, and this test would give false confidence over the real
      // production bug the §10 smoke closeout found.
      turnTransactions: withHonestChatAppendBase(createFakeTurnTransactionService(), chatStore),
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

  test("buildValidationInput threads the ABSOLUTE staged candidate path to the Gate's per-page runPage() call (the real smoke stage can only resolve an absolute path — a bare `${slug}.tsx` fails in the host's fresh scratch cwd, `gate/adapters/gate-runner.ts`'s own test)", async () => {
    const HOME = "home" as PageSlug;
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

    const capturedRunPageInputs: {
      readonly source: string;
      readonly slug: PageSlug;
      readonly fileName?: string;
    }[] = [];
    const gateRunner: GateRunner = {
      runManifestSlice: async (input) => ({
        errors: [],
        slice: { pages: input.presentSlugs, active: null },
      }),
      runPage: async (input) => {
        capturedRunPageInputs.push(input);
        return {
          ok: true,
          errors: [],
          warnings: [],
          descriptor: {
            slug: input.slug,
            meta: { kitApiVersion: 1, title: "Home", minSize: { w: 80, h: 24 }, theme: "default" },
          },
        };
      },
    };

    const pageStore = createFakePageStore({
      order: [HOME],
      sources: new Map([
        [
          HOME,
          {
            bytes: new TextEncoder().encode("home-source"),
            sourceHash: "a".repeat(64) as Sha256Hex,
          },
        ],
      ]),
    });

    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });
    const { handlerContext, getLaunchedOperations, getPublishedEvents } = buildTestContext({
      chatReader: chatStore,
      chatMutations: chatStore,
      turnTransactions: withHonestChatAppendBase(createFakeTurnTransactionService(), chatStore),
      projectStore: createFakeProjectStore({
        root: "/test-root",
        workspaceState: {
          backend: "claude",
          model: "sonnet",
          effort: "medium",
          activeChatId: chatHeader.chatId,
        },
      }),
      pageReader: pageStore,
      pageMutations: pageStore,
      agentRegistry: createFakeAgentRegistry([agentBackend]),
      gateRunner,
    });

    const outcome = turnHandlers["turn.start"]({ text: "please add a page" }, handlerContext);
    expect(outcome).toEqual({ disposition: "started", events: [] });

    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    const runPromise = operation.run();

    async function waitForPublishedCount(kind: string, count: number): Promise<void> {
      for (let i = 0; i < 200; i++) {
        if (getPublishedEvents().filter((e) => e.kind === kind).length >= count) return;
        await wrap(Bun.sleep(0));
      }
      throw new Error(`waitForPublishedCount: never observed ${count} "${kind}" event(s)`);
    }

    await waitForPublishedCount("turn.attemptStarted", 1);
    const firstAttemptStarted = getPublishedEvents().find((e) => e.kind === "turn.attemptStarted");
    if (firstAttemptStarted === undefined) throw new Error("expected a turn.attemptStarted event");
    const turnId = (firstAttemptStarted.payload as { readonly turnId: string }).turnId;

    const firstStart = agentBackend.calls.find((c) => c.method === "startTurn");
    if (firstStart?.method !== "startTurn") throw new Error("expected a startTurn call");
    agentBackend.completeRun(firstStart.fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "s1",
    });

    const events = await runPromise;
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("turn.completed");

    // The real bug (`fixlane-K1-turn-spine.json`'s smoke-sourcePath finding): the Gate's
    // per-page `runPage()` call must resolve to the staged candidate's real file on disk, not
    // a bare `${slug}.tsx` the real host's fresh scratch child process cwd can never find.
    expect(capturedRunPageInputs).toHaveLength(1);
    const [call] = capturedRunPageInputs;
    if (call === undefined) throw new Error("expected exactly one captured runPage() call");
    expect(call.slug).toBe(HOME);
    expect(call.fileName).toBe(`/fake-candidate/${turnId}/pages/home.tsx`);
  });

  test("publishes a schema-valid turn.started BEFORE the first turn.attemptStarted, carrying the real chatId and the SAME absolute deadline (fixlane-K1-turn-spine.json's seam finding — the mirror only leaves 'idle' on turn.started)", async () => {
    // `createFakeChatStore().create()` mints `fake-chat-N` ids (never a real UUIDv7) — this
    // thin alias lets `activeChatId` be a REAL UUIDv7 (what `turn.started`'s wire schema
    // requires) while every actual chat-record read/write still resolves to the SAME
    // underlying fake chat, exactly like `withHonestChatAppendBase` above wraps one port
    // without reimplementing it.
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");
    // A fresh, explicitly-typed `const`: `resolveId` below is a nested closure, and
    // TypeScript does not carry the `"code" in chatHeader` narrowing above into nested
    // function bodies (this file's `admittedChatId` precedent in `./turn.ts`'s own fix).
    const internalChatId: string = chatHeader.chatId;
    const REAL_CHAT_ID = uuidv7();
    function resolveId(id: string): string {
      return id === REAL_CHAT_ID ? internalChatId : id;
    }
    const aliasedChatStore: FakeChatStore = {
      ...chatStore,
      open: (id) => chatStore.open(resolveId(id)),
      readAppendBase: (id) => chatStore.readAppendBase(resolveId(id)),
      switchActive: (id) => chatStore.switchActive(resolveId(id)),
      seedRecords: (id, records) => chatStore.seedRecords(resolveId(id), records),
    };

    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });
    const { handlerContext, getLaunchedOperations, getPublishedEvents } = buildTestContext({
      chatReader: aliasedChatStore,
      chatMutations: aliasedChatStore,
      turnTransactions: withHonestChatAppendBase(
        createFakeTurnTransactionService(),
        aliasedChatStore,
      ),
      projectStore: createFakeProjectStore({
        root: "/test-root",
        workspaceState: {
          backend: "claude",
          model: "sonnet",
          effort: "medium",
          activeChatId: REAL_CHAT_ID,
        },
      }),
      agentRegistry: createFakeAgentRegistry([agentBackend]),
      gateRunner: createFakeGateRunner(),
    });

    const outcome = turnHandlers["turn.start"]({ text: "hello" }, handlerContext);
    expect(outcome).toEqual({ disposition: "started", events: [] });

    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    const runPromise = operation.run();

    async function waitForPublishedCount(kind: string, count: number): Promise<void> {
      for (let i = 0; i < 200; i++) {
        if (getPublishedEvents().filter((e) => e.kind === kind).length >= count) return;
        await wrap(Bun.sleep(0));
      }
      throw new Error(`waitForPublishedCount: never observed ${count} "${kind}" event(s)`);
    }

    await waitForPublishedCount("turn.attemptStarted", 1);
    const published = getPublishedEvents();
    const startedIndex = published.findIndex((e) => e.kind === "turn.started");
    const attemptIndex = published.findIndex((e) => e.kind === "turn.attemptStarted");
    expect(startedIndex).toBeGreaterThanOrEqual(0);
    expect(startedIndex).toBeLessThan(attemptIndex);

    const startedEvent = published[startedIndex];
    const attemptEvent = published[attemptIndex];
    if (startedEvent === undefined || attemptEvent === undefined) {
      throw new Error("expected both turn.started and turn.attemptStarted to be present");
    }
    expect(eventPayloadV1SchemaByKind["turn.started"].safeParse(startedEvent.payload).success).toBe(
      true,
    );
    const startedPayload = startedEvent.payload as {
      readonly turnId: string;
      readonly chatId: string;
      readonly deadline: string;
    };
    const attemptPayload = attemptEvent.payload as {
      readonly turnId: string;
      readonly deadline: string;
    };
    expect(startedPayload.chatId).toBe(REAL_CHAT_ID);
    expect(startedPayload.turnId).toBe(attemptPayload.turnId);
    expect(startedPayload.deadline).toBe(attemptPayload.deadline);

    const firstStart = agentBackend.calls.find((c) => c.method === "startTurn");
    if (firstStart?.method !== "startTurn") throw new Error("expected a startTurn call");
    agentBackend.completeRun(firstStart.fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "s1",
    });
    const events = await runPromise;
    expect(events).toHaveLength(1);
  });
});

describe("commit-intent bit: context.setCommitIntentRecorded genuinely moves now (fixlane-K1-turn-spine.json's kernel finding)", () => {
  // Before this fix, NO production handler ever called `context.setCommitIntentRecorded`, so
  // `kernel.ts`'s `commitIntentRecordedAtom` was permanently `false` — the `CANCEL_TOO_LATE`/
  // forbidden branch both `revision-guard.ts` and `capabilities/model/guards.ts` guard on
  // (§8.4 rule 6) was dead code in a real Kernel. These tests prove `handlers/turn.ts`'s own
  // wiring (`RunTurnDeps.onCommitIntentRecorded` -> `context.setCommitIntentRecorded`, plus the
  // unconditional clear once `runTurn` resolves) actually reaches the Kernel-held mutator —
  // `core/turns/model/run-turn.test.ts`'s own "onCommitIntentRecorded" suite already proves
  // `runTurn` calls the hook at the right moments; this proves THIS handler's wiring of it.

  function buildRacingTransactions(chatStore: FakeChatStore): {
    readonly turnTransactions: TurnTransactionService;
    readonly bindMachine: (machine: { apply: (action: TurnAction) => unknown }) => void;
  } {
    const base = createFakeTurnTransactionService();
    const honest = withHonestChatAppendBase(base, chatStore);
    let machineRef: { apply: (action: TurnAction) => unknown } | null = null;
    const turnTransactions: TurnTransactionService = {
      ...honest,
      finalize: async (input) => {
        const result = await wrap(honest.finalize(input));
        // Simulate a `turn.cancel` landing in the pre-intent window (legal per
        // `turn-machine.ts`'s own table) — see `run-turn.test.ts`'s identical test (k).
        if (!("code" in result)) machineRef?.apply("requestCancel");
        return result;
      },
    };
    return {
      turnTransactions,
      bindMachine: (machine) => {
        machineRef = machine;
      },
    };
  }

  test("clean single-attempt commit: setCommitIntentRecorded fires [true, false], in that order", async () => {
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");
    const { turnTransactions } = buildRacingTransactions(chatStore); // no race bound — clean path
    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });

    const { handlerContext, getLaunchedOperations, getCommitIntentRecordedHistory } =
      buildTestContext({
        chatReader: chatStore,
        chatMutations: chatStore,
        turnTransactions,
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
        gateRunner: createFakeGateRunner(),
      });

    turnHandlers["turn.start"]({ text: "hello" }, handlerContext);
    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    const runPromise = operation.run();

    async function waitForStartTurn(): Promise<void> {
      for (let i = 0; i < 200; i++) {
        if (agentBackend.calls.some((c) => c.method === "startTurn")) return;
        await wrap(Bun.sleep(0));
      }
      throw new Error("waitForStartTurn: never observed a startTurn call");
    }
    await waitForStartTurn();
    const firstStart = agentBackend.calls.find((c) => c.method === "startTurn");
    if (firstStart?.method !== "startTurn") throw new Error("expected a startTurn call");
    agentBackend.completeRun(firstStart.fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "s1",
    });

    const events = await runPromise;
    expect(events[0]?.kind).toBe("turn.completed");
    expect(getCommitIntentRecordedHistory()).toEqual([true, false]);
  });

  test("a raced concurrent cancel makes markCommitted illegal (run-turn.ts bridges to terminalized): setCommitIntentRecorded STILL fires [true, false] — the durable commit genuinely happened even though the machine diverged", async () => {
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");
    const { turnTransactions, bindMachine } = buildRacingTransactions(chatStore);
    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });

    const { handlerContext, getLaunchedOperations, getCommitIntentRecordedHistory } =
      buildTestContext({
        chatReader: chatStore,
        chatMutations: chatStore,
        turnTransactions,
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
        gateRunner: createFakeGateRunner(),
      });
    bindMachine(handlerContext.machines.turn);

    turnHandlers["turn.start"]({ text: "hello" }, handlerContext);
    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    const runPromise = operation.run();

    async function waitForStartTurn(): Promise<void> {
      for (let i = 0; i < 200; i++) {
        if (agentBackend.calls.some((c) => c.method === "startTurn")) return;
        await wrap(Bun.sleep(0));
      }
      throw new Error("waitForStartTurn: never observed a startTurn call");
    }
    await waitForStartTurn();
    const firstStart = agentBackend.calls.find((c) => c.method === "startTurn");
    if (firstStart?.method !== "startTurn") throw new Error("expected a startTurn call");
    agentBackend.completeRun(firstStart.fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "s1",
    });

    const events = await runPromise;
    // The race made the machine diverge from "finalizing" before `markCommitted` — this
    // handler's own generic terminal-event mapping (this file's header, "THE TERMINAL EVENT")
    // reports it as `turn.failed`, NEVER `turn.completed`, since no real success occurred from
    // the machine's own point of view.
    expect(events[0]?.kind).toBe("turn.failed");
    expect(getCommitIntentRecordedHistory()).toEqual([true, false]);
    expect(handlerContext.machines.turn.phase()).toBe("idle");
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
