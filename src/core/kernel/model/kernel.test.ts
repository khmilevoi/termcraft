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
  PreviewFrameV1,
  ReadSetAppendBaseV1,
  TurnTransactionService,
} from "core/ports";
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
import { FrameAckError, PreviewNoLiveSessionError } from "core/preview";
import {
  type EventPayloadByKindV1,
  type FailureDtoV1,
  eventPayloadV1SchemaByKind,
} from "core/protocol";
import type { ChatRecord } from "entities/chat";
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
 *
 * UPDATED (§10 smoke closeout, WP-1 smoke report "the kernel fakes passed because their
 * append-base semantics don't advance on admission the way the real store does"): the
 * `{length: 0, ...}` constant above described this stub's OWN previous behavior honestly —
 * it genuinely never appended anything — but that made it fidelity-blind to a real
 * production bug (`core/kernel/model/handlers/turn.ts` reading the CAS baseline BEFORE
 * admission durably appends the turn's user record). This stub now tracks real records per
 * chat id and `readAppendBase` derives its answer from them, so it genuinely advances the
 * moment `seedRecords` is called — mirroring the real store's own single-JSONL-file
 * coupling between a chat's readers and its `TurnTransactionService` writers.
 * `withHonestChatAppendBase` (below) is what calls `seedRecords`; this stub does not call
 * it itself, matching `core/ports/fakes/index.ts`'s own "every fake is independent" design
 * — the coupling belongs to this file's own orchestration code, never to either port
 * double.
 */
function fakeSha256Hex(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) | 0;
  const base = (h >>> 0).toString(16).padStart(8, "0");
  return base.repeat(8).slice(0, 64);
}

interface ChatAppendLedger {
  seedRecords(chatId: string, records: readonly ChatRecord[]): void;
  readAppendBase(chatId: string): Promise<FailureDtoV1 | ReadSetAppendBaseV1>;
}

function createChatMutationsStub(): ChatReader & ChatMutations & ChatAppendLedger {
  const mintedChatIds = new Set<string>();
  const recordsByChatId = new Map<string, ChatRecord[]>();

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
      recordsByChatId.set(chatId, []);
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
      const serialized = JSON.stringify(recordsByChatId.get(chatId) ?? []);
      return {
        length: new TextEncoder().encode(serialized).byteLength,
        prefixSha256: fakeSha256Hex(serialized),
      };
    },
    seedRecords(chatId: string, records: readonly ChatRecord[]): void {
      const existing = recordsByChatId.get(chatId);
      if (existing === undefined) {
        console.warn(`kernel.test: seedRecords called for unknown chatId ${chatId}`);
        return;
      }
      existing.push(...records);
    },
  };
}

/**
 * Wraps a `TurnTransactionService` so its `admit`/`finalize`/`terminalize` calls genuinely
 * advance — and `finalize` genuinely re-checks — the SAME chat append-base `ledger`
 * reports. See `kernel.integration.test.ts`'s identical helper for the full rationale
 * (duplicated here rather than shared, matching this file's own established
 * "each fake/double gets its own tiny copy" convention, e.g. `fakeSha256Hex` above).
 */
