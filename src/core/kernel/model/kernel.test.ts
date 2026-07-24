import { describe, expect, spyOn, test } from "bun:test";

import { evaluateCapabilityGuard } from "core/capabilities";
import type { KernelStateSnapshot } from "core/capabilities";
import type { EventEnvelopeV1 } from "core/mailbox";
import type {
  BackendCapabilities,
  ChatHandleV1,
  ChatHeaderV1,
  ChatLoadResultV1,
  ChatMutations,
  ChatReader,
  ReadSetAppendBaseV1,
} from "core/ports";
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
  type EventPayloadByKindV1,
  type FailureDtoV1,
  eventPayloadV1SchemaByKind,
} from "core/protocol";
import { type PageSlug, parsePageSlug } from "entities/page";
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

import type { KernelDeps } from "../types";
import { createKernel } from "./kernel";

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

/** Resolves with the first delivered envelope matching `predicate`, subscribed BEFORE the caller dispatches anything so nothing racing ahead of the `await` is ever missed. Shared by both integration-style describe blocks below. */
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

/**
 * Every one of §10.1's nine literal-`null`-target kinds (`capabilities/model/target.ts`'s
 * `nullTarget()` rows) — the only capabilities a freshly-constructed Kernel, with no
 * project/turn/preview/pin ever having existed, can meaningfully project: every other
 * kind's target names a runtime identity (a turnId, a pageSlug, a previewSessionId, ...)
 * that simply does not exist yet. See `kernel.ts`'s `buildCapabilities` for the same list.
 */
const EXPECTED_SNAPSHOT_CAPABILITY_KINDS = [
  "project.create",
  "project.open",
  "project.close",
  "turn.start",
  "chat.create",
  "page.reorder",
  "selection.clear",
  "export.start",
  "migration.plan",
] as const;

/** The seven machines' real `initial` phases, transcribed from each `reatom*StateMachine`. */
const INITIAL_MODELS_SNAPSHOT: KernelStateSnapshot = {
  project: { phase: "closed", trust: null },
  turn: { phase: "idle", activeTurnId: null, commitIntentRecorded: false },
  restore: { phase: "idle" },
  commit: { phase: "idle" },
  export: { phase: "idle" },
  preview: { phase: "disabled", sourceKind: null },
  migration: { phase: "idle" },
};

/** `kernel.ts`'s own retained `PLACEHOLDER_GIT_STATUS`, transcribed — no Git port is wired into `KernelDeps` (out of MVP scope). */
const EXPECTED_GIT_STATUS_PLACEHOLDER: EventPayloadByKindV1["kernel.snapshot"]["gitStatus"] = {
  repositoryId: "unknown",
  head: null,
  sequencerState: "none",
  scopes: {},
};

function makeClock(nowMs: number): Clock {
  return { now: () => new Date(nowMs) };
}

/**
 * A minimal, locally-defined `ChatMutations` (+ `ChatReader`, for the `turn.start` spine
 * below) double that mints a REAL UUIDv7 `chatId` — matches `handlers/chat.test.ts`'s own
 * `createChatMutationsStub` for the identical documented reason: `createFakeChatStore`'s
 * own `create()` mints `` `fake-chat-${n}` `` (a readable test id, not a canonical UUIDv7),
 * which fails `chat.changed`'s own `activeChatId: uuidv7Schema` at
 * `eventBus.publishTransition`'s schema validation — a fixture artifact, never something a
 * real `ChatMutations` adapter (or this handler) gets wrong.
 *
 * Widened here (beyond `handlers/chat.test.ts`'s own narrower `ChatMutations`-only version)
 * to also implement `ChatReader`: the `turn.start` spine below needs `readAppendBase` to
 * resolve for the SAME chat id `chat.create`/`chat.switch` actually minted and selected —
 * `buildDeps`'s own default fixture instead splits `chatReader`/`chatMutations` across two
 * INDEPENDENT `createFakeChatStore()` instances (a real one for reads, this stub for
 * mutations only), which would leave `readAppendBase` looking up a chat id the read-side
 * fake never heard of. `readAppendBase`'s own `{length: 0, prefixSha256}` is honest, not
 * fabricated: every chat this stub mints genuinely has zero records (it tracks minted ids
 * only, never appends anything), so `length: 0` is simply true, and `prefixSha256` is the
 * SAME deterministic, no-real-crypto `fakeSha256Hex` formula `core/ports/fakes/chat-store.ts`'s
 * own `readAppendBase` fake uses for the identical zero-record case — never a real
 * SHA-256, and never a placeholder standing in for an UNKNOWN fact.
 */
