import { describe, expect, spyOn, test } from "bun:test";

import { evaluateCapabilityGuard } from "core/capabilities";
import type { KernelStateSnapshot } from "core/capabilities";
import type { EventEnvelopeV1 } from "core/mailbox";
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

/** A full `KernelDeps` built entirely from `core/ports/fakes` — no git ports (out of MVP scope). */
function buildDeps(): KernelDeps {
  const chatStore = createFakeChatStore();
  const pageStore = createFakePageStore({ order: [] });
  const pinStore = createFakePinStore();

  return {
    projectStore: createFakeProjectStore({ root: "/test-root" }),
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

  test("dispatching a fresh command reaches the minimal handler registry without throwing or warning", async () => {
    const kernel = createKernel(buildDeps());
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    // `project.open` is one of only two commands the initial `closed`/idle state ever lets
    // past every guard (project.create/open are the sole exemptions from PROJECT_NOT_READY
    // and the only two legal `beginCreate`/`beginOpen` edges from `closed`) — so this is
    // the one live path that actually reaches Task 8's minimal handler registry rather than
    // being rejected by the guard layer first.
    const result = await kernel.dispatch({
      protocolVersion: 1,
      commandId: uuidv7(),
      expectedRevision: "0",
      kind: "project.open",
      payload: { root: "/test-root" },
    });

    // The well-formed no-op result IS the signal — a handler that has not landed yet must
    // not also leak stderr noise into every test that happens to reach it. Asserted BEFORE
    // `mockRestore()`: restoring the spy also clears its recorded call history, so checking
    // afterward would always read "not called" regardless of what actually happened.
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();

    if (result instanceof Error) throw result;
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.disposition).toBe("no-op");
    }
  });
});