function withHonestChatAppendBase(
  base: TurnTransactionService,
  ledger: ChatAppendLedger,
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
    agentPromptSource: createFakeAgentPromptSource(),
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
  test("construction succeeds and returns the six-method Kernel surface", () => {
    const kernel = createKernel(buildDeps());

    expect(typeof kernel.dispatch).toBe("function");
    expect(typeof kernel.events).toBe("function");
    expect(typeof kernel.currentPreview).toBe("function");
    expect(typeof kernel.publishFrame).toBe("function");
    expect(typeof kernel.acknowledgeDisplay).toBe("function");
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

function testPreviewFrame(): PreviewFrameV1 {
  return {
    sessionId: "kernel-test-session",
    sourceHash: "a".repeat(64),
    frameSeq: "1",
    width: 80,
    height: 24,
    rows: [],
  };
}

/**
 * kernel-assembly Task 16 — `Kernel.publishFrame`/`Kernel.acknowledgeDisplay`, the two
 * methods that replace `entrypoint`'s previously-fabricated `uuidv7()` frame token and its
 * unconditional `FrameAcknowledgeNotWiredError`.
 *
 * `kernel.preview.enable` (`disabled -> idle`) is "driven by broader project-lifecycle
 * orchestration" (kernel-command-contract §7.6; `core/preview/model/session-commands.
 * test.ts`'s own header note says the same) — no currently-wired handler anywhere under
 * `core/kernel/model/handlers` ever applies it (verified by reading every handler in that
 * family), so `preview.selectPage`/`selectCurrent` are rejected by the capability guard
 * from EVERY freshly-constructed Kernel, and `kernel.currentPreview()` can never become
 * non-null through `kernel.dispatch()` alone today. That gap is real, pre-existing, and
 * unrelated to this task (closing it means wiring project/recovery-lifecycle orchestration
 * a different family owns) — so the tests below cover exactly what is genuinely reachable
 * from OUTSIDE the Kernel's own frame right now: neither method ever fabricates a token or
 * a success when no live session exists. The mint -> acknowledge round trip itself (a REAL
 * token succeeding, an unknown one failing) is proven at `core/preview/model/session-
 * commands.test.ts`'s own "noteSessionEstablished/noteSessionClosed" suite — the exact
 * function `setActivePreviewSession` calls — and at `entrypoint/model/create-shell.
 * test.ts`'s own `toPreviewSessionHandle` suite, both reachable without the enable gap in
 * the way.
 */
describe("Kernel.publishFrame / Kernel.acknowledgeDisplay", () => {
  test("publishFrame with no live preview session returns PreviewNoLiveSessionError, never a fabricated token", () => {
    const kernel = createKernel(buildDeps());

    const published = kernel.publishFrame(testPreviewFrame());

    expect(published).toBeInstanceOf(PreviewNoLiveSessionError);
  });

  test("acknowledgeDisplay for a token nothing ever minted returns FrameAckError, never a fabricated identity", () => {
    const kernel = createKernel(buildDeps());

    const acked = kernel.acknowledgeDisplay("0192f6f0-0000-7000-8000-0000000000ff");

    expect(acked).toBeInstanceOf(FrameAckError);
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
  defaultSelection: { model: "sonnet", effort: "medium" },
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
    const openedProjectId = "0192f000-0000-7000-8000-00000000fed1";
    const kernel = createKernel({
      ...deps,
      projectStore: createFakeProjectStore({
        root: "/test-root",
        manifest: { projectId: openedProjectId, pages: [home] },
      }),
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

    // §10 smoke closeout, bug 2: `finishOpen`'s own event now carries the just-opened
    // project's real identity in its metadata (`handlers/project.ts`'s header) — the
    // channel an already-subscribed client reads it through, since no second
    // `kernel.snapshot` is ever sent.
    expect(readyEnvelope.payload).toMatchObject({
      metadata: { projectId: openedProjectId, trust: "untrusted-read-only" },
    });

    // A LATE subscriber (one that subscribes only NOW, after the project already opened)
    // must also see the real `projectId` in its own bootstrap `kernel.snapshot` — the
    // OTHER half of this same bug (`kernel.ts`'s own `buildSnapshotPayload` used to
    // hardcode `null` unconditionally, never reading the growable identity it now tracks).
    const lateSnapshot: EventEnvelopeV1[] = [];
    const unsubscribeLate = kernel.events((envelope) => lateSnapshot.push(envelope));
    if (unsubscribeLate instanceof Error) throw unsubscribeLate;
    const latePayload = lateSnapshot[0]?.payload as EventPayloadByKindV1["kernel.snapshot"];
    expect(latePayload.projectId).toBe(openedProjectId);
    unsubscribeLate();

    const trustChanged = waitForEvent(
      kernel,
      (envelope) =>
        envelope.kind === "kernel.stateChanged" &&
        (envelope.payload as EventPayloadByKindV1["kernel.stateChanged"]).action ===
          "kernel.project.setTrust",
    );
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
    // The live `project.setTrust` admission event carries its own resolved `trust` too
    // (§10 smoke closeout, bug 2) — `mirror.test.ts` proves the mirror-side consumption;
    // this just confirms the Kernel actually publishes it.
    const trustChangedEnvelope = await trustChanged;
    expect(trustChangedEnvelope.payload).toMatchObject({ metadata: { trust: "trusted" } });

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
 * Task 17 — late-subscriber liveness for `kernel.snapshot`'s `activePageSlug`/`activeChatId`.
 *
 * `buildSnapshotPayload` (`kernel.ts`) used to hardcode both fields to `null` unconditionally
 * — its own comment named `page.descriptorsChanged`/`chat.changed` as "the already-correct
 * live channel for both", true for an ALREADY-subscribed client (`ui/mirror`'s own `apply()`),
 * but never updated the bootstrap `kernel.snapshot` a LATE subscriber (one that attaches after
 * the active page/chat already changed) receives — exactly the same defect shape §10 smoke
 * closeout bug 2 already fixed for `projectId` (see the preceding describe block's own late-
 * subscribe assertion). This proves the analogous fix for `activePageSlug`/`activeChatId`:
 * subscribing AFTER `project.open` resolves (which publishes `page.descriptorsChanged` with a
 * real `activePageSlug`) and AFTER `chat.create` (which publishes `chat.changed` with a real
 * `activeChatId`) must read those CURRENT values, not the `null` the projection returned when
 * the Kernel was first constructed.
 */
describe("late-subscriber liveness for activePageSlug/activeChatId (Task 17)", () => {
  test("a subscriber attaching after the active page and active chat changed reads the CURRENT values, not null", async () => {
    const home = slug("home");
    const pageStore = createFakePageStore({
      order: [home],
      sources: new Map([[home, { bytes: new Uint8Array(), sourceHash: "a".repeat(64) }]]),
    });
    const deps = buildDeps({ chatMutations: createChatMutationsStub() });
    const kernel = createKernel({
      ...deps,
      projectStore: createFakeProjectStore({
        root: "/test-root",
        manifest: { projectId: "0192f000-0000-7000-8000-00000000fed2", pages: [home] },
      }),
      pageReader: pageStore,
      pageMutations: pageStore,
    });

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

    // `finishOpen`'s own async completion already published `page.descriptorsChanged` with
    // `activePageSlug: "home"` (no workspace state was seeded, so it falls back to
    // `manifest.pages[0]`, `handlers/project.ts`'s own `runProjectReadySequence`) in the SAME
    // batch as the `kernel.stateChanged` this test already awaited above. A subscriber
    // attaching only NOW must see that real slug in its own bootstrap snapshot.
    const afterOpenSnapshot: EventEnvelopeV1[] = [];
    const unsubscribeAfterOpen = kernel.events((envelope) => afterOpenSnapshot.push(envelope));
    if (unsubscribeAfterOpen instanceof Error) throw unsubscribeAfterOpen;
    const afterOpenPayload = afterOpenSnapshot[0]
      ?.payload as EventPayloadByKindV1["kernel.snapshot"];
    expect(afterOpenPayload.activePageSlug).toBe(home);
    // No chat has been created yet — `activeChatId` genuinely has no identity, so `null` here
    // is the honest value, not the same bug this test is chasing.
    expect(afterOpenPayload.activeChatId).toBeNull();
    unsubscribeAfterOpen();

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
    const createdChatId = (chatEnvelope.payload as EventPayloadByKindV1["chat.changed"])
      .activeChatId;

    // A second late subscriber, attaching after the chat also changed, must read BOTH real
    // values now — the active page from before, plus the just-created chat's real id.
    const afterChatSnapshot: EventEnvelopeV1[] = [];
    const unsubscribeAfterChat = kernel.events((envelope) => afterChatSnapshot.push(envelope));
    if (unsubscribeAfterChat instanceof Error) throw unsubscribeAfterChat;
    const afterChatPayload = afterChatSnapshot[0]
      ?.payload as EventPayloadByKindV1["kernel.snapshot"];
    expect(afterChatPayload.activePageSlug).toBe(home);
    expect(afterChatPayload.activeChatId).toBe(createdChatId);
    unsubscribeAfterChat();
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
      // Honest advance-on-admission fidelity (this file's header note on `createChatMutationsStub`)
      // — without this, `finalize()`'s CAS check never re-observes the just-admitted user
      // record, and this test would give false confidence over the real production bug the
      // §10 smoke closeout found.
      turnTransactions: withHonestChatAppendBase(deps.turnTransactions, chatStore),
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
