import { describe, expect, spyOn, test } from "bun:test";

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
import type {
  AgentBackend,
  AgentTask,
  BackendCapabilities,
  GateRunner,
  TurnTransactionService,
} from "core/ports";
import {
  type FakeChatStore,
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
import { type FailureDtoV1, type UUIDv7, eventPayloadV1SchemaByKind } from "core/protocol";
import type { ChatUserRecord } from "entities/chat";
import type { PageSlug } from "entities/page";
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

import type { KernelDeps } from "../../types";
import { terminalChangedPages, turnHandlers } from "./turn";
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
  // WP-4: a real declared default, consistent with this fixture's own (sole) model/effort —
  // not exercised by the tests that use this constant, which all set an explicit workspace-state
  // triple, but required now that `BackendCapabilities.defaultSelection` is non-optional.
  defaultSelection: { model: "sonnet", effort: "medium" },
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
    const pageStore = createFakeDesignStoreForPages({ pages: [] });
    const pinStore = createFakePinStore();
    const projectStore = createFakeProjectStore({ root: "/test-root" });
    const clock: Clock = { now: () => new Date(1_700_000_000_000) };

    const deps: KernelDeps = {
      projectStore,
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
      agentPromptSource: createFakeAgentPromptSource(),
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
  test("records the active turn id in the same synchronous step as beginAdmission (spec §1.2)", () => {
    const { handlerContext, getLaunchedOperations } = buildTestContext();

    const outcome = turnHandlers["turn.start"]({ text: "hello" }, handlerContext);

    expect(outcome.disposition).toBe("started");
    expect(handlerContext.machines.turn.phase()).toBe("admitting");
    // `setActiveTurnId` already landed — synchronously, before `launchOperation`'s own
    // closure has even run (the launched operation below is still unexecuted at this point)
    // — proving the mint/apply/record trio has no `await` between them (spec §1.2).
    expect(handlerContext.readKernelState().turn.activeTurnId).not.toBeNull();
    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    expect(operation.label).toBe("kernel.turn.run");
  });

  test("a second turn.start while the first is still admitting is refused as a no-op — beginTurn's own defensive illegal-beginAdmission branch (fix round 1: was covered by nothing)", () => {
    const { handlerContext, getLaunchedOperations } = buildTestContext();

    const first = turnHandlers["turn.start"]({ text: "hello" }, handlerContext);
    expect(first.disposition).toBe("started");
    expect(handlerContext.machines.turn.phase()).toBe("admitting");

    // `beginAdmission` is illegal from "admitting" (the table's only edge is `idle ->
    // admitting`), so `beginTurn` returns `[]` and `handleTurnStart` maps that onto
    // `noOpOutcome()` — never `startedOutcome([])`, which would falsely claim something
    // started (see `handleTurnStart`'s own inline comment, `./turn.ts`).
    const second = turnHandlers["turn.start"]({ text: "again" }, handlerContext);

    expect(second).toEqual({ disposition: "no-op", events: [] });
    // Nothing new launched — still exactly the FIRST turn's own operation.
    expect(getLaunchedOperations()).toHaveLength(1);
    // The first turn's own admission is untouched by the refused second attempt.
    expect(handlerContext.machines.turn.phase()).toBe("admitting");
  });

  // Triage #13 (fixlane-K1-turn-spine.json): the cheap refusal-branch tests via
  // error-returning fakes — everything below asserts the SAME shape (`{disposition:"started",
  // events:[<1 admission event>]}`, then `operation.run()` recovers the machine to idle), just
  // triggering a DIFFERENT refusal branch. See `assertEarlyPortRefusalRecoversToIdle`'s own
  // doc comment for the shared assertion this whole family proves.

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

  /**
   * Every one of these fixtures reaches a PORT failure inside `runTurnStart`, strictly BEFORE
   * `admission`/`runAdmission` is ever built or called — `beginTurn` (`./turn.ts`) has already
   * admitted synchronously by the time any of them run (spec §1.2), so `outcome.events` now
   * carries the ONE `kernel.stateChanged` admission event these fixtures used to see none of.
   *
   * FIX ROUND 1: `runTurnStart`'s own `abortEarlyAdmission` (`./turn.ts`) now walks the
   * machine back out of `admitting` via the REAL `admitting -> terminalizing -> terminal ->
   * idle` edges (`TURN_TRANSITION_TABLE`, exactly three transitions, exactly three
   * `kernel.stateChanged` events) and clears `activeTurnId` — so `operation.run()` resolves
   * with those three events, never `[]`, and the machine is USABLE again: a second
   * `turn.start` is accepted, not rejected `TURN_ALREADY_ACTIVE`. Before that fix, this
   * helper (then `assertEarlyPortRefusalStalls`) proved the opposite — a real, reported gap,
   * not something this suite ever laundered as accepted.
   *
   * TASK 4'S OWN ADDITION (fix-bundle spec §1.4's own follow-up finding — every one of these
   * ten branches accepts the command, so it must reach a terminal event too): a FOURTH event,
   * `turn.failed`, now follows the three `kernel.stateChanged` events — `abortEarlyAdmission`
   * publishes it naming the branch's own refusal reason. `expectedCauseSubstring` is a
   * fragment of that branch's own `console.warn` text (never invented prose), asserted against
   * the published failure's `safeMessage` so each caller proves ITS OWN cause reached the wire,
   * not just "some" `turn.failed`.
   */
  async function assertEarlyPortRefusalRecoversToIdle(
    handlerContext: HandlerContext,
    getLaunchedOperations: () => readonly LaunchedOperation[],
    expectedCauseSubstring: string,
  ): Promise<void> {
    const outcome = turnHandlers["turn.start"]({ text: "hello" }, handlerContext);
    expect(outcome.disposition).toBe("started");
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]?.kind).toBe("kernel.stateChanged");
    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    const events = await operation.run();
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.kind)).toEqual([
      "kernel.stateChanged",
      "kernel.stateChanged",
      "kernel.stateChanged",
      "turn.failed",
    ]);
    const [, , , failed] = events;
    if (failed === undefined || failed.kind !== "turn.failed") {
      throw new Error("expected the fourth event to be turn.failed");
    }
    const failedPayload = failed.payload as { readonly failure: { readonly safeMessage: string } };
    expect(failedPayload.failure.safeMessage).toContain(expectedCauseSubstring);
    expect(handlerContext.machines.turn.phase()).toBe("idle");
    expect(handlerContext.readKernelState().turn.activeTurnId).toBeNull();
  }

  test("starts an operation synchronously and ADMITS before any async work runs; a later refusal (nothing selected in this fixture) recovers to idle (Gap 4 closed, fix round 1)", async () => {
    const { handlerContext, getLaunchedOperations } = buildTestContext();
    // Unlike the old no-op: the handler now ALWAYS starts an operation — whether admission
    // proceeds is decided asynchronously, inside it (`selection`/`model` families' own
    // precedent for "nothing about the outcome is known until the promise settles").
    await assertEarlyPortRefusalRecoversToIdle(
      handlerContext,
      getLaunchedOperations,
      "no active chat yet",
    );
    expect(getLaunchedOperations()[0]?.label).toBe("kernel.turn.run");
  });

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
    await assertEarlyPortRefusalRecoversToIdle(
      handlerContext,
      getLaunchedOperations,
      "manifest snapshot unreadable",
    );
  });

  test("refuses (logged) when resolveAgentSelection finds the backend but not the requested model", async () => {
    const projectStore = selectedProjectStore({ model: "opus" }); // FAKE_BACKEND_CAPABILITIES only offers "sonnet"
    const { handlerContext, getLaunchedOperations } = buildTestContext({
      projectStore,
      agentRegistry: createFakeAgentRegistry([
        createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES }),
      ]),
    });
    await assertEarlyPortRefusalRecoversToIdle(
      handlerContext,
      getLaunchedOperations,
      'does not offer model "opus"',
    );
  });

  test("refuses (logged) when resolveAgentSelection finds the model but not the requested effort", async () => {
    const projectStore = selectedProjectStore({ effort: "high" }); // FAKE_BACKEND_CAPABILITIES's "sonnet" only offers "medium"
    const { handlerContext, getLaunchedOperations } = buildTestContext({
      projectStore,
      agentRegistry: createFakeAgentRegistry([
        createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES }),
      ]),
    });
    await assertEarlyPortRefusalRecoversToIdle(
      handlerContext,
      getLaunchedOperations,
      'does not offer effort "high"',
    );
  });

  test("the read-set's design-file hashes come from listTree() itself — admission never reads a single file's bytes", async () => {
    // REPLACES an early-refusal test that no longer has a branch to reach (task 14): the old
    // assembly called `readSource(slug)` once per page purely to obtain each one's
    // `sha256`/`size` for the read set, so an unreadable page refused the turn right there.
    // `listTree()` returns both facts for the WHOLE tree in one walk, so admission performs no
    // per-file read at all and that refusal branch is gone. A file that genuinely cannot be
    // copied now fails inside `staging.createTurnWorkspace`, i.e. through admission's own
    // already-tested `workspace` blocked phase — not silently.
    //
    // Pinned as a positive property rather than deleted, because "no byte read at admission"
    // is exactly what a future edit could quietly undo.
    const HOME = "home" as PageSlug;
    const pageStore = createFakeDesignStoreForPages({
      pages: [
        { pageSlug: HOME, bytes: new TextEncoder().encode("home-source"), sha256: "e".repeat(64) },
      ],
    });
    const staging = createFakeStagingService();
    // The design-store calls made up to the moment staging is asked to copy the tree — i.e.
    // the whole admission window. Everything after it belongs to the post-commit
    // `page.descriptorsChanged` pass, which legitimately DOES read page bytes.
    let callsAtStaging: readonly string[] = [];
    const originalCreateTurnWorkspace = staging.createTurnWorkspace.bind(staging);
    staging.createTurnWorkspace = async (input) => {
      callsAtStaging = pageStore.calls.map((c) => c.method);
      return originalCreateTurnWorkspace(input);
    };
    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");
    const { handlerContext, getLaunchedOperations } = buildTestContext({
      chatReader: chatStore,
      chatMutations: chatStore,
      turnTransactions: withHonestChatAppendBase(createFakeTurnTransactionService(), chatStore),
      designReader: pageStore,
      pageMutations: pageStore,
      staging,
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
    });

    turnHandlers["turn.start"]({ text: "hello" }, handlerContext);
    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    const runPromise = operation.run();
    for (let i = 0; i < 200; i++) {
      if (agentBackend.calls.some((c) => c.method === "startTurn")) break;
      await wrap(Bun.sleep(0));
    }
    const start = agentBackend.calls.find((c) => c.method === "startTurn");
    if (start?.method !== "startTurn") throw new Error("expected a startTurn call");
    agentBackend.completeRun(start.fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "s1",
    });
    await runPromise;

    const createCall = staging.calls.find((c) => c.method === "createTurnWorkspace");
    if (createCall?.method !== "createTurnWorkspace") {
      throw new Error("expected a createTurnWorkspace call");
    }
    // `design/pages.json` is a REAL tree file and is staged like any other (design §3, §10),
    // so it appears in the read set beside the page's own entry — the retired assembly
    // SYNTHESIZED a manifest slice per turn instead, discarding whatever the agent had
    // written to page order and identity.
    expect(createCall.input.readSet.designFiles).toEqual([
      { relPath: "pages.json", snapshot: { sha256: expect.any(String), size: expect.any(Number) } },
      { relPath: defaultFakeEntry(HOME), snapshot: { sha256: "e".repeat(64), size: 11 } },
    ]);
    // `readTreeFile` is the only byte-reading method on this port, and admission never calls
    // it — every hash above came from the `listTree` walk. (After the commit it IS called, by
    // the `page.descriptorsChanged` pass; the snapshot above is what separates the two.)
    expect(callsAtStaging).toEqual(["listTree", "readManifest"]);
  });

  // Fix round 1: the remaining five of the ten early-refusal branches — untested for recovery
  // before, since before `beginTurn` existed none of them touched the machine at all. Each
  // routes through the SAME `abortEarlyAdmission` the four tests above already prove recovers
  // — these close out the full set with direct evidence rather than resting on that alone.

  test("refuses (logged) when readWorkspaceState itself fails", async () => {
    const projectStore = createFakeProjectStore({ root: "/test-root" });
    projectStore.failNext("readWorkspaceState", {
      code: "PERSISTENCE_FAILED",
      retryable: true,
      safeMessage: "workspace state unreadable",
      details: {},
    });
    const { handlerContext, getLaunchedOperations } = buildTestContext({ projectStore });
    await assertEarlyPortRefusalRecoversToIdle(
      handlerContext,
      getLaunchedOperations,
      "workspace state unreadable",
    );
  });

  test("refuses (logged) when resolveStoredOrDefaultAgentTriple finds no registered backend to default from (an active chat exists, nothing stored, the registry is empty)", async () => {
    const projectStore = createFakeProjectStore({
      root: "/test-root",
      workspaceState: { activeChatId: "chat-1" }, // no stored backend/model/effort
    });
    const { handlerContext, getLaunchedOperations } = buildTestContext({
      projectStore,
      agentRegistry: createFakeAgentRegistry([]),
    });
    await assertEarlyPortRefusalRecoversToIdle(
      handlerContext,
      getLaunchedOperations,
      "no backend registered to default from",
    );
  });

  test("refuses (logged) when designReader.listTree fails", async () => {
    const pageStore = createFakeDesignStoreForPages({ pages: [] });
    pageStore.failNext("listTree", {
      code: "PERSISTENCE_FAILED",
      retryable: true,
      safeMessage: "design tree unreadable",
      details: {},
    });
    const { handlerContext, getLaunchedOperations } = buildTestContext({
      projectStore: selectedProjectStore(),
      designReader: pageStore,
      pageMutations: pageStore,
      agentRegistry: createFakeAgentRegistry([
        createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES }),
      ]),
    });
    await assertEarlyPortRefusalRecoversToIdle(
      handlerContext,
      getLaunchedOperations,
      "design tree unreadable",
    );
  });

  test("refuses (logged) when design/pages.json cannot be decoded", async () => {
    // Brief step 3's own named refusal. The tree LISTS fine (`listTree` succeeds) — only the
    // manifest decode fails, which is the case a fabricated empty page order would hide by
    // telling the agent the project has no pages.
    const pageStore = createFakeDesignStoreForPages({ pages: [] });
    pageStore.failNext("readManifest", {
      code: "PERSISTENCE_FAILED",
      retryable: true,
      safeMessage: "pages.json is not valid JSON",
      details: {},
    });
    const { handlerContext, getLaunchedOperations } = buildTestContext({
      projectStore: selectedProjectStore(),
      designReader: pageStore,
      pageMutations: pageStore,
      agentRegistry: createFakeAgentRegistry([
        createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES }),
      ]),
    });
    await assertEarlyPortRefusalRecoversToIdle(
      handlerContext,
      getLaunchedOperations,
      "pages.json is not valid JSON",
    );
  });

  test("refuses (logged) when pinReader.fold fails for the active page", async () => {
    const HOME = "home" as PageSlug;
    const pinStore = createFakePinStore();
    pinStore.failNext("fold", {
      code: "PERSISTENCE_FAILED",
      retryable: true,
      safeMessage: "pin fold unreadable",
      details: {},
    });
    const projectStore = createFakeProjectStore({
      root: "/test-root",
      workspaceState: {
        backend: "claude",
        model: "sonnet",
        effort: "medium",
        activeChatId: "chat-1",
        activePageSlug: HOME,
      },
    });
    const { handlerContext, getLaunchedOperations } = buildTestContext({
      projectStore,
      pinReader: pinStore,
      pinMutations: pinStore,
      agentRegistry: createFakeAgentRegistry([
        createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES }),
      ]),
    });
    await assertEarlyPortRefusalRecoversToIdle(
      handlerContext,
      getLaunchedOperations,
      "pin fold unreadable",
    );
  });

  test("refuses (logged) when pinReader.readAppendBase fails for the active page (an open pin genuinely contributed a candidate)", async () => {
    const HOME = "home" as PageSlug;
    const pinStore = createFakePinStore();
    await pinStore.appendStandaloneEvent(HOME, {
      kind: "pin:created",
      recordId: "r1",
      pinId: "pin-open",
      element: "btn-1",
      fx: 0.5,
      fy: 0.5,
      text: "note",
      ts: "2024-01-01T00:00:00.000Z",
    });
    pinStore.failNext("readAppendBase", {
      code: "PERSISTENCE_FAILED",
      retryable: true,
      safeMessage: "pin append-base unreadable",
      details: {},
    });
    const projectStore = createFakeProjectStore({
      root: "/test-root",
      workspaceState: {
        backend: "claude",
        model: "sonnet",
        effort: "medium",
        activeChatId: "chat-1",
        activePageSlug: HOME,
      },
    });
    const { handlerContext, getLaunchedOperations } = buildTestContext({
      projectStore,
      pinReader: pinStore,
      pinMutations: pinStore,
      agentRegistry: createFakeAgentRegistry([
        createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES }),
      ]),
    });
    await assertEarlyPortRefusalRecoversToIdle(
      handlerContext,
      getLaunchedOperations,
      "pin append-base unreadable",
    );
  });

  test("WP-4 default agent selection: with an active chat but NO stored (backend, model, effort) triple, the turn is admitted (not refused) and the started AgentTask carries the registry's declared default model and effort", async () => {
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

    // Mirrors `claudeCapabilities()`'s real declared default (`agent/claude/backend/model
    // /capabilities.ts`) — this fixture's own capabilities object, not a fetch of the real
    // one, matching every other test in this file's own `FAKE_BACKEND_CAPABILITIES` precedent.
    const DEFAULT_SELECTION_CAPABILITIES: BackendCapabilities = {
      backendId: "claude",
      models: [{ model: "claude-sonnet-5", efforts: ["high"] }],
      confinement: "canUseTool",
      sessionWorkspaceBinding: "fixed",
      defaultSelection: { model: "claude-sonnet-5", effort: "high" },
    };

    // `createFakeAgentBackend`'s own `AgentBackendCall` shape only records a run's `fence`
    // (not its full `AgentTask`), so this thin wrapper captures the task itself — the same
    // "wrap a base fake to observe one extra thing" pattern `withHonestChatAppendBase` above
    // already uses, never a second hand-rolled `AgentBackend`.
    const capturedTasks: AgentTask[] = [];
    const baseAgentBackend = createFakeAgentBackend({
      capabilities: DEFAULT_SELECTION_CAPABILITIES,
    });
    const agentBackend: AgentBackend = {
      ...baseAgentBackend,
      startTurn: (task) => {
        capturedTasks.push(task);
        return baseAgentBackend.startTurn(task);
      },
    };

    const { handlerContext, getLaunchedOperations, getPublishedEvents } = buildTestContext({
      chatReader: chatStore,
      chatMutations: chatStore,
      turnTransactions: withHonestChatAppendBase(createFakeTurnTransactionService(), chatStore),
      projectStore: createFakeProjectStore({
        root: "/test-root",
        // NO `backend`/`model`/`effort` in this patch — `DEFAULT_WORKSPACE_STATE`
        // (`core/ports/fakes/project-store.ts`) leaves all three `null`, exactly the "nothing
        // selected yet" shape WP-4 falls back from. Only `activeChatId` is set.
        workspaceState: { activeChatId: chatHeader.chatId },
      }),
      agentRegistry: createFakeAgentRegistry([agentBackend]),
      gateRunner: createFakeGateRunner(),
    });

    const outcome = turnHandlers["turn.start"]({ text: "hello" }, handlerContext);
    // Pre-WP-4, this exact fixture (active chat, no triple) refused synchronously with zero
    // events and no launched attempt (this file's very first test, same shape minus the chat).
    // Proving `disposition: "started"` here is necessary but not sufficient — the assertions
    // below prove the refusal genuinely did not fire, by proving a REAL attempt started.
    // `beginTurn` (spec §1.2/§1.6) applies `beginAdmission` synchronously before launching —
    // `outcome.events` carries that ONE kernel.stateChanged event, not `[]`.
    expect(outcome.disposition).toBe("started");
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]?.kind).toBe("kernel.stateChanged");

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

    expect(capturedTasks).toHaveLength(1);
    const [startedTask] = capturedTasks;
    if (startedTask === undefined) throw new Error("expected exactly one captured AgentTask");
    expect(startedTask.model).toBe("claude-sonnet-5");
    expect(startedTask.effort).toBe("high");

    const firstStart = baseAgentBackend.calls.find((c) => c.method === "startTurn");
    if (firstStart?.method !== "startTurn") throw new Error("expected a startTurn call");
    baseAgentBackend.completeRun(firstStart.fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "s1",
    });

    const events = await runPromise;
    expect(events.map((event) => event.kind)).toEqual([
      "page.descriptorsChanged",
      "turn.completed",
    ]);
  });

  test("a committed turn announces the pages it produced — page.descriptorsChanged names them and makes the first one active, so a fresh project's very first generation reaches the preview", async () => {
    const HOME = "home" as PageSlug;
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

    // The page the turn "wrote": present on disk by the time the post-commit announcement
    // re-reads the project. The workspace state deliberately has NO activePageSlug — the state
    // a brand-new project is in, and the exact case that used to leave `activePageSlug` null
    // forever, so `ui/app/model/deps.ts`'s preview subscriber never asked for a session and the
    // Workspace sat on "preparing preview…".
    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });
    const { handlerContext, getLaunchedOperations } = buildTestContext({
      chatReader: chatStore,
      chatMutations: chatStore,
      turnTransactions: withHonestChatAppendBase(createFakeTurnTransactionService(), chatStore),
      designReader: createFakeDesignStoreForPages({
        pages: [
          {
            pageSlug: HOME,
            bytes: new TextEncoder().encode("export const meta = {}"),
            sha256: "c".repeat(64),
          },
        ],
      }),
      projectStore: createFakeProjectStore({
        root: "/test-root",
        workspaceState: {
          backend: "claude",
          model: "sonnet",
          effort: "medium",
          activeChatId: chatHeader.chatId,
          activePageSlug: null,
        },
      }),
      agentRegistry: createFakeAgentRegistry([agentBackend]),
      gateRunner: createFakeGateRunner(),
    });

    turnHandlers["turn.start"]({ text: "build me a clock" }, handlerContext);
    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    const runPromise = operation.run();

    for (let i = 0; i < 200 && !agentBackend.calls.some((c) => c.method === "startTurn"); i++) {
      await wrap(Bun.sleep(0));
    }
    const firstStart = agentBackend.calls.find((c) => c.method === "startTurn");
    if (firstStart?.method !== "startTurn") throw new Error("expected a startTurn call");
    agentBackend.completeRun(firstStart.fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "s1",
    });

    const events = await runPromise;
    const announced = events.find((event) => event.kind === "page.descriptorsChanged");
    if (announced === undefined) {
      throw new Error("expected the committed batch to announce the pages the turn produced");
    }
    const payload = eventPayloadV1SchemaByKind["page.descriptorsChanged"].parse(announced.payload);
    expect(payload.reason).toBe("turn-apply");
    expect(payload.descriptors.map((descriptor) => descriptor.pageSlug)).toEqual([HOME]);
    // The whole point: with no stored active page, the announcement names the project's first
    // page — the same `?? manifest.pages[0]` rule the open path already applies — so the UI has
    // a slug to ask a preview session for.
    expect(payload.activePageSlug).toBe(HOME);
  });

  test('candidatePins: an OPEN pin on the active page reaches admission as a candidate, keyed by that page\'s slug — a RESOLVED pin on the same page does not (kernel-command-contract §12.2 item 1: "only currently open, resolvable pins")', async () => {
    const HOME = "home" as PageSlug;
    const OPEN_PIN_ID = "pin-open";
    const RESOLVED_PIN_ID = "pin-resolved";

    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

    // Extends the file's existing fake pin reader's fold response — never a second fake —
    // with TWO pins on the active page: one still open, one already resolved.
    const pinStore = createFakePinStore();
    await pinStore.appendStandaloneEvent(HOME, {
      kind: "pin:created",
      recordId: "r1",
      pinId: OPEN_PIN_ID,
      element: "btn-1",
      fx: 0.5,
      fy: 0.5,
      text: "still open",
      ts: "2024-01-01T00:00:00.000Z",
    });
    await pinStore.appendStandaloneEvent(HOME, {
      kind: "pin:created",
      recordId: "r2",
      pinId: RESOLVED_PIN_ID,
      element: "btn-2",
      fx: 0.2,
      fy: 0.2,
      text: "already handled",
      ts: "2024-01-01T00:00:01.000Z",
    });
    await pinStore.appendStandaloneEvent(HOME, {
      kind: "pin:status",
      recordId: "r3",
      pinId: RESOLVED_PIN_ID,
      status: "resolved",
      actionId: "action-1",
      ts: "2024-01-01T00:00:02.000Z",
    });

    // Wraps `turnTransactions.admit` (the "wrap a base fake to observe one extra thing"
    // pattern this file's own `capturedTasks`/`AgentTask` precedent above already uses) to
    // capture the EXACT `ChatUserRecord` admission committed — `admission.ts`'s own
    // `resolveOpenPins` populates `userRecord.pins` from `AdmissionInputV1.candidatePins`
    // and nothing else, so this is the direct, honest proof of what this handler passed as
    // candidates: `pins` here can equal `[OPEN_PIN_ID]` if and only if a candidate keyed by
    // HOME's slug and OPEN_PIN_ID reached admission and was still open at admission time.
    const capturedUserRecords: ChatUserRecord[] = [];
    const baseTurnTransactions = withHonestChatAppendBase(
      createFakeTurnTransactionService(),
      chatStore,
    );
    const turnTransactions: TurnTransactionService = {
      ...baseTurnTransactions,
      admit: async (input) => {
        capturedUserRecords.push(input.userRecord);
        return baseTurnTransactions.admit(input);
      },
    };

    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });
    const { handlerContext, getLaunchedOperations, getPublishedEvents } = buildTestContext({
      chatReader: chatStore,
      chatMutations: chatStore,
      turnTransactions,
      pinReader: pinStore,
      pinMutations: pinStore,
      projectStore: createFakeProjectStore({
        root: "/test-root",
        workspaceState: {
          backend: "claude",
          model: "sonnet",
          effort: "medium",
          activeChatId: chatHeader.chatId,
          activePageSlug: HOME,
        },
      }),
      agentRegistry: createFakeAgentRegistry([agentBackend]),
      gateRunner: createFakeGateRunner(),
    });

    const outcome = turnHandlers["turn.start"]({ text: "please look at my pins" }, handlerContext);
    // `beginTurn` (spec §1.2/§1.6) applies `beginAdmission` synchronously before launching —
    // `outcome.events` carries that ONE kernel.stateChanged event, not `[]`.
    expect(outcome.disposition).toBe("started");
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]?.kind).toBe("kernel.stateChanged");

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
    const firstStart = agentBackend.calls.find((c) => c.method === "startTurn");
    if (firstStart?.method !== "startTurn") throw new Error("expected a startTurn call");
    agentBackend.completeRun(firstStart.fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "s1",
    });

    const events = await runPromise;
    expect(events.map((event) => event.kind)).toEqual([
      "page.descriptorsChanged",
      "turn.completed",
    ]);

    expect(capturedUserRecords).toHaveLength(1);
    const [userRecord] = capturedUserRecords;
    if (userRecord === undefined) throw new Error("expected exactly one captured user record");
    expect(userRecord.pins).toEqual([OPEN_PIN_ID]);
  });

  test("sentPins: a pin the message carried is auto-resolved once the turn commits a change to its page (§12.2 item 8) — it used to stay open forever", async () => {
    const HOME = "home" as PageSlug;
    const OPEN_PIN_ID = "pin-open";

    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

    const pinStore = createFakePinStore();
    await pinStore.appendStandaloneEvent(HOME, {
      kind: "pin:created",
      recordId: "r1",
      pinId: OPEN_PIN_ID,
      element: "btn-1",
      fx: 0.5,
      fy: 0.5,
      text: "make this button green",
      ts: "2024-01-01T00:00:00.000Z",
    });

    // The raw fake is kept alongside the wrapper so its `calls` log stays readable — the
    // wrapper's return type is the narrow port, which carries no log.
    const fakeTransactions = createFakeTurnTransactionService();
    const turnTransactions = withHonestChatAppendBase(fakeTransactions, chatStore);
    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });

    // REAL CLOSURES, QUEUED DELIBERATELY (task-13 review round 2, Minor M-d — named as a trap
    // for exactly this task's fixtures). `createFakeGateRunner`'s honest-empty
    // `closures: []` default makes `selectChangedPages(...)` return `[]` for EVERY page
    // unconditionally, which reads as "nothing changed" — so this test's own precondition
    // ("the turn genuinely changed the pinned page") would be silently false and the assertion
    // below would fail for a reason unrelated to `sentPins`. Verified by removing this block:
    // `changedPageSlugs` comes back `[]`.
    const gateRunner = createFakeGateRunner();
    gateRunner.queueRunManifestSliceResult({
      errors: [],
      slice: { pages: [{ slug: HOME, entry: defaultFakeEntry(HOME) }], active: null },
    });
    gateRunner.queueRunTreeImportsResult({
      errors: [],
      closures: [{ slug: HOME, files: [defaultFakeEntry(HOME)] }],
    });
    const { handlerContext, getLaunchedOperations, getPublishedEvents } = buildTestContext({
      chatReader: chatStore,
      chatMutations: chatStore,
      turnTransactions,
      pinReader: pinStore,
      pinMutations: pinStore,
      // The pinned page has to actually exist for the turn to produce a diff that touches it —
      // "an empty design diff resolves none" is the rule this test's precondition rests on.
      designReader: createFakeDesignStoreForPages({
        pages: [
          {
            pageSlug: HOME,
            bytes: new TextEncoder().encode("export const meta = {}"),
            sha256: "d".repeat(64),
          },
        ],
      }),
      projectStore: createFakeProjectStore({
        root: "/test-root",
        workspaceState: {
          backend: "claude",
          model: "sonnet",
          effort: "medium",
          activeChatId: chatHeader.chatId,
          activePageSlug: HOME,
        },
      }),
      agentRegistry: createFakeAgentRegistry([agentBackend]),
      gateRunner,
    });

    turnHandlers["turn.start"]({ text: "make the button green" }, handlerContext);
    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    const runPromise = operation.run();

    for (let i = 0; i < 200; i++) {
      if (getPublishedEvents().some((e) => e.kind === "turn.attemptStarted")) break;
      await wrap(Bun.sleep(0));
    }
    const firstStart = agentBackend.calls.find((c) => c.method === "startTurn");
    if (firstStart?.method !== "startTurn") throw new Error("expected a startTurn call");
    agentBackend.completeRun(firstStart.fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "s1",
    });
    await runPromise;

    const finalizeCall = fakeTransactions.calls.find((call) => call.method === "finalize");
    if (finalizeCall?.method !== "finalize") throw new Error("expected a finalize call");
    // The turn genuinely changed the pinned page — the precondition §12.2 item 8 attaches the
    // resolution to ("an empty design diff resolves none").
    expect(finalizeCall.input.changedPageSlugs).toContain(HOME);
    // THE FIX: `buildFinalizeInput` used to hardcode `sentPins: []`, so `resolveSentPinAppends`
    // always returned nothing and the pin the agent had just addressed stayed open forever.
    expect(
      finalizeCall.input.resolvedPins.map((resolved) => ({
        pinId: resolved.event.pinId,
        pageSlug: resolved.pageSlug,
        status: resolved.event.status,
      })),
    ).toEqual([{ pinId: OPEN_PIN_ID, pageSlug: HOME, status: "resolved" }]);
    // ...and the transaction really applied it, rather than filtering it back out.
    expect(finalizeCall.appliedResolvedPins).toHaveLength(1);
  });

  test("readSet.pins: an OPEN pin on the active page carries a readSet.pins entry sourced from PinReader.readAppendBase — not the honest-empty [] placeholder (phase-8 WP-6)", async () => {
    const HOME = "home" as PageSlug;
    const OPEN_PIN_ID = "pin-open";

    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

    const pinStore = createFakePinStore();
    await pinStore.appendStandaloneEvent(HOME, {
      kind: "pin:created",
      recordId: "r1",
      pinId: OPEN_PIN_ID,
      element: "btn-1",
      fx: 0.5,
      fy: 0.5,
      text: "still open",
      ts: "2024-01-01T00:00:00.000Z",
    });

    const staging = createFakeStagingService();
    const turnTransactions = withHonestChatAppendBase(
      createFakeTurnTransactionService(),
      chatStore,
    );

    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });
    const { handlerContext, getLaunchedOperations, getPublishedEvents } = buildTestContext({
      chatReader: chatStore,
      chatMutations: chatStore,
      turnTransactions,
      pinReader: pinStore,
      pinMutations: pinStore,
      staging,
      projectStore: createFakeProjectStore({
        root: "/test-root",
        workspaceState: {
          backend: "claude",
          model: "sonnet",
          effort: "medium",
          activeChatId: chatHeader.chatId,
          activePageSlug: HOME,
        },
      }),
      agentRegistry: createFakeAgentRegistry([agentBackend]),
      gateRunner: createFakeGateRunner(),
    });

    const outcome = turnHandlers["turn.start"]({ text: "please look at my pins" }, handlerContext);
    // `beginTurn` (spec §1.2/§1.6) applies `beginAdmission` synchronously before launching —
    // `outcome.events` carries that ONE kernel.stateChanged event, not `[]`.
    expect(outcome.disposition).toBe("started");
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]?.kind).toBe("kernel.stateChanged");

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
    const firstStart = agentBackend.calls.find((c) => c.method === "startTurn");
    if (firstStart?.method !== "startTurn") throw new Error("expected a startTurn call");
    agentBackend.completeRun(firstStart.fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "s1",
    });

    const events = await runPromise;
    expect(events.map((event) => event.kind)).toEqual([
      "page.descriptorsChanged",
      "turn.completed",
    ]);

    const createCall = staging.calls.find((c) => c.method === "createTurnWorkspace");
    if (createCall?.method !== "createTurnWorkspace") {
      throw new Error("expected a createTurnWorkspace call");
    }
    expect(createCall.input.readSet.pins).toHaveLength(1);
    const [pinsEntry] = createCall.input.readSet.pins;
    if (pinsEntry === undefined) throw new Error("expected one readSet.pins entry");
    expect(pinsEntry.pageSlug).toBe(HOME);

    // The captured base came from the port, not a fabricated/placeholder value: recomputing
    // it now (the fake's log never changed mid-turn — `resolveOpenPins` only folds, and this
    // handler's own `sentPins: []` means finalize never appends either) must match exactly.
    const expectedBase = await pinStore.readAppendBase(HOME);
    if ("code" in expectedBase) throw new Error("fixture bug: readAppendBase failed");
    expect(pinsEntry.base).toEqual(expectedBase);

    expect(pinStore.calls.some((c) => c.method === "readAppendBase" && c.pageSlug === HOME)).toBe(
      true,
    );
  });

  test("turn.start builds the real AgentPromptContextV1 and sends the agent-prompt library's composed system prompt and runtime docs — not the placeholder, not an honest empty (phase-8 WP-3)", async () => {
    const HOME = "home" as PageSlug;
    const ABOUT = "about" as PageSlug;
    const OPEN_PIN_ID = "pin-open";

    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

    const pinStore = createFakePinStore();
    await pinStore.appendStandaloneEvent(HOME, {
      kind: "pin:created",
      recordId: "r1",
      pinId: OPEN_PIN_ID,
      element: "btn-1",
      fx: 0.5,
      fy: 0.5,
      text: "make this gauge red",
      ts: "2024-01-01T00:00:00.000Z",
    });

    const pageStore = createFakeDesignStoreForPages({
      pages: [
        { pageSlug: HOME, sha256: "a".repeat(64), bytes: new TextEncoder().encode("home") },
        { pageSlug: ABOUT, sha256: "b".repeat(64), bytes: new TextEncoder().encode("about") },
      ],
    });

    const staging = createFakeStagingService();
    const turnTransactions = withHonestChatAppendBase(
      createFakeTurnTransactionService(),
      chatStore,
    );
    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });
    const fakePrompts = createFakeAgentPromptSource({
      systemPromptText: () => "the composed system prompt",
      runtimeDocs: [{ relPath: "RUNTIME.md", sourcePath: "/fake/RUNTIME.md" }],
    });

    const { handlerContext, getLaunchedOperations, getPublishedEvents } = buildTestContext({
      chatReader: chatStore,
      chatMutations: chatStore,
      turnTransactions,
      pinReader: pinStore,
      pinMutations: pinStore,
      designReader: pageStore,
      staging,
      agentPromptSource: fakePrompts,
      projectStore: createFakeProjectStore({
        root: "/test-root",
        workspaceState: {
          backend: "claude",
          model: "sonnet",
          effort: "medium",
          activeChatId: chatHeader.chatId,
          activePageSlug: HOME,
        },
      }),
      agentRegistry: createFakeAgentRegistry([agentBackend]),
      gateRunner: createFakeGateRunner(),
    });

    const outcome = turnHandlers["turn.start"]({ text: "make this gauge red" }, handlerContext);
    // `beginTurn` (spec §1.2/§1.6) applies `beginAdmission` synchronously before launching —
    // `outcome.events` carries that ONE kernel.stateChanged event, not `[]`.
    expect(outcome.disposition).toBe("started");
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]?.kind).toBe("kernel.stateChanged");

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
    const firstStart = agentBackend.calls.find((c) => c.method === "startTurn");
    if (firstStart?.method !== "startTurn") throw new Error("expected a startTurn call");
    agentBackend.completeRun(firstStart.fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "s1",
    });

    const events = await runPromise;
    expect(events.map((event) => event.kind)).toEqual([
      "page.descriptorsChanged",
      "turn.completed",
    ]);

    // The prompt library was called with the honest AgentPromptContextV1 this handler holds.
    const promptCall = fakePrompts.calls.find((c) => c.method === "systemPrompt");
    if (promptCall?.method !== "systemPrompt") throw new Error("expected a systemPrompt call");
    expect(promptCall.context).toEqual({
      activePageSlug: HOME,
      pageOrder: [HOME, ABOUT],
      kitApiVersion: 1,
      openPins: [{ pageSlug: HOME, text: "make this gauge red" }],
    });
    expect(fakePrompts.calls.some((c) => c.method === "runtimeDocs")).toBe(true);

    // The fake's own runtimeDocs() return value reached the staged workspace input verbatim.
    const createCall = staging.calls.find((c) => c.method === "createTurnWorkspace");
    if (createCall?.method !== "createTurnWorkspace") {
      throw new Error("expected a createTurnWorkspace call");
    }
    expect(createCall.input.runtimeDocs).toEqual([
      { relPath: "RUNTIME.md", sourcePath: "/fake/RUNTIME.md" },
    ]);
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
    // `beginTurn` (spec §1.2/§1.6) applies `beginAdmission` synchronously before launching —
    // `outcome.events` carries that ONE kernel.stateChanged event, not `[]`.
    expect(outcome.disposition).toBe("started");
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]?.kind).toBe("kernel.stateChanged");

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
    // The committed batch leads with the post-commit `page.descriptorsChanged`
    // (defect fix, 2026-07-26) and ends with the terminal event.
    expect(events.map((event) => event.kind)).toEqual([
      "page.descriptorsChanged",
      "turn.completed",
    ]);
    const terminalEvent = events.find((event) => event.kind === "turn.completed");
    if (terminalEvent === undefined) throw new Error("expected a turn.completed event");
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

  // WP-8 item 4 ("Generic `turn.failed` — a typed outcome instead of the catch-all",
  // phase-8 design's documented-debt sweep) plus its own gate-exhaustion-vs-backend-failure
  // follow-up: the three tests below prove exactly what `./turn.ts`'s own header now documents
  // under "THE TERMINAL EVENT" / "GATE-EXHAUSTION-VS-BACKEND-FAILURE — CLOSED" — Gate
  // exhaustion and a backend failure both still terminalize normally (i.e. `"recorded"`), but
  // `"recorded"` now echoes back a typed `reason` (`core/turns/model/terminalize.ts`'s widened
  // `TerminalizeTurnResultV1`), so the two publish DIFFERENT `turn.failed` failure codes
  // (`"GATE_RETRY_EXHAUSTED"` vs. `"BACKEND_FAILED"`) instead of the same fabricated
  // `PERSISTENCE_FAILED` bucket they both used to share. A genuinely different situation — the
  // terminal record itself failing to persist (`"unrecorded"`) — still surfaces the REAL
  // adapter-level failure DTO instead, exactly as before.

  test("Gate exhaustion terminalizes the turn — turn.failed carries a typed GATE_RETRY_EXHAUSTED failure DTO (compare with the backend-failure test below: a DIFFERENT code, not byte-identical anymore)", async () => {
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

    const gateRunner = createFakeGateRunner();
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
      agentRegistry: createFakeAgentRegistry([agentBackend]),
      gateRunner,
    });

    // Rejects the manifest slice on all 4 permitted attempts (`MAX_TURN_ATTEMPTS`,
    // `core/turns/model/fence.ts`) — the zero-page fixture means only the manifest-slice
    // check ever produces an error, the same technique the "genuine Gate retry" test above
    // uses for exactly one retry, repeated until the attempt budget is exhausted instead of
    // stopped after the first.
    for (let i = 0; i < 4; i++) {
      gateRunner.queueRunManifestSliceResult({
        errors: [{ kind: "manifest", code: "MANIFEST_REJECTED", message: "manifest rejected" }],
        slice: null,
      });
    }

    const outcome = turnHandlers["turn.start"]({ text: "please add a page" }, handlerContext);
    // `beginTurn` (spec §1.2/§1.6) applies `beginAdmission` synchronously before launching —
    // `outcome.events` carries that ONE kernel.stateChanged event, not `[]`.
    expect(outcome.disposition).toBe("started");
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]?.kind).toBe("kernel.stateChanged");

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

    for (let attempt = 1; attempt <= 4; attempt++) {
      await waitForPublishedCount("turn.attemptStarted", attempt);
      const starts = agentBackend.calls.filter((c) => c.method === "startTurn");
      const thisStart = starts[attempt - 1];
      if (thisStart?.method !== "startTurn") {
        throw new Error(`expected startTurn call ${attempt}`);
      }
      agentBackend.completeRun(thisStart.fence, {
        kind: "completed",
        finalText: `done-${attempt}`,
        usage: null,
        sessionId: `s${attempt}`,
      });
    }

    const events = await runPromise;
    expect(events).toHaveLength(1);
    const [terminalEvent] = events;
    if (terminalEvent === undefined) throw new Error("expected exactly one terminal event");
    expect(terminalEvent.kind).toBe("turn.failed");
    expect(eventPayloadV1SchemaByKind["turn.failed"].safeParse(terminalEvent.payload).success).toBe(
      true,
    );
    const firstAttemptStarted = getPublishedEvents().find((e) => e.kind === "turn.attemptStarted");
    if (firstAttemptStarted === undefined) throw new Error("expected a turn.attemptStarted event");
    const turnId = (firstAttemptStarted.payload as { readonly turnId: string }).turnId;
    expect(terminalEvent.payload).toEqual({
      turnId,
      outcome: "failed",
      changedPages: [],
      warnings: [],
      failure: {
        code: "GATE_RETRY_EXHAUSTED",
        retryable: false,
        safeMessage: "the turn ended without committing (terminalized/recorded)",
        details: {},
      },
    });
    expect(handlerContext.machines.turn.phase()).toBe("idle");
  });

  test("a backend failure terminalizes the turn — turn.failed carries a typed BACKEND_FAILED failure DTO, DIFFERENT from the Gate-exhaustion test above: 'GATE-EXHAUSTION-VS-BACKEND-FAILURE — CLOSED' makes the two tellable apart", async () => {
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

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
    // `AgentRunOutcome`'s `"backend-error"` case (`core/ports/agent-backend.ts`) — `attempt.ts`'s
    // own `toAttemptOutcome` maps this onto `TurnAttemptOutcomeV1`'s `"failed"`, driving
    // `run-turn.ts`'s `terminalize("failed", outcome.message, undefined, candidateRoot)`.
    agentBackend.completeRun(firstStart.fence, {
      kind: "backend-error",
      message: "the agent process crashed",
      sessionId: null,
    });

    const events = await runPromise;
    expect(events).toHaveLength(1);
    const [terminalEvent] = events;
    if (terminalEvent === undefined) throw new Error("expected exactly one terminal event");
    expect(terminalEvent.kind).toBe("turn.failed");
    const firstAttemptStarted = getPublishedEvents().find((e) => e.kind === "turn.attemptStarted");
    if (firstAttemptStarted === undefined) throw new Error("expected a turn.attemptStarted event");
    const turnId = (firstAttemptStarted.payload as { readonly turnId: string }).turnId;
    // DIFFERENT `failure.code` from the Gate-exhaustion test's expected payload above — proof
    // a consumer CAN tell the two apart now, even though both still reach
    // "terminalized"/"recorded": `run-turn.ts`'s own `outcome.kind === "failed"` call site now
    // passes `"BACKEND_FAILED"` as `terminalizeTurn`'s `reason`, echoed back verbatim.
    expect(terminalEvent.payload).toEqual({
      turnId,
      outcome: "failed",
      changedPages: [],
      warnings: [],
      failure: {
        code: "BACKEND_FAILED",
        retryable: false,
        safeMessage: "the turn ended without committing (terminalized/recorded)",
        details: {},
      },
    });
    expect(handlerContext.machines.turn.phase()).toBe("idle");
  });

  test("a CANCELLED turn publishes turn.cancelled with outcome 'cancelled' — never the catch-all turn.failed/'failed' a deliberate Esc used to be reported as", async () => {
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

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
    // `AgentRunOutcome`'s own `"cancelled"` case (`core/ports/agent-backend.ts:93`) — exactly
    // what `agent/run/model/engine.ts` resolves when the user presses Esc; `attempt.ts` maps it
    // onto `TurnAttemptOutcomeV1`'s cancel, driving `run-turn.ts`'s `terminalize("cancelled", …)`.
    agentBackend.completeRun(firstStart.fence, { kind: "cancelled", exitConfirmed: true });

    const events = await runPromise;
    const [terminalEvent] = events;
    if (terminalEvent === undefined) throw new Error("expected exactly one terminal event");
    const firstAttemptStarted = getPublishedEvents().find((e) => e.kind === "turn.attemptStarted");
    if (firstAttemptStarted === undefined) throw new Error("expected a turn.attemptStarted event");
    const turnId = (firstAttemptStarted.payload as { readonly turnId: string }).turnId;

    // Both halves matter to the user. The KIND is what `entrypoint/model/run-app.ts`'s
    // turn-settled wait and `ui/mirror` see; the OUTCOME is what `Workspace.tsx`'s
    // `terminalRecordLines` prints — it renders `✗ ${outcome}` for anything but "completed",
    // so `"failed"` here put a deliberate cancel on screen as an error.
    expect(terminalEvent.kind).toBe("turn.cancelled");
    expect(
      eventPayloadV1SchemaByKind["turn.cancelled"].safeParse(terminalEvent.payload).success,
    ).toBe(true);
    expect((terminalEvent.payload as { readonly outcome: string }).outcome).toBe("cancelled");
    expect((terminalEvent.payload as { readonly turnId: string }).turnId).toBe(turnId);
    expect(handlerContext.machines.turn.phase()).toBe("idle");
  });

  test("when the terminal record itself fails to persist ('unrecorded'), turn.failed propagates the REAL failure DTO from turnTransactions.terminalize instead of the generic bucket a reason-less recorded termination would still fall into (WP-8 item 4: a typed outcome instead of the catch-all)", async () => {
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

    const baseTurnTransactions = createFakeTurnTransactionService();
    // A REAL adapter-level failure (what `store/adapters/turn-transactions.ts`'s own
    // `toFailureDto` would produce from a genuine store error) — deliberately a DIFFERENT
    // code/message/details than the fabricated `PERSISTENCE_FAILED` bucket, so the assertion
    // below can only pass if this exact object was propagated, not reconstructed generically.
    const REAL_TERMINALIZE_FAILURE: FailureDtoV1 = {
      code: "TRANSACTION_RECOVERY_CONFLICT",
      retryable: true,
      safeMessage: "a recovery transaction is already in flight for this project",
      details: { store: "sqlite-busy" },
    };
    baseTurnTransactions.failNext("terminalize", REAL_TERMINALIZE_FAILURE);

    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });
    const { handlerContext, getLaunchedOperations, getPublishedEvents } = buildTestContext({
      chatReader: chatStore,
      chatMutations: chatStore,
      turnTransactions: withHonestChatAppendBase(baseTurnTransactions, chatStore),
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
      kind: "backend-error",
      message: "the agent process crashed",
      sessionId: null,
    });

    const events = await runPromise;
    expect(events).toHaveLength(1);
    const [terminalEvent] = events;
    if (terminalEvent === undefined) throw new Error("expected exactly one terminal event");
    expect(terminalEvent.kind).toBe("turn.failed");
    expect(eventPayloadV1SchemaByKind["turn.failed"].safeParse(terminalEvent.payload).success).toBe(
      true,
    );
    const firstAttemptStarted = getPublishedEvents().find((e) => e.kind === "turn.attemptStarted");
    if (firstAttemptStarted === undefined) throw new Error("expected a turn.attemptStarted event");
    const turnId = (firstAttemptStarted.payload as { readonly turnId: string }).turnId;
    expect(terminalEvent.payload).toEqual({
      turnId,
      outcome: "failed",
      changedPages: [],
      warnings: [],
      failure: REAL_TERMINALIZE_FAILURE,
    });
    expect(handlerContext.machines.turn.phase()).toBe("idle");
  });

  test("buildValidationInput threads the ABSOLUTE staged candidate TREE ROOT and its inventory to the Gate's per-page runPage() call, and keeps `fileName` at the SHORT display name (the real smoke stage mounts the page's whole closure off a real directory — a bare `${slug}.tsx` fails in the host's fresh scratch cwd, `gate/adapters/gate-runner.ts`'s own test; Finding #6 — `fileName` no longer doubles as the absolute-path carrier)", async () => {
    const HOME = "home" as PageSlug;
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

    const capturedRunPageInputs: {
      readonly source: string;
      readonly slug: PageSlug;
      readonly fileName?: string;
      readonly treeRoot?: string;
      readonly expectedFiles?: readonly { readonly relPath: string; readonly sha256: string }[];
    }[] = [];
    const gateRunner: GateRunner = {
      // The slice IS what decides which pages `runPage` runs for (task 14), so this double
      // must name the entry — an empty slice would mean zero `runPage` calls and this test
      // would assert nothing. The entry is deliberately unlike the slug.
      runManifestSlice: async () => ({
        errors: [],
        slice: { pages: [{ slug: HOME, entry: defaultFakeEntry(HOME) }], active: null },
      }),
      // Never reached on this path — this double implements only the two calls the test
      // drives. A loud refusal rather than a fabricated meta, so a future caller fails here
      // instead of silently passing on invented page settings.
      extractPageMeta: async () => ({
        meta: null,
        errors: [
          { kind: "contract", code: "NOT_STUBBED", message: "extractPageMeta is not stubbed here" },
        ],
      }),
      // Never reached on this path either — the whole-tree scan (task 12) is a separate,
      // once-per-turn call this test does not drive.
      runTreeImports: async () => ({ errors: [], closures: [] }),
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

    const pageStore = createFakeDesignStoreForPages({
      pages: [
        {
          pageSlug: HOME,
          bytes: new TextEncoder().encode("home-source"),
          sha256: "a".repeat(64),
        },
      ],
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
      designReader: pageStore,
      pageMutations: pageStore,
      agentRegistry: createFakeAgentRegistry([agentBackend]),
      gateRunner,
    });

    const outcome = turnHandlers["turn.start"]({ text: "please add a page" }, handlerContext);
    // `beginTurn` (spec §1.2/§1.6) applies `beginAdmission` synchronously before launching —
    // `outcome.events` carries that ONE kernel.stateChanged event, not `[]`.
    expect(outcome.disposition).toBe("started");
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]?.kind).toBe("kernel.stateChanged");

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
    expect(events.map((event) => event.kind)).toEqual([
      "page.descriptorsChanged",
      "turn.completed",
    ]);

    // The real bug (`fixlane-K1-turn-spine.json`'s smoke-sourcePath finding): the Gate's
    // per-page `runPage()` call must resolve to the staged candidate's real file on disk, not
    // a bare `${slug}.tsx` the real host's fresh scratch child process cwd can never find.
    // Finding #6 fix: that absolute location now travels in `treeRoot`, never in `fileName` —
    // `fileName` stays the short display name Gate echoes into a diagnostic's `file` field.
    // The VALIDATION call is the first one. A second `runPage` follows it for the same page:
    // the post-commit `page.descriptorsChanged` (defect fix, 2026-07-26) rebuilds descriptors
    // from the committed sources, and a descriptor is only obtainable by running the Gate over
    // the page — the same second pass `handlers/project.ts` already makes on every open.
    const [call] = capturedRunPageInputs;
    if (call === undefined) throw new Error("expected a captured runPage() call");
    expect(call.slug).toBe(HOME);
    // The SHORT name is the manifest's own tree-relative `entry` — not `design/`-prefixed,
    // not slug-derived. The absolute path is that same entry under the candidate's `design/`.
    expect(call.fileName).toBe(defaultFakeEntry(HOME));
    // The tree the smoke stage mounts from, plus the candidate's own inventory: the entry is
    // in it, hashed, so the mount can verify the bytes it is about to run (task 15).
    expect(call.treeRoot).toBe(`/fake-candidate/${turnId}/design`);
    expect(call.expectedFiles?.map((file) => file.relPath)).toContain(defaultFakeEntry(HOME));
  });

  test("a Gate rejection surfaced through this path carries the SHORT page file name in the published diagnostic's `file` field — no drive letter, no candidate root, no absolute path — while the absolute staged location travels separately in `runPage`'s own `treeRoot` (Finding #6)", async () => {
    const HOME = "home" as PageSlug;
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

    let pageCallCount = 0;
    const capturedEntryPaths: (string | undefined)[] = [];
    const gateRunner: GateRunner = {
      // See the sibling double above: the slice is what drives `runPage` now.
      runManifestSlice: async () => ({
        errors: [],
        slice: { pages: [{ slug: HOME, entry: defaultFakeEntry(HOME) }], active: null },
      }),
      // Never reached on this path — see the sibling double above.
      extractPageMeta: async () => ({
        meta: null,
        errors: [
          { kind: "contract", code: "NOT_STUBBED", message: "extractPageMeta is not stubbed here" },
        ],
      }),
      // Never reached on this path either — see the sibling double above.
      runTreeImports: async () => ({ errors: [], closures: [] }),
      runPage: async (input) => {
        pageCallCount += 1;
        capturedEntryPaths.push(
          input.treeRoot === undefined ? undefined : `${input.treeRoot}/${input.entryRelPath}`,
        );
        // Attempt 1 fails, echoing `input.fileName` into the error's `file` — exactly what the
        // real `runGate` does (`core/ports/gate-runner.ts`'s own doc). Attempt 2 passes, the
        // same "reject once, then default pass" shape the genuine-retry test above uses.
        if (pageCallCount === 1) {
          return {
            ok: false,
            errors: [
              {
                kind: "contract",
                code: "PAGE_CONTRACT_VIOLATION",
                message: "bad contract",
                file: input.fileName,
              },
            ],
            warnings: [],
            descriptor: null,
          };
        }
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

    const pageStore = createFakeDesignStoreForPages({
      pages: [
        {
          pageSlug: HOME,
          bytes: new TextEncoder().encode("home-source"),
          sha256: "a".repeat(64),
        },
      ],
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
      designReader: pageStore,
      pageMutations: pageStore,
      agentRegistry: createFakeAgentRegistry([agentBackend]),
      gateRunner,
    });

    const outcome = turnHandlers["turn.start"]({ text: "please add a page" }, handlerContext);
    // `beginTurn` (spec §1.2/§1.6) applies `beginAdmission` synchronously before launching —
    // `outcome.events` carries that ONE kernel.stateChanged event, not `[]`.
    expect(outcome.disposition).toBe("started");
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]?.kind).toBe("kernel.stateChanged");

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
    const firstStart = agentBackend.calls.find((c) => c.method === "startTurn");
    if (firstStart?.method !== "startTurn") throw new Error("expected a startTurn call");
    agentBackend.completeRun(firstStart.fence, {
      kind: "completed",
      finalText: "done-1",
      usage: null,
      sessionId: "s1",
    });

    await waitForPublishedCount("turn.gateRejected", 1);
    const gateRejected = getPublishedEvents().find((e) => e.kind === "turn.gateRejected");
    if (gateRejected === undefined) throw new Error("expected a turn.gateRejected event");
    const diagnostics = (
      gateRejected.payload as {
        readonly diagnostics: { readonly errors: readonly { readonly file: string | null }[] };
      }
    ).diagnostics;
    const [firstError] = diagnostics.errors;
    if (firstError === undefined) throw new Error("expected exactly one Gate error");
    // The short display name only — no drive letter, no candidate root, no absolute path.
    expect(firstError.file).toBe(defaultFakeEntry(HOME));
    expect(firstError.file).not.toContain("/test-root");
    expect(firstError.file).not.toContain("fake-candidate");
    expect(firstError.file).not.toMatch(/^[A-Za-z]:/);

    // The absolute staged path travels separately, in its own `sourcePath` field.
    expect(capturedEntryPaths[0]).toMatch(/^\/fake-candidate\//);
    expect(capturedEntryPaths[0]).toContain(`design/${defaultFakeEntry(HOME)}`);

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
    expect(events.map((event) => event.kind)).toEqual([
      "page.descriptorsChanged",
      "turn.completed",
    ]);
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
    // `beginTurn` (spec §1.2/§1.6) applies `beginAdmission` synchronously before launching —
    // `outcome.events` carries that ONE kernel.stateChanged event, not `[]`.
    expect(outcome.disposition).toBe("started");
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]?.kind).toBe("kernel.stateChanged");

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
    // The committed batch leads with the post-commit `page.descriptorsChanged`
    // (defect fix, 2026-07-26) and ends with the terminal event.
    expect(events.map((event) => event.kind)).toEqual([
      "page.descriptorsChanged",
      "turn.completed",
    ]);
  });

  test("names a still-unnamed chat from the turn's own first line, so /chats stops showing the fresh-chat placeholder", async () => {
    // A chat created by `/new` carries `displayName: null` until its first `user` record
    // exists. Admission appends exactly that record — but nothing republished the summary, so
    // the `/chats` popup kept showing the fresh-chat placeholder for the whole session.
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");
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

    turnHandlers["turn.start"](
      { text: "Сделай дашборд с выводом времени\nвторая строка игнорируется" },
      handlerContext,
    );
    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    const runPromise = operation.run();

    for (let i = 0; i < 200; i++) {
      if (getPublishedEvents().some((e) => e.kind === "chat.changed")) break;
      await wrap(Bun.sleep(0));
    }

    const changed = getPublishedEvents().find((e) => e.kind === "chat.changed");
    expect(changed).toBeDefined();
    expect(eventPayloadV1SchemaByKind["chat.changed"].safeParse(changed!.payload).success).toBe(
      true,
    );
    const payload = changed!.payload as {
      readonly updated: readonly { readonly chatId: string; readonly displayName: string }[];
    };
    expect(payload.updated).toHaveLength(1);
    expect(payload.updated[0]?.chatId).toBe(REAL_CHAT_ID);
    // Design §3.9: the FIRST LINE of the first user record, never the whole message.
    expect(payload.updated[0]?.displayName).toBe("Сделай дашборд с выводом времени");

    const firstStart = agentBackend.calls.find((c) => c.method === "startTurn");
    if (firstStart?.method !== "startTurn") throw new Error("expected a startTurn call");
    agentBackend.completeRun(firstStart.fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "s1",
    });
    await runPromise;
  });
});

