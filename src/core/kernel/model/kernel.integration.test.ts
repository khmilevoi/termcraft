import { describe, expect, test } from "bun:test";

import { type KernelDeps, createKernel } from "core";
import type { EventEnvelopeV1 } from "core/mailbox";
import type {
  AgentRegistry,
  BackendCapabilities,
  ChatHandleV1,
  ChatHeaderV1,
  ChatLoadResultV1,
  ChatMutations,
  ChatReader,
  ExportPublishPort,
  GateRunner,
  ReadSetAppendBaseV1,
} from "core/ports";
import {
  createFakeAgentBackend,
  createFakeAgentRegistry,
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
  type EventPayloadByKindV1,
  type FailureDtoV1,
  eventPayloadV1SchemaByKind,
} from "core/protocol";
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

/**
 * Kernel-assembly WP-1 Task 11 — the package's own integration gate (the plan's §11
 * scenario). `createKernel`/`KernelDeps` are imported through `"core"` (Task 10's new
 * public entry) rather than `core/kernel`/a relative `../types` path, so this test
 * doubles as Task 10's own consumption proof: if the barrel ever stopped re-exporting
 * either name, this file would fail to compile, not merely `core/index.test.ts`.
 *
 * GENERALIZES two earlier, narrower proofs already in `./kernel.test.ts`:
 * - "the real-registry spine (kernel-assembly Task 9 Step C3, §11)" — `project.open ->
 *   project.setTrust -> chat.create -> page.removePlan -> page.removeDiscardPlan`, a
 *   stand-in built while `turn.start` was still blocked by Gap 4.
 * - "the turn.start spine (kernel-assembly Task 9, Gap 4 closeout)" — the brief's own
 *   named scenario once Gap 4 closed: `project.open -> project.setTrust -> chat.create
 *   -> chat.switch -> turn.start` through admission/attempt/a genuine Gate retry/
 *   finalize.
 *
 * This test reuses that second spine's exact harness and proven recipe (`buildDeps`,
 * the chat-store stub, the Gate-retry script) verbatim — it is the correct base: Gap 4
 * is closed, so the brief's own scripted sequence is genuinely dispatchable end to end
 * through this point. It extends the sequence one command further, `export.start`, per
 * the plan's own §11 wording. Both `kernel.test.ts` describe blocks are left in place
 * (they still pass, and deleting Task 9's own already-reviewed proofs is outside this
 * test-only task's scope) — this file is the new, canonical, single WP-1 gate.
 *
 * NOT INCLUDED: `page.removePlan`/`page.removeDiscardPlan`. The plan's own §11 scripted
 * sequence ("project.open -> chat.create -> (chat.switch) -> turn.start -> export.start
 * -> the export publish flow") never names a `page.*` command, and `project.setTrust`
 * is folded in as the one legitimate preparatory dispatch the guard structurally
 * requires (`capabilities/model/guards.ts`'s `projectUntrustedReason`/
 * `PROJECT_UNTRUSTED` rejects `chat.create` — and everything after it — until trust is
 * resolved; `createFakeTrustGate()` starts with zero durable grants, so `project.open`
 * alone always resolves to `"untrusted-read-only"` here, exactly like both spines
 * above already establish).
 *
 * `turn.committed` IN THE PLAN'S OWN PROSE is this Kernel's real `turn.completed`
 * event kind (`core/protocol/model/event-kind.ts`'s closed `EventKindV1` union has no
 * member literally named `turn.committed`) — `RunTurnResultV1`'s own
 * `"finalized"`+`"committed"` branch is exactly what `handlers/turn.ts` maps to
 * `turn.completed` (`outcome: "completed"`), so this test asserts that kind, matching
 * both prior spines' own usage.
 *
 * "THE FAKE BACKEND EDITS STAGING" (the plan's own wording for the `turn.start` step):
 * realized here identically to the already-verified Gap-4-closure spine's own resolved
 * approach — a deliberately ZERO-PAGE project isolates the admission/attempt/gate-
 * retry/finalize WIRING this test proves without needing per-page byte-level plumbing
 * (`core/turns/model/run-turn.test.ts`'s own suite already proves per-page composition
 * exhaustively, including a genuine Gate-retry case; `handlers/turn.test.ts`'s own
 * identically-shaped fixture uses the same simplification for the same reason). No
 * `core/ports/fakes` primitive today lets a caller inject a distinct "the agent edited
 * page X" byte payload mid-turn: `FakeStagingService`'s per-workspace content
 * (`core/ports/fakes/staging.ts`) is entirely deterministic, derived automatically
 * from `CreateTurnWorkspaceInputV1.pages`/`runtimeDocs`/`manifestSlice` at
 * `createTurnWorkspace` time and never mutable by a caller afterward — extending that
 * fake to support one would be a different module's deliverable, outside this
 * test-only task's authorized scope.
 *
 * GENUINE BLOCKER, FLAGGED (not weakened around) — `export.start` / the export publish
 * flow: `core/kernel/model/handlers/preview-export.ts`'s `handleExportStart` is a
 * documented, UNCONDITIONAL no-op ("Gap B" in that file's own header): every one of
 * `core/export`'s already-landed composition functions this family is instructed to
 * reuse (`captureExportSnapshot`, `runExportRendering`, `assembleExportPackage`,
 * `publishExport`) requires the FULL `StateMachine<ExportState, ExportAction>`
 * (`phaseAtom` included), while `HandlerContext.machines.export` is typed
 * `HandlerMachine<ExportState, ExportAction>` (`./handlers/types.ts`'s deliberate
 * `Pick` that excludes `phaseAtom`, closing the escape hatch Task 9 fix round 1
 * found) — verified there by a `tsc --noEmit` probe recorded in that file's own
 * header, re-confirmed by this test rather than taken on faith (see the assertions on
 * `exportStartResult`/`exportPublish.calls` below). This is NOT a missing-precondition
 * gap a preparatory dispatch could route around: `capabilities/model/guards.ts`'s own
 * `familySpecificReason` case `"export.start"` only checks `EXPORT_TRANSITION_TABLE`'s
 * `idle -> preparing` legality (confirmed legal, independent of trust/turn-lock once
 * this sequence reaches it) — the guard genuinely ADMITS the command; it is the
 * handler's own type contract that refuses to compose the real chain, regardless of
 * what state precedes it. Widening `HandlerContext.machines.export` (or implementing
 * `export.start` for real) is a different family's file/contract and a decision this
 * test-only task ("commit test(core): drive the assembled kernel end to end") is not
 * authorized to make unilaterally — flagged here, with the same file:line-cited rigor
 * this project's other genuine gaps (Gap 3, Gap 4) were flagged with, for a
 * maintainer/planner decision, per this task's own brief ("if a genuine blocker
 * emerges, NEEDS_CONTEXT with specifics — do not weaken assertions to pass"). The
 * assertions below describe TODAY's real, honest behavior (accepted, `"no-op"`, zero
 * plans published) — not the plan's own "exactly one plan" target — so this test will
 * go RED the moment a future change starts routing `export.start` through the real
 * composition without also updating this file, which is the intended tripwire.
 */

