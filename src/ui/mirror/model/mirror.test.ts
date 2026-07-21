import { beforeEach, describe, expect, test } from "bun:test";

import type { FailureDtoV1 } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";
import { TEST_NONCE, TEST_SHA, TEST_TS, event, resetEventSeq, snapshot } from "ui/testing";

import { createMirror } from "./mirror";

const failure = (code: FailureDtoV1["code"] = "HOST_START_FAILED"): FailureDtoV1 => ({
  code,
  retryable: true,
  safeMessage: "boom",
  details: {},
});

beforeEach(() => resetEventSeq());

describe("mirror.apply — counters", () => {
  test("every event advances stateRevision and eventSeq", () => {
    const m = createMirror();
    m.apply(snapshot({}, { eventSeq: "5", stateRevision: "9" }));
    expect(m.stateRevision()).toBe("9");
    expect(m.eventSeq()).toBe("5");
  });
});

describe("mirror.apply — kernel.snapshot seeds project/capabilities/pages/chats", () => {
  test("seeds the project slice from the snapshot", () => {
    const m = createMirror();
    const projectId = uuidv7();
    const chatId = uuidv7();
    m.apply(
      snapshot({ projectId, activePageSlug: "main", activeChatId: chatId, trust: "trusted" }),
    );
    expect(m.project()).toEqual({
      projectId,
      activePageSlug: "main",
      activeChatId: chatId,
      trust: "trusted",
    });
    expect(m.chats().activeChatId).toBe(chatId);
  });

  test("seeds capabilities keyed by command kind", () => {
    const m = createMirror();
    m.apply(
      snapshot({
        capabilities: [
          { id: "turn.start", target: {}, state: { available: true } },
          {
            id: "export.start",
            target: {},
            state: { available: false, reasons: [{ code: "NO_PAGES" }] },
          },
        ],
      }),
    );
    expect(m.capabilities().get("turn.start")).toEqual({ available: true });
    expect(m.capabilities().get("export.start")).toEqual({
      available: false,
      reasons: [{ code: "NO_PAGES" }],
    });
  });

  test("a later snapshot resets transient slices", () => {
    const m = createMirror();
    m.apply(snapshot());
    m.apply(event("turn.started", { turnId: uuidv7(), chatId: uuidv7(), deadline: TEST_TS }));
    expect(m.turn().phase).toBe("running");
    m.apply(snapshot());
    expect(m.turn().phase).toBe("idle");
  });
});

describe("mirror.apply — capabilities changed", () => {
  test("upserts changed entries and deletes removed ids", () => {
    const m = createMirror();
    m.apply(
      snapshot({ capabilities: [{ id: "turn.start", target: {}, state: { available: true } }] }),
    );
    m.apply(
      event("kernel.capabilitiesChanged", {
        changed: [
          {
            id: "turn.start",
            target: {},
            state: { available: false, reasons: [{ code: "PROJECT_NOT_READY" }] },
          },
          { id: "chat.create", target: {}, state: { available: true } },
        ],
        removed: [],
      }),
    );
    expect(m.capabilities().get("turn.start")).toEqual({
      available: false,
      reasons: [{ code: "PROJECT_NOT_READY" }],
    });
    expect(m.capabilities().get("chat.create")).toEqual({ available: true });

    m.apply(
      event("kernel.capabilitiesChanged", {
        changed: [],
        removed: [{ id: "chat.create", target: {} }],
      }),
    );
    expect(m.capabilities().has("chat.create")).toBe(false);
  });
});

describe("mirror.apply — pages", () => {
  test("page.descriptorsChanged replaces descriptors and updates the active page", () => {
    const m = createMirror();
    m.apply(
      event("page.descriptorsChanged", {
        reason: "turn-apply",
        descriptors: [
          {
            status: "ready",
            pageSlug: "main",
            sourceHash: TEST_SHA,
            title: "Main",
            minSize: { w: 80, h: 24 },
            theme: "dark-default",
            kitApiVersion: 1,
          },
        ],
        changes: [],
        activePageSlug: "main",
      }),
    );
    expect(m.pageDescriptors()).toHaveLength(1);
    expect(m.project().activePageSlug).toBe("main");
  });
});