describe("turn.start — a rejected admission (Gap F)", () => {
  // Task 4's own brief, Step 1 — a `staging.createTurnWorkspace` failure blocks
  // `runAdmission` at phase `"workspace"` (`admission.ts`'s own `if ("code" in workspace)
  // return {kind: "blocked", phase: "workspace", failure: workspace}`), AFTER `admit()` and
  // the chat-append-base read already succeeded — the exact shape that used to log and
  // return `[]`, stranding the machine in `"admitting"` forever (fix-bundle spec §1.3/§1.4;
  // `./turn.ts`'s own `terminalizeRejectedAdmission` and `admissionFailureDto` are the fix).
  const PERSISTENCE_FAILURE: FailureDtoV1 = {
    code: "PERSISTENCE_FAILED",
    retryable: false,
    safeMessage: "filesystem open failed (ENOENT)",
    details: {},
  };

  test("returns to idle, publishes turn.failed naming the phase, and accepts the next turn.start", async () => {
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

    const staging = createFakeStagingService();
    const { handlerContext, getLaunchedOperations } = buildTestContext({
      chatReader: chatStore,
      chatMutations: chatStore,
      staging: { ...staging, createTurnWorkspace: async () => PERSISTENCE_FAILURE },
      projectStore: createFakeProjectStore({
        root: "/test-root",
        workspaceState: {
          backend: "claude",
          model: "sonnet",
          effort: "medium",
          activeChatId: chatHeader.chatId,
        },
      }),
      agentRegistry: createFakeAgentRegistry([
        createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES }),
      ]),
    });

    const outcome = turnHandlers["turn.start"]({ text: "hello" }, handlerContext);
    expect(outcome.disposition).toBe("started");

    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    const events = await operation.run();

    expect(handlerContext.machines.turn.phase()).toBe("idle");
    expect(handlerContext.readKernelState().turn.activeTurnId).toBeNull();

    const failed = events.find((e) => e.kind === "turn.failed");
    if (failed === undefined) throw new Error("expected a turn.failed event");
    const failedPayload = failed.payload as { readonly failure: { readonly safeMessage: string } };
    expect(failedPayload.failure.safeMessage).toContain("workspace");
    expect(failedPayload.failure.safeMessage).toContain("ENOENT");

    // The hang itself: a second start must be accepted, not TURN_ALREADY_ACTIVE.
    const second = turnHandlers["turn.start"]({ text: "again" }, handlerContext);
    expect(second.disposition).toBe("started");
  });

  test("writes a durable system:error chat record for the rejected admission", async () => {
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

    const terminalized: unknown[] = [];
    const turnTransactions: TurnTransactionService = {
      ...createFakeTurnTransactionService(),
      terminalize: async (input) => {
        terminalized.push(input.record);
        return { transactionId: "tx-1" };
      },
    };

    const staging = createFakeStagingService();
    const { handlerContext, getLaunchedOperations } = buildTestContext({
      chatReader: chatStore,
      chatMutations: chatStore,
      turnTransactions,
      staging: { ...staging, createTurnWorkspace: async () => PERSISTENCE_FAILURE },
      projectStore: createFakeProjectStore({
        root: "/test-root",
        workspaceState: {
          backend: "claude",
          model: "sonnet",
          effort: "medium",
          activeChatId: chatHeader.chatId,
        },
      }),
      agentRegistry: createFakeAgentRegistry([
        createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES }),
      ]),
    });

    turnHandlers["turn.start"]({ text: "hello" }, handlerContext);
    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    await operation.run();

    expect(terminalized).toHaveLength(1);
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
    // The committed batch leads with the post-commit `page.descriptorsChanged`
    // (defect fix, 2026-07-26) and ends with the terminal event.
    expect(events.map((event) => event.kind)).toEqual([
      "page.descriptorsChanged",
      "turn.completed",
    ]);
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
    // "admitting" is deliberately NOT listed here — see the dedicated test below (right
    // before this array's own loop runs), which reaches it through the real `turn.start`
    // handler instead of `admitTo`.
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

  test('from "admitting" reached via the real turn.start handler (not `admitTo` + a hand-set activeTurnId — a state production could never construct that way): requestCancel still moves to terminalizing, a completed outcome, no new launched operation', () => {
    const { handlerContext, getLaunchedOperations } = buildTestContext();

    const started = turnHandlers["turn.start"]({ text: "hello" }, handlerContext);
    expect(started.disposition).toBe("started");
    expect(handlerContext.machines.turn.phase()).toBe("admitting");
    const turnId = handlerContext.readKernelState().turn.activeTurnId;
    expect(turnId).not.toBeNull();
    if (turnId === null) return;

    const cancelled = turnHandlers["turn.cancel"]({ turnId }, handlerContext);

    expect(cancelled.disposition).not.toBe("no-op");
    expect(handlerContext.machines.turn.phase()).toBe("terminalizing");
    expect(cancelled).toEqual({
      disposition: "completed",
      events: [
        {
          kind: "kernel.stateChanged",
          payload: {
            modelId: "kernel.turn.state",
            action: "kernel.turn.requestCancel",
            previousTag: "admitting",
            nextTag: "terminalizing",
            metadata: {},
          },
          correlation: { turnId },
        },
      ],
    });
    // The ONE operation `turn.start` itself already launched (`runTurnStart`, still pending) —
    // cancelling from "admitting" with no live attempt launches nothing new, matching every
    // SINGLE_HOP_PHASES case below.
    expect(getLaunchedOperations()).toHaveLength(1);
  });

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

