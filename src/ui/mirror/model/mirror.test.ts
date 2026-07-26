import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { FailureDtoV1, UUIDv7 } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";
import { TEST_NONCE, TEST_SHA, TEST_TS, event, resetEventSeq, snapshot } from "ui/testing";

import type { TurnProgressContent } from "../types";
import { createMirror } from "./mirror";
import { deriveScreen } from "./screen";

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
          { id: "turn.start", target: null, state: { available: true } },
          {
            id: "export.start",
            target: null,
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

describe("mirror.apply — kernel.stateChanged (project identity, §10 smoke closeout bug 2)", () => {
  // Home never reached Workspace through a live subscription: `deriveScreen`'s own
  // `projectId !== null` gate could never become true, because the mirror only ever set
  // `project.projectId` from `kernel.snapshot` — which is never sent a second time
  // (kernel-command-contract §9). `handlers/project.ts` now carries the real identity on
  // `kernel.stateChanged`'s own `metadata` instead; these tests prove the mirror actually
  // reads it, and that `deriveScreen` genuinely leaves `"home"` once it does.

  const TERMINAL = { w: 120, h: 40 };

  test('kernel.project.finishOpen sets projectId + trust from metadata, and deriveScreen leaves "home"', () => {
    const m = createMirror();
    m.apply(snapshot()); // the bootstrap snapshot — still "home" (projectId null)
    expect(
      deriveScreen({
        projectId: m.project().projectId,
        trust: m.project().trust,
        terminal: TERMINAL,
      }),
    ).toBe("home");

    const projectId = uuidv7();
    m.apply(
      event("kernel.stateChanged", {
        modelId: "kernel.project.state",
        action: "kernel.project.finishOpen",
        previousTag: "opening",
        nextTag: "ready",
        metadata: { projectId, trust: "untrusted-read-only" },
      }),
    );

    expect(m.project().projectId).toBe(projectId);
    expect(m.project().trust).toBe("untrusted-read-only");
    // The transition genuinely left "home" (to "read-only", since trust is not yet granted)
    // — the exact condition the bug report named as "can never become true for a live
    // subscriber".
    expect(
      deriveScreen({
        projectId: m.project().projectId,
        trust: m.project().trust,
        terminal: TERMINAL,
      }),
    ).toBe("read-only");
  });

  test("kernel.project.setTrust moves the screen the rest of the way to workspace", () => {
    const m = createMirror();
    const projectId = uuidv7();
    m.apply(
      event("kernel.stateChanged", {
        modelId: "kernel.project.state",
        action: "kernel.project.finishOpen",
        previousTag: "opening",
        nextTag: "ready",
        metadata: { projectId, trust: "untrusted-read-only" },
      }),
    );
    m.apply(
      event("kernel.stateChanged", {
        modelId: "kernel.project.state",
        action: "kernel.project.setTrust",
        previousTag: "ready",
        nextTag: "ready",
        metadata: { workspaceIdentity: "ws-1", trust: "trusted" },
      }),
    );

    expect(m.project()).toEqual({
      projectId,
      activePageSlug: null,
      activeChatId: null,
      trust: "trusted",
    });
    expect(
      deriveScreen({
        projectId: m.project().projectId,
        trust: m.project().trust,
        terminal: TERMINAL,
      }),
    ).toBe("workspace");
  });

  test("kernel.project.finishClose resets the project slice to empty (a project-scoped identity must not outlive the project)", () => {
    const m = createMirror();
    const projectId = uuidv7();
    m.apply(
      event("kernel.stateChanged", {
        modelId: "kernel.project.state",
        action: "kernel.project.finishOpen",
        previousTag: "opening",
        nextTag: "ready",
        metadata: { projectId, trust: "trusted" },
      }),
    );
    expect(m.project().projectId).toBe(projectId);

    m.apply(
      event("kernel.stateChanged", {
        modelId: "kernel.project.state",
        action: "kernel.project.finishClose",
        previousTag: "closing",
        nextTag: "closed",
        metadata: { projectId: null },
      }),
    );

    expect(m.project()).toEqual({
      projectId: null,
      activePageSlug: null,
      activeChatId: null,
      trust: null,
    });
    expect(
      deriveScreen({
        projectId: m.project().projectId,
        trust: m.project().trust,
        terminal: TERMINAL,
      }),
    ).toBe("home");
  });

  test("a malformed metadata.projectId is logged and dropped — never fabricated, prior value untouched", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const m = createMirror();
      m.apply(
        event("kernel.stateChanged", {
          modelId: "kernel.project.state",
          action: "kernel.project.finishOpen",
          previousTag: "opening",
          nextTag: "ready",
          metadata: { projectId: "not-a-uuid", trust: "trusted" },
        }),
      );
      expect(m.project().projectId).toBeNull();
      expect(m.project().trust).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("a malformed metadata.trust on setTrust is logged and dropped", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const m = createMirror();
      const projectId = uuidv7();
      m.apply(
        event("kernel.stateChanged", {
          modelId: "kernel.project.state",
          action: "kernel.project.finishOpen",
          previousTag: "opening",
          nextTag: "ready",
          metadata: { projectId, trust: "trusted" },
        }),
      );
      m.apply(
        event("kernel.stateChanged", {
          modelId: "kernel.project.state",
          action: "kernel.project.setTrust",
          previousTag: "ready",
          nextTag: "ready",
          metadata: { workspaceIdentity: "ws-1", trust: "not-a-real-decision" },
        }),
      );
      expect(m.project().trust).toBe("trusted");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("a kernel.stateChanged for a different model (e.g. kernel.turn.state) never touches project — narrow, targeted scope only", () => {
    const m = createMirror();
    m.apply(snapshot({ projectId: uuidv7(), trust: "trusted" }));
    const before = m.project();
    // `kernel.turn.finishAdmission`, not `kernel.turn.beginAdmission` — the latter now folds
    // into the TURN slice (fix-bundle Task 11 fix round 1, Finding 2; see the dedicated
    // `kernel.turn.beginAdmission` describe block above), which this test does not assert on
    // at all — it only proves a `kernel.stateChanged` for a NON-`kernel.project.state` model
    // never reaches the `project` slice, still true regardless of which turn action fires.
    m.apply(
      event("kernel.stateChanged", {
        modelId: "kernel.turn.state",
        action: "kernel.turn.finishAdmission",
        previousTag: "admitting",
        nextTag: "workspace-ready",
        metadata: {},
      }),
    );
    expect(m.project()).toEqual(before);
  });
});

describe("mirror.apply — agentIdentity (M22)", () => {
  test("seeds a non-null agentIdentity from the snapshot", () => {
    const m = createMirror();
    m.apply(snapshot({ agentIdentity: { backendId: "claude", modelLabel: "sonnet-4.5" } }));
    expect(m.agentIdentity()).toEqual({ backendId: "claude", modelLabel: "sonnet-4.5" });
  });

  test("a snapshot with agentIdentity null yields null (no backend selected yet)", () => {
    const m = createMirror();
    m.apply(snapshot({ agentIdentity: null }));
    expect(m.agentIdentity()).toBeNull();
  });

  test("a later snapshot re-seeds agentIdentity, like the other transient slices", () => {
    const m = createMirror();
    m.apply(snapshot({ agentIdentity: { backendId: "claude", modelLabel: "sonnet-4.5" } }));
    expect(m.agentIdentity()).not.toBeNull();
    m.apply(snapshot({ agentIdentity: null }));
    expect(m.agentIdentity()).toBeNull();
  });
});

describe("mirror.apply — capabilities changed", () => {
  test("upserts changed entries and deletes removed ids", () => {
    const m = createMirror();
    m.apply(
      snapshot({ capabilities: [{ id: "turn.start", target: null, state: { available: true } }] }),
    );
    m.apply(
      event("kernel.capabilitiesChanged", {
        changed: [
          {
            id: "turn.start",
            target: null,
            state: { available: false, reasons: [{ code: "PROJECT_NOT_READY" }] },
          },
          { id: "chat.create", target: null, state: { available: true } },
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
        removed: [{ id: "chat.create", target: null }],
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
    expect(turn.timeline).toEqual([
      { kind: "step", op: "edit", target: "main/page.tsx" },
      { kind: "reasoning", text: "laying out gauges" },
    ]);
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

  test("attemptStarted restarts the timeline but keeps gate-retry history", () => {
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
    expect(turn.timeline).toEqual([]);
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
    expect(turn.timeline).toEqual([]);
  });
});

describe("mirror.apply — turn timeline (fix-bundle Task 19: reasoning + tool steps merge into one ordered list, spec §4.6)", () => {
  const TURN_ID = uuidv7();

  function turnStarted(turnId: UUIDv7) {
    return event("turn.started", { turnId, chatId: uuidv7(), deadline: TEST_TS });
  }

  function progress(turnId: UUIDv7, content: TurnProgressContent) {
    return event("turn.progress", { turnId, attempt: 1, content });
  }

  function gateRejected(turnId: UUIDv7, retryNumber: number) {
    return event("turn.gateRejected", {
      turnId,
      attempt: 1,
      retryNumber,
      diagnostics: { errors: [], warnings: [] },
    });
  }

  function attemptStarted(turnId: UUIDv7, attempt: number) {
    return event("turn.attemptStarted", { turnId, attempt, deadline: TEST_TS });
  }

  test("keeps reasoning and tool steps in ONE list, in arrival order", () => {
    const mirror = createMirror(() => 1_000);
    mirror.apply(turnStarted(TURN_ID));
    mirror.apply(progress(TURN_ID, { kind: "tool", op: "read", target: "page.tsx" }));
    mirror.apply(
      progress(TURN_ID, { kind: "reasoning", text: "the gauges already fill the top band" }),
    );
    // NOT "write" (the brief's own draft used that literal, but `AgentToolOp`
    // (`entities/turn/types.ts`) only allows read|edit|run|search|other — `normalize.test.ts`
    // confirms the SDK's `Write` tool call itself normalizes to `edit`).
    mirror.apply(progress(TURN_ID, { kind: "tool", op: "edit", target: "page.tsx" }));
    mirror.apply(progress(TURN_ID, { kind: "reasoning", text: "reusing the resources frame" }));

    const turn = mirror.turn();
    expect(turn.phase).toBe("running");
    if (turn.phase !== "running") return;
    expect(turn.timeline).toEqual([
      { kind: "step", op: "read", target: "page.tsx" },
      { kind: "reasoning", text: "the gauges already fill the top band" },
      { kind: "step", op: "edit", target: "page.tsx" },
      { kind: "reasoning", text: "reusing the resources frame" },
    ]);
  });

  test("no longer overwrites the previous thought", () => {
    const mirror = createMirror(() => 0);
    mirror.apply(turnStarted(TURN_ID));
    mirror.apply(progress(TURN_ID, { kind: "reasoning", text: "first" }));
    mirror.apply(progress(TURN_ID, { kind: "reasoning", text: "second" }));

    const turn = mirror.turn();
    if (turn.phase !== "running") return;
    expect(turn.timeline.filter((e) => e.kind === "reasoning")).toHaveLength(2);
  });

  test("records when the turn started, from the UI's own clock", () => {
    const mirror = createMirror(() => 12_345);
    mirror.apply(turnStarted(TURN_ID));
    const turn = mirror.turn();
    if (turn.phase !== "running") return;
    expect(turn.startedAt).toBe(12_345);
  });

  test("clears the timeline on a retry but keeps the accumulated gate-retry lines", () => {
    const mirror = createMirror(() => 0);
    mirror.apply(turnStarted(TURN_ID));
    mirror.apply(progress(TURN_ID, { kind: "reasoning", text: "first attempt" }));
    mirror.apply(gateRejected(TURN_ID, 1));
    mirror.apply(attemptStarted(TURN_ID, 2));

    const turn = mirror.turn();
    if (turn.phase !== "running") return;
    expect(turn.timeline).toEqual([]);
    expect(turn.gateRetries).toHaveLength(1);
  });
});

describe("mirror.apply — kernel.turn.beginAdmission (fix-bundle Task 11 fix round 1, Finding 2)", () => {
  test("reflects the turn as running from the moment admission begins, deadline honestly null, startedAt from the UI's own clock", () => {
    const m = createMirror(() => 5_000);
    const turnId = uuidv7();
    m.apply(
      event(
        "kernel.stateChanged",
        {
          modelId: "kernel.turn.state",
          action: "kernel.turn.beginAdmission",
          previousTag: "idle",
          nextTag: "admitting",
          metadata: {},
        },
        { correlation: { turnId } },
      ),
    );
    expect(m.turn()).toEqual({
      phase: "running",
      turnId,
      attempt: 1,
      deadline: null,
      timeline: [],
      startedAt: 5_000,
      finalText: null,
      errorText: null,
      usage: null,
      gateRetries: [],
    });
  });

  test("turn.started still overwrites it moments later, with the real deadline", () => {
    const m = createMirror();
    const turnId = uuidv7();
    m.apply(
      event(
        "kernel.stateChanged",
        {
          modelId: "kernel.turn.state",
          action: "kernel.turn.beginAdmission",
          previousTag: "idle",
          nextTag: "admitting",
          metadata: {},
        },
        { correlation: { turnId } },
      ),
    );
    m.apply(event("turn.started", { turnId, chatId: uuidv7(), deadline: TEST_TS }));
    const turn = m.turn();
    if (turn.phase !== "running") throw new Error("unreachable");
    expect(turn.deadline).toBe(TEST_TS);
  });

  test("a missing correlation.turnId is logged and dropped — never a fabricated id", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const m = createMirror();
      const before = m.turn();
      m.apply(
        event("kernel.stateChanged", {
          modelId: "kernel.turn.state",
          action: "kernel.turn.beginAdmission",
          previousTag: "idle",
          nextTag: "admitting",
          metadata: {},
        }),
      );
      expect(m.turn()).toEqual(before);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("every OTHER kernel.turn.state action stays ignored — narrow, targeted scope only", () => {
    const m = createMirror();
    const before = m.turn();
    m.apply(
      event("kernel.stateChanged", {
        modelId: "kernel.turn.state",
        action: "kernel.turn.finishAdmission",
        previousTag: "admitting",
        nextTag: "workspace-ready",
        metadata: {},
      }),
    );
    expect(m.turn()).toEqual(before);
  });
});

describe("mirror.apply — turn.started producer/consumer seam (fixlane-K1-turn-spine.json)", () => {
  // This mirror-side gating (turn.attemptStarted/turn.progress/turn.gateRejected all `return`
  // unless `current.phase === "running"`) was always correct; the seam bug was that NO real
  // producer ever published `turn.started` (`core/kernel/model/handlers/turn.ts`'s own header,
  // "deliberately not published"). `case "turn.started"` (mirror.ts:266) sets that phase, but
  // — fix-bundle Task 11 fix round 1 — it is no longer the ONLY transition that does: the
  // `kernel.turn.beginAdmission` fold (its own dedicated describe block, above) sets it first,
  // during admission, and `turn.started` still unconditionally overwrites that moments later;
  // neither changes the gating this seam is about. These two tests pin BOTH sides: the first
  // replays exactly what a real turn looked like to the mirror BEFORE the fix (no `turn.started`
  // at all); the second replays the exact sequence `handlers/turn.ts`'s `publish` now emits
  // (`turn.started` strictly before the first `turn.attemptStarted`, both same
  // `turnId`/`deadline`).

  test("WITHOUT a prior turn.started, the real event sequence (attemptStarted -> progress -> completed) never leaves idle — pins why the seam bug mattered", () => {
    const m = createMirror();
    const turnId = uuidv7();
    expect(m.turn().phase).toBe("idle");

    m.apply(event("turn.attemptStarted", { turnId, attempt: 1, deadline: TEST_TS }));
    // Gated on phase === "running" (mirror.ts's own guard) — dropped, still idle.
    expect(m.turn().phase).toBe("idle");

    m.apply(
      event("turn.progress", {
        turnId,
        attempt: 1,
        content: { kind: "reasoning", text: "laying out gauges" },
      }),
    );
    expect(m.turn().phase).toBe("idle");

    // turn.completed is the one terminal case mirror.ts applies unconditionally (no
    // phase/turnId gate) — so the user would have seen NOTHING stream, then a sudden jump
    // straight to "terminal", exactly the smoke-closeout symptom the seam finding describes.
    m.apply(
      event("turn.completed", {
        turnId,
        outcome: "completed",
        changedPages: [],
        warnings: [],
        failure: null,
      }),
    );
    expect(m.turn().phase).toBe("terminal");
  });

  test("WITH turn.started immediately preceding the first turn.attemptStarted (the exact order handlers/turn.ts's real Kernel composition now emits), every subsequent event applies through to completed", () => {
    const m = createMirror();
    const turnId = uuidv7();
    const chatId = uuidv7();

    m.apply(event("turn.started", { turnId, chatId, deadline: TEST_TS }));
    let turn = m.turn();
    expect(turn.phase).toBe("running");
    if (turn.phase !== "running") throw new Error("unreachable");
    expect(turn.attempt).toBe(1);
    expect(turn.timeline).toEqual([]);

    // The real producer's own first turn.attemptStarted — same turnId, same deadline
    // (`handlers/turn.ts`'s `publish`: "deadline is the SAME non-resettable absolute bound").
    m.apply(event("turn.attemptStarted", { turnId, attempt: 1, deadline: TEST_TS }));
    turn = m.turn();
    if (turn.phase !== "running") throw new Error("unreachable");
    expect(turn.attempt).toBe(1);

    m.apply(
      event("turn.progress", {
        turnId,
        attempt: 1,
        content: { kind: "reasoning", text: "laying out gauges" },
      }),
    );
    turn = m.turn();
    if (turn.phase !== "running") throw new Error("unreachable");
    expect(turn.timeline).toEqual([{ kind: "reasoning", text: "laying out gauges" }]);

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
          { chatId: a, createdAt: TEST_TS, displayName: null },
          { chatId: b, createdAt: TEST_TS, displayName: null },
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

  test("export.progress carries sizeBytes onto the running phase (M14)", () => {
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
    m.apply(
      event("export.progress", {
        operationId,
        phase: "rendering",
        completedJobs: 3,
        totalJobs: 6,
        pageSlug: "main",
        sizeBytes: 4096,
      }),
    );
    const ex = m.export();
    if (ex.phase !== "running") throw new Error("unreachable");
    expect(ex.pageSlug).toBe("main");
    expect(ex.sizeBytes).toBe(4096);
  });

  test("export.failed retains the last progress's pageSlug/sizeBytes (M14 — the terminal payload itself carries neither)", () => {
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
    m.apply(
      event("export.progress", {
        operationId,
        phase: "rendering",
        completedJobs: 3,
        totalJobs: 6,
        pageSlug: "main",
        sizeBytes: 4096,
      }),
    );
    const failure = {
      code: "EXPORT_PUBLICATION_FAILED",
      retryable: false,
      safeMessage: "disk full",
      details: {},
    } as const;
    m.apply(
      event("export.failed", {
        operationId,
        phase: "rendering",
        destination: ".termcraft/export",
        generationId: null,
        failure,
      }),
    );
    const ex = m.export();
    expect(ex.phase).toBe("failed");
    if (ex.phase !== "failed") throw new Error("unreachable");
    expect(ex.pageSlug).toBe("main");
    expect(ex.sizeBytes).toBe(4096);
    expect(ex.failure).toEqual(failure);
  });

  test("export.failed with no prior progress retains null pageSlug/sizeBytes", () => {
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
    m.apply(
      event("export.failed", {
        operationId,
        phase: "rendering",
        destination: ".termcraft/export",
        generationId: null,
        failure: null,
      }),
    );
    const ex = m.export();
    if (ex.phase !== "failed") throw new Error("unreachable");
    expect(ex.pageSlug).toBeNull();
    expect(ex.sizeBytes).toBeNull();
  });
});

describe("mirror.apply — records (persisted chat tail, WP-10 Task 7)", () => {
  // A DTO-shaped `chat.records` user record fixture; `chatId` is not part of the record itself
  // (it lives on the envelope's `chatId` field) — this helper only builds the record body.
  const userRecord = () => ({
    kind: "user" as const,
    recordId: uuidv7(),
    turnId: uuidv7(),
    text: "build a system monitor",
    selection: null,
    pins: [],
    ts: TEST_TS,
  });

  test("chat.records for the active chat sets records", () => {
    const m = createMirror();
    const chatId = uuidv7();
    m.apply(snapshot({ activeChatId: chatId }));
    const record = userRecord();
    m.apply(event("chat.records", { chatId, records: [record], prevCursor: null }));
    expect(m.records()).toEqual([record]);
  });

  test("chat.records for a non-active chat is ignored", () => {
    const m = createMirror();
    const activeChatId = uuidv7();
    const otherChatId = uuidv7();
    m.apply(snapshot({ activeChatId }));
    m.apply(
      event("chat.records", { chatId: otherChatId, records: [userRecord()], prevCursor: null }),
    );
    expect(m.records()).toEqual([]);
  });

  test("a fresh kernel.snapshot clears records", () => {
    const m = createMirror();
    const chatId = uuidv7();
    m.apply(snapshot({ activeChatId: chatId }));
    m.apply(event("chat.records", { chatId, records: [userRecord()], prevCursor: null }));
    expect(m.records()).toHaveLength(1);
    m.apply(snapshot());
    expect(m.records()).toEqual([]);
  });

  test("switching the active chat (chat.changed) clears the stale tail", () => {
    const m = createMirror();
    const chatA = uuidv7();
    const chatB = uuidv7();
    m.apply(snapshot({ activeChatId: chatA }));
    m.apply(event("chat.records", { chatId: chatA, records: [userRecord()], prevCursor: null }));
    expect(m.records()).toHaveLength(1);
    m.apply(
      event("chat.changed", {
        activeChatId: chatB,
        added: [{ chatId: chatB, createdAt: TEST_TS, displayName: null }],
        updated: [],
        removedChatIds: [],
      }),
    );
    expect(m.records()).toEqual([]);
  });

  test("chat.changed that keeps the SAME active chat does not clear an already-loaded tail", () => {
    const m = createMirror();
    const chatId = uuidv7();
    m.apply(snapshot({ activeChatId: chatId }));
    m.apply(event("chat.records", { chatId, records: [userRecord()], prevCursor: null }));
    expect(m.records()).toHaveLength(1);
    m.apply(
      event("chat.changed", {
        activeChatId: chatId,
        added: [],
        updated: [{ chatId, createdAt: TEST_TS, displayName: "hi" }],
        removedChatIds: [],
      }),
    );
    expect(m.records()).toHaveLength(1);
  });
});

describe("mirror.apply — out-of-scope kinds are counter-only no-ops", () => {
  test("kernel.stateChanged advances counters but changes no slice", () => {
    const m = createMirror();
    m.apply(snapshot({ projectId: uuidv7(), trust: "trusted" }));
    const before = m.project();
    // `kernel.turn.finishAdmission` — NOT `kernel.turn.beginAdmission`, which is no longer
    // out-of-scope (fix-bundle Task 11 fix round 1, Finding 2; see the dedicated
    // `kernel.turn.beginAdmission` describe block, above `mirror.apply — turn.started
    // producer/consumer seam`). This test keeps proving the GENERAL "an unhandled
    // kernel.stateChanged is a counter-only no-op" rule with a still-genuinely-unhandled action.
    m.apply(
      event("kernel.stateChanged", {
        modelId: "kernel.turn.state",
        action: "kernel.turn.finishAdmission",
        previousTag: "admitting",
        nextTag: "workspace-ready",
        metadata: {},
      }),
    );
    expect(m.project()).toBe(before);
    expect(m.turn().phase).toBe("idle");
  });
});