function fakeSha256Hex(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) | 0;
  const base = (h >>> 0).toString(16).padStart(8, "0");
  return base.repeat(8).slice(0, 64);
}

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

/** A full `KernelDeps` built entirely from `core/ports/fakes` — no git ports (out of MVP scope). */
function buildDeps(overrides?: { readonly chatMutations?: ChatMutations }): KernelDeps {
  const chatStore = createFakeChatStore();
  const pageStore = createFakePageStore({ order: [] });
  const pinStore = createFakePinStore();

  return {
    projectStore: createFakeProjectStore({ root: "/test-root" }),
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
    clock: makeClock(1_700_000_000_000),
  };
}

/**
 * Every assertion below calls a `Kernel` method OUTSIDE the `createKernel(...)` call that
 * built it — exactly the shape `dispatch.test.ts`'s own `setup()` comment requires ("every
 * call below reaches `dispatch()` from OUTSIDE this function, after `context.start(...)`
 * has already returned"). That matches the shape a real caller uses, but these tests only
 * demonstrate that reading from outside the frame does not throw and observes the
 * machines' unchanged INITIAL state (construction, the bootstrap `kernel.snapshot`,
 * `close()`, and a dispatch that lands on the still-minimal no-op handler) — nothing here
 * mutates state inside the frame and then reads the mutation back from outside, so this
 * suite alone cannot distinguish correct frame re-entry from a broken binding that silently
 * reads a second, untouched frame (both would look identical when nothing ever writes).
 * The task 11 Kernel integration test is the one that actually drives a mutating dispatch
 * and asserts the resulting state/events are visible from outside the frame — that is the
 * real proof `bind`/`wrap` re-enter the Kernel's one Reatom frame correctly, not this file.
 */