describe('turnHandlers["turn.start"] — WP-7 same-process session resume', () => {
  test("the manifest's projectId resolves session through sessionScope + evaluateSessionPlan, not the unconditional fresh path (WP-7)", async () => {
    const HOME = "home" as PageSlug;
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

    const turnTransactions = withHonestChatAppendBase(
      createFakeTurnTransactionService(),
      chatStore,
    );
    const pinStore = createFakePinStore();
    const staging = createFakeStagingService();
    const sessionCheckpoint = createFakeSessionCheckpointService();
    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });

    const scopeId = agentBackend.sessionScope({
      account: null,
      model: FAKE_BACKEND_CAPABILITIES.defaultSelection.model,
      workspaceIdentity: "ws-1",
    });
    await sessionCheckpoint.advanceCheckpoint({
      chatId: chatHeader.chatId,
      sessionScopeId: scopeId,
      sessionId: "prior-session",
    });

    const { handlerContext, getLaunchedOperations, getPublishedEvents } = buildTestContext({
      chatReader: chatStore,
      chatMutations: chatStore,
      turnTransactions,
      pinReader: pinStore,
      pinMutations: pinStore,
      staging,
      sessionCheckpoint,
      projectStore: createFakeProjectStore({
        root: "/test-root",
        manifest: { projectId: "ws-1" },
        workspaceState: {
          backend: "claude",
          model: FAKE_BACKEND_CAPABILITIES.defaultSelection.model,
          effort: "medium",
          activeChatId: chatHeader.chatId,
          activePageSlug: HOME,
        },
      }),
      agentRegistry: createFakeAgentRegistry([agentBackend]),
      gateRunner: createFakeGateRunner(),
    });

    turnHandlers["turn.start"]({ text: "continue" }, handlerContext);
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

    const startCall = agentBackend.calls.find((c) => c.method === "startTurn");
    if (startCall?.method !== "startTurn") throw new Error("expected a startTurn call");
    expect(startCall.task.session).toEqual({
      kind: "resume",
      sessionId: "prior-session",
      promptDelta: null,
    });

    agentBackend.completeRun(startCall.fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "prior-session",
    });
    await runPromise;
  });

  test("a manifest-read failure refuses turn.start — logged, never a fabricated workspaceIdentity (WP-7)", async () => {
    const HOME = "home" as PageSlug;
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");
    const turnTransactions = withHonestChatAppendBase(
      createFakeTurnTransactionService(),
      chatStore,
    );

    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });
    const projectStore = createFakeProjectStore({
      root: "/test-root",
      workspaceState: {
        backend: "claude",
        model: FAKE_BACKEND_CAPABILITIES.defaultSelection.model,
        effort: "medium",
        activeChatId: chatHeader.chatId,
        activePageSlug: HOME,
      },
    });
    projectStore.failNext("readManifest", {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: "simulated manifest read failure",
      details: {},
    });

    const { handlerContext, getLaunchedOperations } = buildTestContext({
      chatReader: chatStore,
      chatMutations: chatStore,
      turnTransactions,
      pinReader: createFakePinStore(),
      pinMutations: createFakePinStore(),
      projectStore,
      agentRegistry: createFakeAgentRegistry([agentBackend]),
      gateRunner: createFakeGateRunner(),
    });

    turnHandlers["turn.start"]({ text: "hi" }, handlerContext);
    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    const events = await operation.run();

    // `abortEarlyAdmission` (fix round 1): the refusal walks the machine back to idle instead
    // of returning `[]` and stranding it — see `assertEarlyPortRefusalRecoversToIdle`'s own
    // doc comment for the full citation. Task 4's own addition: a `turn.failed` naming this
    // branch's real cause now follows the three `kernel.stateChanged` transition events.
    expect(events).toHaveLength(4);
    expect(events.slice(0, 3).every((e) => e.kind === "kernel.stateChanged")).toBe(true);
    const failed = events[3];
    if (failed === undefined || failed.kind !== "turn.failed") {
      throw new Error("expected the fourth event to be turn.failed");
    }
    const failedPayload = failed.payload as { readonly failure: { readonly safeMessage: string } };
    expect(failedPayload.failure.safeMessage).toContain("simulated manifest read failure");
    expect(handlerContext.machines.turn.phase()).toBe("idle");
    expect(handlerContext.readKernelState().turn.activeTurnId).toBeNull();
    expect(agentBackend.calls.some((c) => c.method === "startTurn")).toBe(false);
  });

  test("a committed turn advances the session checkpoint under the manifest-derived scope (WP-7)", async () => {
    const HOME = "home" as PageSlug;
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");
    const turnTransactions = withHonestChatAppendBase(
      createFakeTurnTransactionService(),
      chatStore,
    );
    const sessionCheckpoint = createFakeSessionCheckpointService();
    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });

    const { handlerContext, getLaunchedOperations, getPublishedEvents } = buildTestContext({
      chatReader: chatStore,
      chatMutations: chatStore,
      turnTransactions,
      pinReader: createFakePinStore(),
      pinMutations: createFakePinStore(),
      staging: createFakeStagingService(),
      sessionCheckpoint,
      projectStore: createFakeProjectStore({
        root: "/test-root",
        manifest: { projectId: "ws-1" },
        workspaceState: {
          backend: "claude",
          model: FAKE_BACKEND_CAPABILITIES.defaultSelection.model,
          effort: "medium",
          activeChatId: chatHeader.chatId,
          activePageSlug: HOME,
        },
      }),
      agentRegistry: createFakeAgentRegistry([agentBackend]),
      gateRunner: createFakeGateRunner(),
    });

    turnHandlers["turn.start"]({ text: "first turn" }, handlerContext);
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

    const startCall = agentBackend.calls.find((c) => c.method === "startTurn");
    if (startCall?.method !== "startTurn") throw new Error("expected a startTurn call");
    expect(startCall.task.session.kind).toBe("fresh"); // no prior checkpoint — honest first turn

    agentBackend.completeRun(startCall.fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "sess-first",
    });
    const events = await runPromise;
    // The committed batch leads with the post-commit `page.descriptorsChanged`
    // (defect fix, 2026-07-26) and ends with the terminal event.
    expect(events.map((event) => event.kind)).toEqual([
      "page.descriptorsChanged",
      "turn.completed",
    ]);

    const scopeId = agentBackend.sessionScope({
      account: null,
      model: FAKE_BACKEND_CAPABILITIES.defaultSelection.model,
      workspaceIdentity: "ws-1",
    });
    const verdict = await sessionCheckpoint.evaluateResume({
      chatId: chatHeader.chatId,
      sessionScopeId: scopeId,
    });
    expect(verdict).toMatchObject({ kind: "resume", sessionId: "sess-first" });
  });

  test("acceptance (WP-7): the second turn.start in one process resumes the first turn's session", async () => {
    const HOME = "home" as PageSlug;
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");
    const turnTransactions = withHonestChatAppendBase(
      createFakeTurnTransactionService(),
      chatStore,
    );
    const sessionCheckpoint = createFakeSessionCheckpointService();
    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });
    const projectStore = createFakeProjectStore({
      root: "/test-root",
      manifest: { projectId: "ws-1" },
      workspaceState: {
        backend: "claude",
        model: FAKE_BACKEND_CAPABILITIES.defaultSelection.model,
        effort: "medium",
        activeChatId: chatHeader.chatId,
        activePageSlug: HOME,
      },
    });

    const { handlerContext, getLaunchedOperations } = buildTestContext({
      chatReader: chatStore,
      chatMutations: chatStore,
      turnTransactions,
      pinReader: createFakePinStore(),
      pinMutations: createFakePinStore(),
      staging: createFakeStagingService(),
      sessionCheckpoint,
      projectStore,
      agentRegistry: createFakeAgentRegistry([agentBackend]),
      gateRunner: createFakeGateRunner(),
    });

    async function runOneTurn(text: string, sessionId: string) {
      // `agentBackend.calls` accumulates across BOTH dispatches in this test (never cleared
      // between them) — waiting for "count exceeds what it was before THIS dispatch", not
      // "any startTurn call exists at all," is what makes the second call correctly wait for
      // the SECOND turn's own attempt instead of re-grabbing the first turn's already-settled
      // fence (which `completeRun` would then silently ignore, and the run would never
      // resolve).
      const priorStartCount = agentBackend.calls.filter((c) => c.method === "startTurn").length;
      turnHandlers["turn.start"]({ text }, handlerContext);
      const launches = getLaunchedOperations();
      const operation = launches[launches.length - 1];
      if (operation === undefined) throw new Error("expected a launched operation");
      const runPromise = operation.run();

      for (let i = 0; i < 200; i++) {
        const count = agentBackend.calls.filter((c) => c.method === "startTurn").length;
        if (count > priorStartCount) break;
        await wrap(Bun.sleep(0));
      }
      const startCall = agentBackend.calls.filter((c) => c.method === "startTurn").pop();
      if (startCall?.method !== "startTurn") throw new Error("expected a startTurn call");
      agentBackend.completeRun(startCall.fence, {
        kind: "completed",
        finalText: `done: ${text}`,
        usage: null,
        sessionId,
      });
      await runPromise;
      return startCall;
    }

    const firstStart = await runOneTurn("first message", "sess-1");
    expect(firstStart.task.session.kind).toBe("fresh");

    const secondStart = await runOneTurn("second message", "sess-2");
    expect(secondStart.task.session).toEqual({
      kind: "resume",
      sessionId: "sess-1",
      promptDelta: null,
    });
  });

  test("acceptance (WP-7): a scope change (simulating any of the 4 storage-identity §6.2 triggers, including a process restart) starts honestly fresh, never a stale resume", async () => {
    const HOME = "home" as PageSlug;
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");
    const turnTransactions = withHonestChatAppendBase(
      createFakeTurnTransactionService(),
      chatStore,
    );
    const sessionCheckpoint = createFakeSessionCheckpointService();
    // A checkpoint under a DIFFERENT scope stands in for any of storage-identity §6.2's four
    // triggers (backend, account, model, or workspace identity changing) — including a process
    // restart's own `UNRESUMABLE_ACCOUNT` — without needing a real subprocess (Task 4, at the
    // mechanism's own layer, is the genuine cross-process proof).
    await sessionCheckpoint.advanceCheckpoint({
      chatId: chatHeader.chatId,
      sessionScopeId: "some-other-scope-entirely",
      sessionId: "stale-session",
    });

    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });
    const { handlerContext, getLaunchedOperations } = buildTestContext({
      chatReader: chatStore,
      chatMutations: chatStore,
      turnTransactions,
      pinReader: createFakePinStore(),
      pinMutations: createFakePinStore(),
      staging: createFakeStagingService(),
      sessionCheckpoint,
      projectStore: createFakeProjectStore({
        root: "/test-root",
        manifest: { projectId: "ws-1" },
        workspaceState: {
          backend: "claude",
          model: FAKE_BACKEND_CAPABILITIES.defaultSelection.model,
          effort: "medium",
          activeChatId: chatHeader.chatId,
          activePageSlug: HOME,
        },
      }),
      agentRegistry: createFakeAgentRegistry([agentBackend]),
      gateRunner: createFakeGateRunner(),
    });

    turnHandlers["turn.start"]({ text: "hi" }, handlerContext);
    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected a launched operation");
    const runPromise = operation.run();
    for (let i = 0; i < 200; i++) {
      if (agentBackend.calls.some((c) => c.method === "startTurn")) break;
      await wrap(Bun.sleep(0));
    }
    const startCall = agentBackend.calls.find((c) => c.method === "startTurn");
    if (startCall?.method !== "startTurn") throw new Error("expected a startTurn call");
    expect(startCall.task.session.kind).toBe("fresh");

    agentBackend.completeRun(startCall.fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "s-new",
    });
    await runPromise;
  });
});