describe("mirror.apply — turn lifecycle", () => {
  test("started -> tool/reasoning/usage progress -> gateRejected -> completed", () => {
    const m = createMirror();
    const turnId = uuidv7();
    m.apply(event("turn.started", { turnId, chatId: uuidv7(), deadline: TEST_TS }));
    let turn = m.turn();
    expect(turn.phase).toBe("running");
    if (turn.phase !== "running") throw new Error("unreachable");
    expect(turn.attempt).toBe(1);

    m.apply(
      event("turn.progress", {
        turnId,
        attempt: 1,
        content: { kind: "tool", op: "edit", target: "main/page.tsx" },
      }),
    );
    m.apply(
      event("turn.progress", {
        turnId,
        attempt: 1,
        content: { kind: "reasoning", text: "laying out gauges" },
      }),
    );
    m.apply(
      event("turn.progress", {
        turnId,
        attempt: 1,
        content: {
          kind: "usage",
          tokens: { inputTokens: 10, outputTokens: 5, contextPercent: 42 },
        },
      }),
    );
    turn = m.turn();
    if (turn.phase !== "running") throw new Error("unreachable");
    expect(turn.steps).toEqual([{ kind: "tool", op: "edit", target: "main/page.tsx" }]);
    expect(turn.reasoning).toBe("laying out gauges");
    expect(turn.usage?.contextPercent).toBe(42);

    m.apply(
      event("turn.gateRejected", {
        turnId,
        attempt: 1,
        retryNumber: 1,
        diagnostics: { errors: [], warnings: [] },
      }),
    );
    turn = m.turn();
    if (turn.phase !== "running") throw new Error("unreachable");
    expect(turn.gateRetries).toHaveLength(1);
    expect(turn.gateRetries[0]?.retryNumber).toBe(1);

    m.apply(
      event("turn.completed", {
        turnId,
        outcome: "completed",
        changedPages: [{ pageSlug: "main", sourceHash: TEST_SHA }],
        warnings: [],
        failure: null,
      }),
    );
    turn = m.turn();
    expect(turn.phase).toBe("terminal");
    if (turn.phase !== "terminal") throw new Error("unreachable");
    expect(turn.outcome).toBe("completed");
    expect(turn.changedPages).toHaveLength(1);
  });

  test("attemptStarted restarts steps but keeps gate-retry history", () => {
    const m = createMirror();
    const turnId = uuidv7();
    m.apply(event("turn.started", { turnId, chatId: uuidv7(), deadline: TEST_TS }));
    m.apply(
      event("turn.progress", {
        turnId,
        attempt: 1,
        content: { kind: "tool", op: "read", target: "x" },
      }),
    );
    m.apply(
      event("turn.gateRejected", {
        turnId,
        attempt: 1,
        retryNumber: 1,
        diagnostics: { errors: [], warnings: [] },
      }),
    );
    m.apply(event("turn.attemptStarted", { turnId, attempt: 2, deadline: TEST_TS }));
    const turn = m.turn();
    if (turn.phase !== "running") throw new Error("unreachable");
    expect(turn.attempt).toBe(2);
    expect(turn.steps).toEqual([]);
    expect(turn.gateRetries).toHaveLength(1);
  });

  test("progress for a non-matching turn id is ignored", () => {
    const m = createMirror();
    const turnId = uuidv7();
    m.apply(event("turn.started", { turnId, chatId: uuidv7(), deadline: TEST_TS }));
    m.apply(
      event("turn.progress", {
        turnId: uuidv7(),
        attempt: 1,
        content: { kind: "reasoning", text: "stray" },
      }),
    );
    const turn = m.turn();
    if (turn.phase !== "running") throw new Error("unreachable");
    expect(turn.reasoning).toBeNull();
  });
});

describe("mirror.apply — preview", () => {
  test("sessionReady -> ready; failed -> failed; circuitOpened -> circuit-open", () => {
    const m = createMirror();
    const previewSessionId = uuidv7();
    m.apply(
      event("preview.sessionReady", {
        previewSessionId,
        nonce: TEST_NONCE,
        pageSlug: "main",
        sourceHash: TEST_SHA,
        hostMode: "static",
        interactionMode: "static",
        size: { w: 120, h: 40 },
        theme: "dark-default",
        initialFrameSeq: "1",
      }),
    );
    expect(m.preview().phase).toBe("ready");

    m.apply(
      event("preview.failed", {
        previewSessionId,
        nonce: TEST_NONCE,
        pageSlug: "main",
        sourceHash: TEST_SHA,
        phase: "live",
        failure: failure(),
      }),
    );
    const failed = m.preview();
    expect(failed.phase).toBe("failed");
    if (failed.phase !== "failed") throw new Error("unreachable");
    expect(failed.lifecycle).toBe("live");

    m.apply(
      event("preview.circuitOpened", {
        previewSessionId,
        pageSlug: "main",
        sourceHash: TEST_SHA,
        attempts: 3,
        finalFailure: failure("HOST_CIRCUIT_OPEN"),
        retryCapability: { available: true },
      }),
    );
    const circuit = m.preview();
    expect(circuit.phase).toBe("circuit-open");
    if (circuit.phase !== "circuit-open") throw new Error("unreachable");
    expect(circuit.retryAvailable).toBe(true);
  });
});