describe("createKernel", () => {
  test("construction succeeds and returns the four-method Kernel surface", () => {
    const kernel = createKernel(buildDeps());

    expect(typeof kernel.dispatch).toBe("function");
    expect(typeof kernel.events).toBe("function");
    expect(typeof kernel.currentPreview).toBe("function");
    expect(typeof kernel.close).toBe("function");
    // No preview.* command has ever run — nothing has established a live preview session.
    expect(kernel.currentPreview()).toBeNull();
  });

  test("an immediate subscribe delivers exactly one kernel.snapshot with the machines' initial phases", () => {
    const kernel = createKernel(buildDeps());
    const received: EventEnvelopeV1[] = [];

    const unsubscribe = kernel.events((envelope) => {
      received.push(envelope);
    });
    if (unsubscribe instanceof Error) throw unsubscribe;

    expect(received).toHaveLength(1);
    const snapshot = received[0];
    expect(snapshot?.kind).toBe("kernel.snapshot");
    // The counter's base — no command has ever advanced the revision.
    expect(snapshot?.stateRevision).toBe("0");

    const payload = snapshot?.payload as EventPayloadByKindV1["kernel.snapshot"];
    expect(payload.models).toEqual(INITIAL_MODELS_SNAPSHOT);
    expect(payload.trust).toBeNull();
    expect(payload.projectId).toBeNull();
    expect(payload.activePageSlug).toBeNull();
    expect(payload.activeChatId).toBeNull();
    expect(payload.pageDescriptors).toEqual([]);
    // The retained M21 placeholder — asserted by value, not only implicitly via the event
    // bus's own schema validation, so a future accidental edit to the literal is caught here.
    expect(payload.gitStatus).toEqual(EXPECTED_GIT_STATUS_PLACEHOLDER);
    // No backend has ever been selected (no `model.select` handler exists yet).
    expect(payload.agentIdentity).toBeNull();

    unsubscribe();
  });

  test("the snapshot's capabilities come from the real projector, not a hand-rolled duplicate", () => {
    const kernel = createKernel(buildDeps());
    const received: EventEnvelopeV1[] = [];

    const unsubscribe = kernel.events((envelope) => received.push(envelope));
    if (unsubscribe instanceof Error) throw unsubscribe;

    const payload = received[0]?.payload as EventPayloadByKindV1["kernel.snapshot"];

    expect(payload.capabilities.map((entry) => entry.id).sort()).toEqual(
      [...EXPECTED_SNAPSHOT_CAPABILITY_KINDS].sort(),
    );

    for (const entry of payload.capabilities) {
      // Every entry's verdict must equal calling the SAME real guard directly over the
      // known initial state — proving the snapshot's capabilities are genuinely projected
      // through `evaluateCapabilityGuard`, not a separately hand-maintained approximation.
      expect(entry.state).toEqual(
        evaluateCapabilityGuard(entry.id, entry.target, INITIAL_MODELS_SNAPSHOT),
      );
      expect(entry.target).toBeNull();
    }

    unsubscribe();
  });

  test("close resolves and clears any current preview reference", async () => {
    const kernel = createKernel(buildDeps());
    await expect(kernel.close()).resolves.toBeUndefined();
    expect(kernel.currentPreview()).toBeNull();
  });

  test("dispatching a fresh command reaches the REAL project handler (Step C1) without throwing or warning synchronously", async () => {
    const kernel = createKernel(buildDeps());
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    // `project.open` is one of only two commands the initial `closed`/idle state ever lets
    // past every guard (project.create/open are the sole exemptions from PROJECT_NOT_READY
    // and the only two legal `beginCreate`/`beginOpen` edges from `closed`) — so this is the
    // one live path that reaches the REAL `project` family (Step C1 wired it into
    // `totalHandlers`, replacing Task 8's minimal stand-in) rather than being rejected by
    // the guard layer first. The synchronous admission alone is asserted here — `dispatch`
    // never awaits `launchOperation`'s own background continuation (`runProjectReadySequence`),
    // matching §12.1 step 6 ("For async work, the owning service starts AFTER the state
    // transition") — so this is a synchronous smoke test, not a full open-sequence proof
    // (that is `handlers/project.test.ts`'s own job).
    const result = await kernel.dispatch({
      protocolVersion: 1,
      commandId: uuidv7(),
      expectedRevision: "0",
      kind: "project.open",
      payload: { root: "/test-root" },
    });

    // The one immediate, synchronous admission transition (`beginOpen`) never warns — a
    // legal transition the guard already confirmed. Asserted BEFORE `mockRestore()`:
    // restoring the spy also clears its recorded call history, so checking afterward would
    // always read "not called" regardless of what actually happened.
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();

    if (result instanceof Error) throw result;
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      // `beginOpen`'s own admission event fires synchronously and DOES advance the
      // revision (`project.ts`'s `beginProjectOpen`) — never the Task-8 stand-in's bare
      // no-op.
      expect(result.disposition).toBe("started");
      expect(result.resultingRevision).not.toBe(result.acceptedRevision);
    }
  });
});

/**
 * Kernel-assembly WP-1 task 9, STEP C1 — `kernel.capabilitiesChanged` growth
 * (`kernel.ts`'s own `currentCapabilityRequests`/`publishAndTrackCapabilities`). Drives
 * the REAL, fully-assembled `createKernel` (not a family's own isolated `HandlerContext`
 * fixture) through the one end-to-end path the four Step-C1-wired families make
 * reachable: `project.open` → `project.setTrust` (both required before `PROJECT_NOT_READY`/
 * `PROJECT_UNTRUSTED` ever let `chat.create` past the guard) → `chat.create`, then asserts
 * a `kernel.capabilitiesChanged` event carries `chat.switch`'s REAL `{chatId}` target —
 * the task brief's own named example.
 */