describe("turn.start — canonical page source paths (Gap G)", () => {
  test("hands staging the CANONICAL page path, not the agent workspace's flat one", async () => {
    const HOME = "home" as PageSlug;
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

    const pageStore = createFakeDesignStoreForPages({
      pages: [
        {
          pageSlug: HOME,
          bytes: new TextEncoder().encode("home-source"),
          sha256: "a".repeat(64),
        },
      ],
    });

    const staging = createFakeStagingService();
    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });
    const { handlerContext, deps, getLaunchedOperations } = buildTestContext({
      chatReader: chatStore,
      chatMutations: chatStore,
      turnTransactions: withHonestChatAppendBase(createFakeTurnTransactionService(), chatStore),
      designReader: pageStore,
      pageMutations: pageStore,
      staging,
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
    });

    const outcome = turnHandlers["turn.start"]({ text: "hello" }, handlerContext);
    // `beginTurn` (spec §1.2/§1.6) applies `beginAdmission` synchronously before launching —
    // `outcome.events` carries that ONE kernel.stateChanged event, not `[]`.
    expect(outcome.disposition).toBe("started");
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]?.kind).toBe("kernel.stateChanged");

    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected a launched operation");
    const runPromise = operation.run();

    for (let i = 0; i < 200; i++) {
      if (agentBackend.calls.some((c) => c.method === "startTurn")) break;
      await wrap(Bun.sleep(0));
    }
    const startCall = agentBackend.calls.find((c) => c.method === "startTurn");
    if (startCall?.method !== "startTurn") throw new Error("expected a startTurn call");
    agentBackend.completeRun(startCall.fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "s1",
    });
    await runPromise;

    // The real bug (Gap G, now re-expressed for the design tree): the staged `sourcePath` used
    // to be built from the agent WORKSPACE's own flat page-file convention
    // (`pages/<slug>.tsx`, joined onto `projectStore.root`) — a path that never exists on disk.
    // Canonical storage is `<root>/.termcraft/design/<treeRelPath>`, and `treeRelPath` comes
    // from `listTree()`, never from the slug (this fixture's own entry is
    // `screens/<slug>/view.tsx`, which is deliberately NOT what any slug-derivation would
    // produce). `staging.createTurnWorkspace` is the one call that receives
    // `admission.workspace.treeFiles` verbatim, so its own captured `calls` array is the most
    // direct place to prove which convention actually reached it.
    const createCall = staging.calls.find((c) => c.method === "createTurnWorkspace");
    if (createCall?.method !== "createTurnWorkspace") {
      throw new Error("expected a createTurnWorkspace call");
    }
    expect(createCall.input.treeFiles.map((file) => file.sourcePath)).toEqual([
      `${deps.projectStore.root}/.termcraft/design/pages.json`,
      `${deps.projectStore.root}/.termcraft/design/${defaultFakeEntry(HOME)}`,
    ]);
    // …and staging received every file at its TREE-relative path, unprefixed — `pages.json`
    // included, because the manifest is part of the tree and is staged, never synthesized.
    expect(createCall.input.treeFiles.map((file) => file.relPath)).toEqual([
      "pages.json",
      defaultFakeEntry(HOME),
    ]);
  });
});