describe("mirror.apply — chats / selection / pins / diagnostics / export", () => {
  test("chat.changed merges summaries and sets the active chat", () => {
    const m = createMirror();
    const a = uuidv7();
    const b = uuidv7();
    m.apply(
      event("chat.changed", {
        activeChatId: b,
        added: [
          { chatId: a, createdAt: TEST_TS },
          { chatId: b, createdAt: TEST_TS },
        ],
        updated: [],
        removedChatIds: [],
      }),
    );
    expect(m.chats().activeChatId).toBe(b);
    expect(m.chats().summaries.size).toBe(2);
    expect(m.project().activeChatId).toBe(b);

    m.apply(
      event("chat.changed", { activeChatId: a, added: [], updated: [], removedChatIds: [b] }),
    );
    expect(m.chats().summaries.has(b)).toBe(false);
    expect(m.chats().activeChatId).toBe(a);
  });

  test("selection.changed stores the DTO or null", () => {
    const m = createMirror();
    m.apply(
      event("selection.changed", { pageSlug: "main", elementId: "cpu", sourceHash: TEST_SHA }),
    );
    expect(m.selection()?.elementId).toBe("cpu");
    m.apply(event("selection.changed", null));
    expect(m.selection()).toBeNull();
  });

  test("pins.changed upserts pins per page by pinId", () => {
    const m = createMirror();
    const pinId = uuidv7();
    const basePin = {
      pinId,
      pageSlug: "main",
      elementId: "cpu",
      fx: 0.5,
      fy: 0.5,
      text: "why top?",
      status: "open" as const,
      createdRecordId: uuidv7(),
      latestRecordId: uuidv7(),
      updatedAt: TEST_TS,
    };
    m.apply(
      event("pins.changed", {
        pageSlug: "main",
        affectedPins: [basePin],
        affectedRecordIds: [],
        causeId: uuidv7(),
      }),
    );
    expect(m.pinsByPage().get("main")).toHaveLength(1);

    m.apply(
      event("pins.changed", {
        pageSlug: "main",
        affectedPins: [{ ...basePin, status: "resolved" }],
        affectedRecordIds: [],
        causeId: uuidv7(),
      }),
    );
    const pins = m.pinsByPage().get("main");
    expect(pins).toHaveLength(1);
    expect(pins?.[0]?.status).toBe("resolved");
  });

  test("diagnostics.changed upserts and removes", () => {
    const m = createMirror();
    const id = uuidv7();
    m.apply(
      event("diagnostics.changed", {
        generation: "1",
        upserts: [
          { diagnosticId: id, scope: "turn", severity: "error", code: "GATE", safeMessage: "bad" },
        ],
        removedDiagnosticIds: [],
      }),
    );
    expect(m.diagnostics().size).toBe(1);
    m.apply(
      event("diagnostics.changed", { generation: "2", upserts: [], removedDiagnosticIds: [id] }),
    );
    expect(m.diagnostics().size).toBe(0);
  });

  test("export lifecycle started -> progress -> completed", () => {
    const m = createMirror();
    const operationId = uuidv7();
    m.apply(
      event("export.started", {
        operationId,
        sourceSnapshotDigest: TEST_SHA,
        pageCount: 2,
        renderJobCount: 6,
        destination: ".termcraft/export",
      }),
    );
    let ex = m.export();
    expect(ex.phase).toBe("running");
    if (ex.phase !== "running") throw new Error("unreachable");
    expect(ex.totalJobs).toBe(6);

    m.apply(
      event("export.progress", {
        operationId,
        phase: "publishing",
        completedJobs: 6,
        totalJobs: 6,
        pageSlug: null,
        sizeBytes: null,
      }),
    );
    ex = m.export();
    if (ex.phase !== "running") throw new Error("unreachable");
    expect(ex.lifecycle).toBe("publishing");

    m.apply(
      event("export.completed", {
        operationId,
        phase: "publishing",
        destination: ".termcraft/export",
        generationId: uuidv7(),
        failure: null,
      }),
    );
    expect(m.export().phase).toBe("done");
  });
});

describe("mirror.apply — out-of-scope kinds are counter-only no-ops", () => {
  test("kernel.stateChanged advances counters but changes no slice", () => {
    const m = createMirror();
    m.apply(snapshot({ projectId: uuidv7(), trust: "trusted" }));
    const before = m.project();
    m.apply(
      event("kernel.stateChanged", {
        modelId: "kernel.turn.state",
        action: "start",
        previousTag: "idle",
        nextTag: "admitting",
        metadata: {},
      }),
    );
    expect(m.project()).toBe(before);
    expect(m.turn().phase).toBe("idle");
  });
});
