import { describe, expect, spyOn, test } from "bun:test";

import { evaluateCapabilityGuard } from "core/capabilities";
import type { KernelStateSnapshot } from "core/capabilities";
import type { EventEnvelopeV1 } from "core/mailbox";
import type { ChatHeaderV1, ChatMutations } from "core/ports";
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
import type { EventPayloadByKindV1 } from "core/protocol";
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

import type { KernelDeps } from "../types";
import { createKernel } from "./kernel";

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
 * A minimal, locally-defined `ChatMutations` double that mints a REAL UUIDv7 `chatId` —
 * matches `handlers/chat.test.ts`'s own `createChatMutationsStub`, for the identical
 * documented reason: `createFakeChatStore`'s own `create()` mints `` `fake-chat-${n}` ``
 * (a readable test id, not a canonical UUIDv7), which fails `chat.changed`'s own
 * `activeChatId: uuidv7Schema` at `eventBus.publishTransition`'s schema validation — a
 * fixture artifact, never something a real `ChatMutations` adapter (or this handler) gets
 * wrong.
 */
function createChatMutationsStub(): ChatMutations {
  return {
    async create(): Promise<ChatHeaderV1> {
      return { chatId: uuidv7(), createdAt: "2024-01-01T00:00:00.000Z" };
    },
    async switchActive(): Promise<undefined> {
      return undefined;
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
  /** Resolves with the first delivered envelope matching `predicate`, subscribed BEFORE the caller dispatches anything so nothing racing ahead of the `await` is ever missed. */
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