describe("turn.start — activeTurnId never outlives the phase that justified it (fix-bundle spec §1.5)", () => {
  test("every non-idle phase implies a non-null activeTurnId, and idle implies null", async () => {
    const chatStore = createFakeChatStore();
    const chatHeader = await chatStore.create();
    if ("code" in chatHeader) throw new Error("unexpected chat-create failure");

    const agentBackend = createFakeAgentBackend({ capabilities: FAKE_BACKEND_CAPABILITIES });
    const { handlerContext, getLaunchedOperations } = buildTestContext({
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
      agentRegistry: createFakeAgentRegistry([agentBackend]),
      gateRunner: createFakeGateRunner(),
    });

    const observed: { phase: string; id: string | null }[] = [];
    const record = () =>
      observed.push({
        phase: handlerContext.machines.turn.phase(),
        id: handlerContext.readKernelState().turn.activeTurnId,
      });

    // `handlerContext.machines.turn` is the narrower `HandlerMachine` view, `phaseAtom`
    // deliberately excluded (`handlers/types.ts`'s own comment) — `turnRunner.machine` is the
    // SAME underlying `StateMachine`, exposed FULL, so this test-only observer can subscribe.
    handlerContext.turnRunner.machine.phaseAtom.subscribe(record);

    const outcome = turnHandlers["turn.start"]({ text: "hello" }, handlerContext);
    expect(outcome.disposition).toBe("started");

    const [operation] = getLaunchedOperations();
    if (operation === undefined) throw new Error("expected exactly one launched operation");
    const runPromise = operation.run();

    for (let i = 0; i < 200; i++) {
      if (agentBackend.calls.some((c) => c.method === "startTurn")) break;
      await wrap(Bun.sleep(0));
    }
    const startCall = agentBackend.calls.find((c) => c.method === "startTurn");
    if (startCall?.method !== "startTurn") throw new Error("expected a startTurn call");
    agentBackend.completeRun(startCall.fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "s1",
    });

    await runPromise;
    record();

    for (const sample of observed) {
      if (sample.phase === "idle") expect(sample.id).toBeNull();
      else expect(sample.id).not.toBeNull();
    }
  });
});