/** Same deterministic, no-real-crypto hash helper both prior spines already use. */
function fakeSha256Hex(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) | 0;
  const base = (h >>> 0).toString(16).padStart(8, "0");
  return base.repeat(8).slice(0, 64);
}

/**
 * A minimal, locally-defined `ChatMutations & ChatReader` double that mints a REAL
 * UUIDv7 `chatId` — the same documented fixture `./kernel.test.ts`'s own "turn.start
 * spine" uses (see that file's identical helper for the full rationale):
 * `createFakeChatStore`'s own `create()` mints a readable test id, not a canonical
 * UUIDv7, which fails `chat.changed`'s own schema; and `turn.start`'s own
 * `readAppendBase` must resolve for the SAME chat id `chat.create`/`chat.switch`
 * mint and select, which `buildDeps`'s default independent read/write fake split
 * cannot give — so one instance serves both `chatReader` and `chatMutations` here.
 */
function createChatMutationsStub(): ChatReader & ChatMutations {
  const mintedChatIds = new Set<string>();

  function notFound(chatId: string): FailureDtoV1 {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: `no chat found for chatId ${chatId}`,
      details: { chatId },
    };
  }

  return {
    async create(): Promise<ChatHeaderV1> {
      const chatId = uuidv7();
      mintedChatIds.add(chatId);
      return { chatId, createdAt: "2024-01-01T00:00:00.000Z" };
    },
    async switchActive(): Promise<undefined> {
      return undefined;
    },
    async open(chatId: string): Promise<FailureDtoV1 | ChatHandleV1> {
      if (!mintedChatIds.has(chatId)) return notFound(chatId);
      return {
        header: { chatId, createdAt: "2024-01-01T00:00:00.000Z" },
        async loadTail(): Promise<ChatLoadResultV1> {
          return { records: [], prevCursor: null };
        },
        async loadBefore(): Promise<ChatLoadResultV1> {
          return { records: [], prevCursor: null };
        },
      };
    },
    async readAppendBase(chatId: string): Promise<FailureDtoV1 | ReadSetAppendBaseV1> {
      if (!mintedChatIds.has(chatId)) return notFound(chatId);
      return { length: 0, prefixSha256: fakeSha256Hex("") };
    },
  };
}