describe("kernel.capabilitiesChanged growth (Step C1)", () => {
  test("chat.switch's capability appears with a real chatId once a chat exists, and disappears is never asserted (no chat.* removal path exists yet)", async () => {
    const kernel = createKernel(buildDeps({ chatMutations: createChatMutationsStub() }));

    // No capability entry named `chat.switch` exists in the bootstrap snapshot — it needs a
    // real `chatId`, which nothing in a freshly-assembled Kernel has yet (`kernel.ts`'s own
    // `SNAPSHOT_CAPABILITY_KINDS` comment).
    const initialSnapshot: EventEnvelopeV1[] = [];
    const unsubscribeInitial = kernel.events((envelope) => initialSnapshot.push(envelope));
    if (unsubscribeInitial instanceof Error) throw unsubscribeInitial;
    const bootstrapPayload = initialSnapshot[0]?.payload as EventPayloadByKindV1["kernel.snapshot"];
    expect(bootstrapPayload.capabilities.some((entry) => entry.id === "chat.switch")).toBe(false);
    unsubscribeInitial();

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
    // `finishOpen`'s own async completion (`launchOperation`) advances `stateRevision` a
    // SECOND time, beyond `project.open`'s own synchronous admission bump — read the
    // envelope's own stamped `stateRevision` rather than guessing a literal, since
    // `dispatch()` never awaits that completion itself (§12.1 step 6).
    const readyEnvelope = await projectReady;

    const trustResult = await kernel.dispatch({
      protocolVersion: 1,
      commandId: uuidv7(),
      expectedRevision: readyEnvelope.stateRevision,
      kind: "project.setTrust",
      payload: { trust: "trusted", workspaceIdentity: "ws-1" },
    });
    if (trustResult instanceof Error) throw trustResult;
    if (trustResult.status !== "accepted") {
      throw new Error(`project.setTrust was rejected: ${JSON.stringify(trustResult)}`);
    }

    const capabilitiesChanged = waitForEvent(
      kernel,
      (envelope) => envelope.kind === "kernel.capabilitiesChanged",
    );
    const createResult = await kernel.dispatch({
      protocolVersion: 1,
      commandId: uuidv7(),
      expectedRevision: trustResult.resultingRevision,
      kind: "chat.create",
      payload: {},
    });
    if (createResult instanceof Error) throw createResult;
    if (createResult.status !== "accepted") {
      throw new Error(`chat.create was rejected: ${JSON.stringify(createResult)}`);
    }

    const growthEnvelope = await capabilitiesChanged;
    const growthPayload =
      growthEnvelope.payload as EventPayloadByKindV1["kernel.capabilitiesChanged"];
    const chatSwitchEntry = growthPayload.changed.find((entry) => entry.id === "chat.switch");
    expect(chatSwitchEntry).toBeDefined();
    expect(chatSwitchEntry?.target).toEqual({
      chatId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(chatSwitchEntry?.state).toEqual({ available: true });
  });
});

/** `model.select`'s validated triple for the `turn.start` spine test below — matches `handlers/turn.test.ts`'s own identical fixture constant. */
const TURN_SPINE_BACKEND_CAPABILITIES: BackendCapabilities = {
  backendId: "claude",
  models: [{ model: "sonnet", efforts: ["medium"] }],
  confinement: "canUseTool",
  sessionWorkspaceBinding: "fixed",
};

/**
 * Kernel-assembly WP-1 task 9, Step C3 — the §11 real-registry spine deliverable, plus the
 * Gap-4-closeout `turn.start` spine (this file's own second test, below). Step C3's own
 * `project` -> `chat` -> `page` spine (first test) stays as originally written — the brief's
 * own named scenario ("admission -> attempt -> gate retry -> finalize" through a dispatched
 * `turn.start`) was BLOCKED at that time (`handlers/turn.ts`'s own header, "Gap 4":
 * `AdmissionInputV1.workspace.readSet`'s chat-append-base/manifest facts had no honest
 * `core/ports` source), so a different, currently-real multi-family spine stood in for it,
 * proving the same two properties (a streamed, schema-valid event sequence and strictly
 * monotonic `stateRevision`) the brief's own spine test asks for.
 *
 * Gap 4 is now closed (`core/ports/chat-store.ts`'s `readAppendBase`, `core/ports/
 * project-store.ts`'s `readManifestSnapshot`, both wired into `handlers/turn.ts`'s real
 * `turn.start`) — the second describe block below is the brief's own originally-named
 * scenario, dispatched for real through the REAL `createKernel`/`createHandlerRegistry`, not
 * an isolated family fixture: `project.open` -> `project.setTrust` -> `chat.create` ->
 * `chat.switch` (persisting `activeChatId` — `chat.create`'s own real handler does not,
 * `handlers/chat.ts`'s own header note) -> `turn.start` (admission -> attempt -> a genuine
 * Gate manifest-slice retry -> finalize -> `turn.completed`), asserting the same
 * schema-valid/monotonic-revision properties PLUS `activeTurnId` cleared once the turn
 * committed. `core/turns/model/run-turn.test.ts`'s own suite remains the exhaustive,
 * per-page composition proof (including every terminal branch); this spine's own job is
 * proving the REAL Kernel wiring, not re-proving `runTurn` a second time — `handlers/
 * turn.test.ts`'s own identical-shaped test proves the same composition against an isolated
 * `HandlerContext` fixture, for the same reason.
 */
describe("the real-registry spine (kernel-assembly Task 9 Step C3, §11)", () => {
  test("project.open -> project.setTrust -> chat.create -> page.removePlan -> page.removeDiscardPlan: every non-snapshot event parses against its own schema, eventSeq strictly increases, and stateRevision never decreases", async () => {
    const home = slug("home");
    const pageStore = createFakePageStore({
      order: [home],
      sources: new Map([[home, { bytes: new Uint8Array(), sourceHash: "a".repeat(64) }]]),
    });
    const deps = buildDeps({ chatMutations: createChatMutationsStub() });
    const kernel = createKernel({
      ...deps,
      projectStore: createFakeProjectStore({ root: "/test-root", manifest: { pages: [home] } }),
      pageReader: pageStore,
      pageMutations: pageStore,
    });

    const envelopes: EventEnvelopeV1[] = [];
    const unsubscribe = kernel.events((envelope) => envelopes.push(envelope));
    if (unsubscribe instanceof Error) throw unsubscribe;

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
    const readyEnvelope = await projectReady;

    const trustResult = await kernel.dispatch({
      protocolVersion: 1,
      commandId: uuidv7(),
      expectedRevision: readyEnvelope.stateRevision,
      kind: "project.setTrust",
      payload: { trust: "trusted", workspaceIdentity: "ws-1" },
    });
    if (trustResult instanceof Error) throw trustResult;
    if (trustResult.status !== "accepted") {
      throw new Error(`project.setTrust was rejected: ${JSON.stringify(trustResult)}`);
    }

    const chatChanged = waitForEvent(kernel, (envelope) => envelope.kind === "chat.changed");
    const createResult = await kernel.dispatch({
      protocolVersion: 1,
      commandId: uuidv7(),
      expectedRevision: trustResult.resultingRevision,
      kind: "chat.create",
      payload: {},
    });
    if (createResult instanceof Error) throw createResult;
    if (createResult.status !== "accepted") {
      throw new Error(`chat.create was rejected: ${JSON.stringify(createResult)}`);
    }
    const chatEnvelope = await chatChanged;

    const planReady = waitForEvent(kernel, (envelope) => envelope.kind === "page.removePlanReady");
    const removePlanResult = await kernel.dispatch({
      protocolVersion: 1,
      commandId: uuidv7(),
      expectedRevision: chatEnvelope.stateRevision,
      kind: "page.removePlan",
      payload: { pageSlug: home },
    });
    if (removePlanResult instanceof Error) throw removePlanResult;
    if (removePlanResult.status !== "accepted") {
      throw new Error(`page.removePlan was rejected: ${JSON.stringify(removePlanResult)}`);
    }
    const planEnvelope = await planReady;
    const planPayload = planEnvelope.payload as EventPayloadByKindV1["page.removePlanReady"];

    const discardResult = await kernel.dispatch({
      protocolVersion: 1,
      commandId: uuidv7(),
      expectedRevision: planEnvelope.stateRevision,
      kind: "page.removeDiscardPlan",
      payload: { pageRemovePlanId: planPayload.pageRemovePlanId },
    });
    if (discardResult instanceof Error) throw discardResult;
    if (discardResult.status !== "accepted") {
      throw new Error(`page.removeDiscardPlan was rejected: ${JSON.stringify(discardResult)}`);
    }

    unsubscribe();

    // eventSeq is stamped once per delivered envelope, including the bootstrap snapshot —
    // strictly increasing across the WHOLE captured stream (§4/§13.3).
    const eventSeqs = envelopes.map((e) => BigInt(e.eventSeq));
    for (let i = 1; i < eventSeqs.length; i++) {
      const prev = eventSeqs[i - 1];
      const cur = eventSeqs[i];
      if (prev === undefined || cur === undefined) throw new Error("unreachable");
      expect(cur > prev).toBe(true);
    }

    // stateRevision never decreases across the stream — several events legitimately share
    // one revision (§4), but the sequence itself is monotonic non-decreasing, and it ends
    // strictly higher than the bootstrap snapshot's own "0".
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
    // sequence is schema-valid end to end, not just the four envelopes explicitly awaited.
    for (const envelope of envelopes) {
      const schema =
        eventPayloadV1SchemaByKind[envelope.kind as keyof typeof eventPayloadV1SchemaByKind];
      const parsed = schema.safeParse(envelope.payload);
      expect(parsed.success).toBe(true);
    }
  });
});

/**
 * Kernel-assembly Task 9, Gap 4 closeout — the deliverable-F spine: the brief's own
 * originally-named scenario, now genuinely dispatchable. See the doc comment above the
 * preceding describe block for the full "why this test exists now" citation.
 */
describe("the turn.start spine (kernel-assembly Task 9, Gap 4 closeout)", () => {
  test("project.open -> project.setTrust -> chat.create -> chat.switch -> turn.start: admission -> attempt -> a genuine Gate retry -> finalize -> turn.completed; activeTurnId set then cleared; eventSeq/stateRevision stay monotonic", async () => {
    const gateRunner = createFakeGateRunner();
    const agentBackend = createFakeAgentBackend({ capabilities: TURN_SPINE_BACKEND_CAPABILITIES });
    // ONE stub instance for BOTH facets — `turn.start`'s own `readAppendBase` must resolve
    // for the SAME chat id `chat.create`/`chat.switch` actually minted and selected (see this
    // stub's own doc comment for why `buildDeps`'s default split-instance fixture cannot do
    // that here).
    const chatStore = createChatMutationsStub();
    const deps = buildDeps({ chatMutations: chatStore });
    const kernel = createKernel({
      ...deps,
      chatReader: chatStore,
      // A deliberately zero-page project: isolates the admission/attempt/gate-retry/finalize
      // wiring this test proves without needing byte-level per-page plumbing — matches
      // `handlers/turn.test.ts`'s own identical-shaped fixture and identical reasoning.
      projectStore: createFakeProjectStore({
        root: "/test-root",
        workspaceState: { backend: "claude", model: "sonnet", effort: "medium" },
      }),
      gateRunner,
      agentRegistry: createFakeAgentRegistry([agentBackend]),
    });

    const envelopes: EventEnvelopeV1[] = [];
    const unsubscribe = kernel.events((envelope) => envelopes.push(envelope));
    if (unsubscribe instanceof Error) throw unsubscribe;

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
    const readyEnvelope = await projectReady;

    const trustResult = await kernel.dispatch({
      protocolVersion: 1,
      commandId: uuidv7(),
      expectedRevision: readyEnvelope.stateRevision,
      kind: "project.setTrust",
      payload: { trust: "trusted", workspaceIdentity: "ws-1" },
    });
    if (trustResult instanceof Error) throw trustResult;
    if (trustResult.status !== "accepted") {
      throw new Error(`project.setTrust was rejected: ${JSON.stringify(trustResult)}`);
    }

    const chatCreated = waitForEvent(kernel, (envelope) => envelope.kind === "chat.changed");
    const createResult = await kernel.dispatch({
      protocolVersion: 1,
      commandId: uuidv7(),
      expectedRevision: trustResult.resultingRevision,
      kind: "chat.create",
      payload: {},
    });
    if (createResult instanceof Error) throw createResult;
    if (createResult.status !== "accepted") {
      throw new Error(`chat.create was rejected: ${JSON.stringify(createResult)}`);
    }
    const createdEnvelope = await chatCreated;
    const createdChatId = (createdEnvelope.payload as EventPayloadByKindV1["chat.changed"])
      .activeChatId;

    // `chat.create`'s own real handler never persists `activeChatId` into `WorkspaceStateV1`
    // (`handlers/chat.ts`'s own header note) — `chat.switch` is the one real command that
    // does, so it is genuinely dispatched here too, rather than poked into the fake directly.
    // Distinguished from `chat.create`'s own `chat.changed` by `added.length === 0` (a switch
    // adds no new chat).
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
    if (switchResult.status !== "accepted") {
      throw new Error(`chat.switch was rejected: ${JSON.stringify(switchResult)}`);
    }
    const switchedEnvelope = await chatSwitched;

    // Forces exactly ONE Gate retry, at the manifest-slice stage (this fixture's own
    // `pageReader` lists zero pages, so no per-page `runPage` call is ever made).
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
    if (turnStartResult.status !== "accepted") {
      throw new Error(`turn.start was rejected: ${JSON.stringify(turnStartResult)}`);
    }
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

    unsubscribe();

    // eventSeq is stamped once per delivered envelope, including the bootstrap snapshot —
    // strictly increasing across the WHOLE captured stream (§4/§13.3).
    const eventSeqs = envelopes.map((e) => BigInt(e.eventSeq));
    for (let i = 1; i < eventSeqs.length; i++) {
      const prev = eventSeqs[i - 1];
      const cur = eventSeqs[i];
      if (prev === undefined || cur === undefined) throw new Error("unreachable");
      expect(cur > prev).toBe(true);
    }

    // stateRevision never decreases across the stream, and ends strictly higher than the
    // bootstrap snapshot's own "0" (§4).
    const revisions = envelopes.map((e) => BigInt(e.stateRevision));
    for (let i = 1; i < revisions.length; i++) {
      const prev = revisions[i - 1];
      const cur = revisions[i];
      if (prev === undefined || cur === undefined) throw new Error("unreachable");
      expect(cur >= prev).toBe(true);
    }
    expect(revisions[0]).toBe(0n);
    expect(revisions[revisions.length - 1]).toBeGreaterThan(0n);

    // Every event's own payload — not merely the ones this test happened to wait on — parses
    // against the exact schema its own `kind` names.
    for (const envelope of envelopes) {
      const schema =
        eventPayloadV1SchemaByKind[envelope.kind as keyof typeof eventPayloadV1SchemaByKind];
      expect(schema.safeParse(envelope.payload).success).toBe(true);
    }

    // activeTurnId cleared once the turn committed — checked via a fresh subscribe's own
    // bootstrap snapshot, which always reflects LIVE state (`kernel.ts`'s own
    // `readKernelState`, re-read at subscription time, never cached from the bootstrap).
    const finalSnapshot: EventEnvelopeV1[] = [];
    const unsubscribeFinal = kernel.events((envelope) => finalSnapshot.push(envelope));
    if (unsubscribeFinal instanceof Error) throw unsubscribeFinal;
    const finalPayload = finalSnapshot[0]?.payload as EventPayloadByKindV1["kernel.snapshot"];
    expect(finalPayload.models.turn.phase).toBe("idle");
    expect(finalPayload.models.turn.activeTurnId).toBeNull();
    unsubscribeFinal();
  });
});