/**
 * `terminalChangedPages` directly (task-14 review round 1, Minor 5). It had exactly one test —
 * the §10 smoke — so mutating it to `return []` reddened only that, and its warn-and-drop
 * branch was uncovered entirely. It is also the function whose SEMANTIC SHIFT this task's own
 * report raises (§9.5): `turn.completed`'s `sourceHash` now means "the page's ENTRY FILE's
 * hash" while "changed" is a CLOSURE fact.
 */
describe("terminalChangedPages", () => {
  const HOME = "home" as PageSlug;
  const ABOUT = "about" as PageSlug;
  const entry = (slug: PageSlug, path: string) => ({ slug, entry: path });
  const candidateWith = (files: readonly { relPath: string; sha256: string }[]) =>
    ({
      root: "/fake-candidate/t",
      totalBytes: 0,
      manifestText: "{}",
      treeFiles: files.map((f) => ({ ...f, size: 1 })),
      fileChanges: [],
    }) as unknown as Parameters<typeof terminalChangedPages>[2];

  test("reports each changed page's ENTRY FILE hash, resolved through the manifest", () => {
    const result = terminalChangedPages(
      [HOME, ABOUT],
      [entry(HOME, "screens/landing/main.tsx"), entry(ABOUT, "widgets/about.tsx")],
      candidateWith([
        { relPath: "screens/landing/main.tsx", sha256: "a".repeat(64) },
        { relPath: "widgets/about.tsx", sha256: "b".repeat(64) },
        { relPath: "lib/theme.ts", sha256: "c".repeat(64) },
      ]),
    );
    // Entries are arbitrary tree paths, so this also proves the lookup goes through the
    // manifest rather than deriving `pages/<slug>.tsx`.
    expect(result).toEqual([
      { pageSlug: HOME, sourceHash: "a".repeat(64) },
      { pageSlug: ABOUT, sourceHash: "b".repeat(64) },
    ]);
  });

  test("a page whose closure changed but whose ENTRY did not still reports its unchanged entry hash", () => {
    // The semantic the report flags: a `lib/theme.ts` edit marks `home` changed while
    // `home`'s own bytes never moved. The field says "this page's source hash", so reporting
    // the unchanged one is correct — and is exactly why this field can no longer be used to
    // decide WHETHER a page changed.
    const result = terminalChangedPages(
      [HOME],
      [entry(HOME, "screens/landing/main.tsx")],
      candidateWith([
        { relPath: "screens/landing/main.tsx", sha256: "a".repeat(64) },
        { relPath: "lib/theme.ts", sha256: "z".repeat(64) },
      ]),
    );
    expect(result).toEqual([{ pageSlug: HOME, sourceHash: "a".repeat(64) }]);
  });

  test("THE WARN-AND-DROP PATH: a slug with no manifest entry, or an entry with no candidate file, is dropped and logged — never given a fabricated hash", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // (a) the slug is not in the manifest at all
      expect(terminalChangedPages([HOME], [], candidateWith([]))).toEqual([]);
      // (b) the manifest binds it, but the candidate holds no such file
      expect(
        terminalChangedPages([HOME], [entry(HOME, "screens/gone.tsx")], candidateWith([])),
      ).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("an empty changed-page list yields an empty report, without warning", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(terminalChangedPages([], [entry(HOME, "screens/a.tsx")], candidateWith([]))).toEqual(
        [],
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