function makeClock(nowMs: number): Clock {
  return { now: () => new Date(nowMs) };
}

/** Matches `./kernel.test.ts`'s own identical fixture constant. */
const TURN_SPINE_BACKEND_CAPABILITIES: BackendCapabilities = {
  backendId: "claude",
  models: [{ model: "sonnet", efforts: ["medium"] }],
  confinement: "canUseTool",
  sessionWorkspaceBinding: "fixed",
};

/**
 * Every `KernelDeps` field, each a `core/ports/fakes` value — git ports excluded, since
 * they are not `KernelDeps` fields (out of MVP scope). `chatStore`/`gateRunner`/
 * `agentRegistry` are threaded through as parameters (rather than built internally)
 * because the test itself needs the SAME live instances afterward — to script the Gate
 * retry and drive the fake backend's own completion calls — never a second, disconnected
 * instance the assembled Kernel never actually holds.
 */
function buildDeps(
  chatStore: ChatReader & ChatMutations,
  gateRunner: GateRunner,
  agentRegistry: AgentRegistry,
  exportPublish: ExportPublishPort,
): KernelDeps {
  const pageStore = createFakePageStore({ order: [] });
  const pinStore = createFakePinStore();

  return {
    projectStore: createFakeProjectStore({
      root: "/test-root",
      workspaceState: { backend: "claude", model: "sonnet", effort: "medium" },
    }),
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
    gateRunner,
    hostSupervisor: createFakeHostSupervisorPort(),
    exportRender: createFakeExportRenderPort(),
    exportPublish,
    agentRegistry,
    clock: makeClock(1_700_000_000_000),
  };
}

/** Resolves with the first delivered envelope matching `predicate`, subscribed BEFORE dispatching so nothing racing ahead of the `await` is missed — same helper both prior spines already use. */
function waitForEvent(
  kernel: ReturnType<typeof createKernel>,
  predicate: (envelope: EventEnvelopeV1) => boolean,
): Promise<EventEnvelopeV1> {
  return new Promise((resolve, reject) => {
    const unsubscribe = kernel.events((envelope) => {
      if (!predicate(envelope)) return;
      if (typeof unsubscribe === "function") unsubscribe();
      resolve(envelope);
    });
    if (unsubscribe instanceof Error) reject(unsubscribe);
  });
}

describe("the WP-1 kernel integration gate (kernel-assembly Task 11, §11)", () => {
  test("project.open -> project.setTrust -> chat.create -> chat.switch -> turn.start (admission -> attempt -> one genuine Gate retry -> finalize -> turn.completed) -> export.start: every accepted command reports the right disposition, the milestone event kinds appear in order (turn.gateRejected exactly once), eventSeq/stateRevision stay monotonic, every envelope is schema-valid, and export.start's real behavior — still a documented no-op (Gap B) — is asserted honestly rather than assumed", async () => {
    const gateRunner = createFakeGateRunner();
    const agentBackend = createFakeAgentBackend({ capabilities: TURN_SPINE_BACKEND_CAPABILITIES });
    const exportPublish = createFakeExportPublish();
    const chatStore = createChatMutationsStub();
    const kernel = createKernel(
      buildDeps(chatStore, gateRunner, createFakeAgentRegistry([agentBackend]), exportPublish),
    );

    const envelopes: EventEnvelopeV1[] = [];
    const unsubscribe = kernel.events((envelope) => envelopes.push(envelope));
    if (unsubscribe instanceof Error) throw unsubscribe;
    // The bootstrap `kernel.snapshot`, delivered synchronously on subscribe.
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.kind).toBe("kernel.snapshot");

    // --- project.open --------------------------------------------------------------
    const projectReady = waitForEvent(
      kernel,
      (envelope) =>
        envelope.kind === "kernel.stateChanged" &&
        (envelope.payload as EventPayloadByKindV1["kernel.stateChanged"]).action ===
          "kernel.project.finishOpen",
    );
    const openResult = await kernel.dispatch({
      protocolVersion: 1,
      commandId: uuidv7(),
      expectedRevision: "0",
      kind: "project.open",
      payload: { root: "/test-root" },
    });
    if (openResult instanceof Error) throw openResult;
    expect(openResult.status).toBe("accepted");
    if (openResult.status !== "accepted") throw new Error("unreachable");
    expect(openResult.disposition).toBe("started");
    const readyEnvelope = await projectReady;

    // --- project.setTrust -----------------------------------------------------------
    // The legitimate preparatory dispatch the real UI would send: `createFakeTrustGate()`
    // starts with zero durable grants, so `project.open` alone resolves to
    // `"untrusted-read-only"` — every command from here on (`chat.create` onward) is
    // rejected `PROJECT_UNTRUSTED` without this step.
    const trustResult = await kernel.dispatch({
      protocolVersion: 1,
      commandId: uuidv7(),
      expectedRevision: readyEnvelope.stateRevision,
      kind: "project.setTrust",
      payload: { trust: "trusted", workspaceIdentity: "ws-1" },
    });
    if (trustResult instanceof Error) throw trustResult;
    expect(trustResult.status).toBe("accepted");
    if (trustResult.status !== "accepted") throw new Error("unreachable");
    expect(trustResult.disposition).toBe("started");

    // --- chat.create ------------------------------------------------------------------
    const chatCreated = waitForEvent(kernel, (envelope) => envelope.kind === "chat.changed");
    const createResult = await kernel.dispatch({
      protocolVersion: 1,
      commandId: uuidv7(),
      expectedRevision: trustResult.resultingRevision,
      kind: "chat.create",
      payload: {},
    });
    if (createResult instanceof Error) throw createResult;
    expect(createResult.status).toBe("accepted");
    if (createResult.status !== "accepted") throw new Error("unreachable");
    expect(createResult.disposition).toBe("started");
    const createdEnvelope = await chatCreated;
    const createdChatId = (createdEnvelope.payload as EventPayloadByKindV1["chat.changed"])
      .activeChatId;

    // --- chat.switch (persists activeChatId — chat.create's own handler does not) ------
    const chatSwitched = waitForEvent(
      kernel,
      (envelope) =>
        envelope.kind === "chat.changed" &&
        (envelope.payload as EventPayloadByKindV1["chat.changed"]).added.length === 0,
    );
    const switchResult = await kernel.dispatch({
      protocolVersion: 1,
      commandId: uuidv7(),
      expectedRevision: createdEnvelope.stateRevision,
      kind: "chat.switch",
      payload: { chatId: createdChatId },
    });
    if (switchResult instanceof Error) throw switchResult;
    expect(switchResult.status).toBe("accepted");
    if (switchResult.status !== "accepted") throw new Error("unreachable");
    expect(switchResult.disposition).toBe("started");
    const switchedEnvelope = await chatSwitched;

    // --- turn.start: admission -> attempt -> one genuine Gate retry -> finalize -------
    gateRunner.queueRunManifestSliceResult({
      errors: [{ kind: "manifest", code: "MANIFEST_REJECTED", message: "manifest rejected" }],
      slice: null,
    });

    const firstAttemptStarted = waitForEvent(
      kernel,
      (envelope) => envelope.kind === "turn.attemptStarted",
    );
    const turnStartResult = await kernel.dispatch({
      protocolVersion: 1,
      commandId: uuidv7(),
      expectedRevision: switchedEnvelope.stateRevision,
      kind: "turn.start",
      payload: { text: "please add a page" },
    });
    if (turnStartResult instanceof Error) throw turnStartResult;
    expect(turnStartResult.status).toBe("accepted");
    if (turnStartResult.status !== "accepted") throw new Error("unreachable");
    expect(turnStartResult.disposition).toBe("started");
    const firstAttemptEnvelope = await firstAttemptStarted;
    const turnId = (firstAttemptEnvelope.payload as EventPayloadByKindV1["turn.attemptStarted"])
      .turnId;

    const firstStart = agentBackend.calls.find((c) => c.method === "startTurn");
    if (firstStart?.method !== "startTurn") throw new Error("expected a startTurn call");
    const gateRejected = waitForEvent(kernel, (envelope) => envelope.kind === "turn.gateRejected");
    const secondAttemptStarted = waitForEvent(
      kernel,
      (envelope) =>
        envelope.kind === "turn.attemptStarted" &&
        (envelope.payload as EventPayloadByKindV1["turn.attemptStarted"]).attempt === 2,
    );
    agentBackend.completeRun(firstStart.fence, {
      kind: "completed",
      finalText: "done-1",
      usage: null,
      sessionId: "s1",
    });
    await gateRejected;
    await secondAttemptStarted;

    const secondStart = agentBackend.calls.filter((c) => c.method === "startTurn")[1];
    if (secondStart?.method !== "startTurn") throw new Error("expected a second startTurn call");
    const turnCompleted = waitForEvent(kernel, (envelope) => envelope.kind === "turn.completed");
    agentBackend.completeRun(secondStart.fence, {
      kind: "completed",
      finalText: "done-2",
      usage: null,
      sessionId: "s2",
    });
    const completedEnvelope = await turnCompleted;
    const completedPayload = completedEnvelope.payload as EventPayloadByKindV1["turn.completed"];
    expect(completedPayload.turnId).toBe(turnId);
    expect(completedPayload.outcome).toBe("completed");

    // --- export.start: the genuine blocker (Gap B), asserted honestly, not assumed ---
    // The guard genuinely admits this command (export.phase is "idle", and
    // `EXPORT_TRANSITION_TABLE`'s `idle -> preparing` edge is legal) — it is
    // `handleExportStart`'s own unconditional no-op body that refuses to compose the
    // real chain (see this file's own header). `exportPublish` — the SAME instance this
    // Kernel was built with above — never receives a call at all.
    const exportStartResult = await kernel.dispatch({
      protocolVersion: 1,
      commandId: uuidv7(),
      expectedRevision: completedEnvelope.stateRevision,
      kind: "export.start",
      payload: {},
    });
    if (exportStartResult instanceof Error) throw exportStartResult;
    expect(exportStartResult.status).toBe("accepted");
    if (exportStartResult.status !== "accepted") throw new Error("unreachable");
    expect(exportStartResult.disposition).toBe("no-op");
    // A no-op never advances `stateRevision` — the guard admitted the command, but
    // nothing about Kernel state actually changed.
    expect(exportStartResult.resultingRevision).toBe(exportStartResult.acceptedRevision);
    // The honest count TODAY, not the plan's own "exactly one plan" target — Gap B
    // blocks that (this file's own header), flagged for a maintainer decision, never
    // silently assumed away.
    expect(exportPublish.calls).toHaveLength(0);

    unsubscribe();

    // `turn.gateRejected` fires from EXACTLY the one scripted retry above — never more,
    // never fewer, across the WHOLE captured stream.
    const gateRejectedCount = envelopes.filter((e) => e.kind === "turn.gateRejected").length;
    expect(gateRejectedCount).toBe(1);

    // eventSeq is stamped once per delivered envelope, including the bootstrap snapshot
    // — strictly increasing across the WHOLE captured stream (§4/§13.3).
    const eventSeqs = envelopes.map((e) => BigInt(e.eventSeq));
    for (let i = 1; i < eventSeqs.length; i++) {
      const prev = eventSeqs[i - 1];
      const cur = eventSeqs[i];
      if (prev === undefined || cur === undefined) throw new Error("unreachable");
      expect(cur > prev).toBe(true);
    }

    // stateRevision never decreases across the stream — several events legitimately
    // share one revision (§4), but the sequence itself is monotonic non-decreasing, and
    // it ends strictly higher than the bootstrap snapshot's own "0" (every accepted
    // mutation above but the trailing no-op advanced it at least once).
    const revisions = envelopes.map((e) => BigInt(e.stateRevision));
    for (let i = 1; i < revisions.length; i++) {
      const prev = revisions[i - 1];
      const cur = revisions[i];
      if (prev === undefined || cur === undefined) throw new Error("unreachable");
      expect(cur >= prev).toBe(true);
    }
    expect(revisions[0]).toBe(0n);
    expect(revisions[revisions.length - 1]).toBeGreaterThan(0n);

    // Every event's own payload — not merely the ones this test happened to wait on —
    // parses against the exact schema its own `kind` names, proving the whole streamed
    // sequence is schema-valid end to end.
    for (const envelope of envelopes) {
      const schema =
        eventPayloadV1SchemaByKind[envelope.kind as keyof typeof eventPayloadV1SchemaByKind];
      expect(schema.safeParse(envelope.payload).success).toBe(true);
    }

    // activeTurnId cleared once the turn committed — checked via a fresh subscribe's own
    // bootstrap snapshot, which always reflects LIVE state (`kernel.ts`'s own
    // `readKernelState`, re-read at subscription time, never cached from the bootstrap).
    // Export never left `idle` either — `export.start`'s own no-op never applied
    // `kernel.export.begin`, matching the "guard admits it, the handler refuses it"
    // finding above.
    const finalSnapshot: EventEnvelopeV1[] = [];
    const unsubscribeFinal = kernel.events((envelope) => finalSnapshot.push(envelope));
    if (unsubscribeFinal instanceof Error) throw unsubscribeFinal;
    const finalPayload = finalSnapshot[0]?.payload as EventPayloadByKindV1["kernel.snapshot"];
    expect(finalPayload.models.turn.phase).toBe("idle");
    expect(finalPayload.models.turn.activeTurnId).toBeNull();
    expect(finalPayload.models.export.phase).toBe("idle");
    unsubscribeFinal();
  });
});
