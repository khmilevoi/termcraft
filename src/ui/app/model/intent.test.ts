import { beforeEach, describe, expect, test } from "bun:test";

import { uuidv7 } from "infrastructure/uuid";
import { TEST_TS, createFakeKernel, event, resetEventSeq, snapshot } from "ui/testing";

import { createUiDeps } from "./deps";
import { applyIntent } from "./intent";

beforeEach(() => resetEventSeq());

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function dispatchedKinds(kernel: { dispatched: readonly unknown[] }): string[] {
  return kernel.dispatched.map((raw) => (raw as { kind: string }).kind);
}

describe("applyIntent — text inputs", () => {
  test("home-input / backspace edit the prompt atom", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    applyIntent({ kind: "home-input", ch: "h" }, deps);
    applyIntent({ kind: "home-input", ch: "i" }, deps);
    expect(deps.local.prompt()).toBe("hi");
    applyIntent({ kind: "home-backspace" }, deps);
    expect(deps.local.prompt()).toBe("h");
  });

  test("home-submit dispatches project.create carrying the prompt as text", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(
      kernel,
      { w: 120, h: 36 },
      { root: "/proj", workspaceIdentity: "wid" },
    );
    deps.local.prompt.set("a dashboard");
    applyIntent({ kind: "home-submit" }, deps);
    expect(kernel.dispatched).toHaveLength(1);
    const raw = kernel.dispatched[0] as {
      kind: string;
      payload: { root: string; text: string; creationDefaults: unknown };
    };
    expect(raw.kind).toBe("project.create");
    expect(raw.payload.text).toBe("a dashboard");
    expect(raw.payload.root).toBe("/proj");
    expect(raw.payload.creationDefaults).toEqual({ trust: "trusted", workspaceIdentity: "wid" });
  });

  test("home-submit on an empty prompt dispatches nothing", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    applyIntent({ kind: "home-submit" }, deps);
    expect(kernel.dispatched).toHaveLength(0);
  });

  test("composer-submit dispatches turn.start and clears the composer", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.local.composer.set("make it blue");
    applyIntent({ kind: "composer-submit" }, deps);
    expect(dispatchedKinds(kernel)).toEqual(["turn.start"]);
    expect((kernel.dispatched[0] as { payload: { text: string } }).payload.text).toBe(
      "make it blue",
    );
    expect(deps.local.composer()).toBe("");
  });
});

describe("applyIntent — local toggles", () => {
  test("tab cycles focus composer <-> preview", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    expect(deps.local.focus()).toBe("composer");
    applyIntent({ kind: "tab" }, deps);
    expect(deps.local.focus()).toBe("preview");
    applyIntent({ kind: "tab" }, deps);
    expect(deps.local.focus()).toBe("composer");
  });

  test("fullscreen toggles the fullscreen atom", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    applyIntent({ kind: "action-execute", actionId: "preview.fullscreen" }, deps);
    expect(deps.local.fullscreen()).toBe(true);
  });

  test("export dispatches export.start", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    applyIntent({ kind: "action-execute", actionId: "export.start" }, deps);
    expect(dispatchedKinds(kernel)).toEqual(["export.start"]);
  });
});

describe("applyIntent — slash menu", () => {
  test("opening and typing filters rows and selects the first enabled row", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        trust: "trusted",
        capabilities: [
          {
            id: "chat.create",
            target: null,
            state: { available: false, reasons: [{ code: "CAPABILITY_UNAVAILABLE" }] },
          },
          { id: "export.start", target: null, state: { available: true } },
        ],
      }),
    );

    applyIntent({ kind: "slash-open" }, deps);
    expect(deps.local.composer()).toBe("/");
    expect(deps.local.overlay()).toBe("slash-menu");
    expect(deps.local.slashSelection()).toBe(1); // skips disabled /new onto /chats

    applyIntent({ kind: "slash-input", ch: "e" }, deps);
    expect(deps.local.composer()).toBe("/e");
    expect(deps.local.slashSelection()).toBe(0);
  });

  test("arrows wrap across enabled rows and never land on inert rows", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        trust: "trusted",
        capabilities: [
          { id: "chat.create", target: null, state: { available: true } },
          { id: "export.start", target: null, state: { available: true } },
          {
            id: "model.select",
            target: { backend: "claude", model: "sonnet", effort: "high" },
            state: { available: true },
          },
        ],
      }),
    );
    applyIntent({ kind: "slash-open" }, deps);
    applyIntent({ kind: "slash-move", delta: -1 }, deps);
    expect(deps.local.slashSelection()).toBe(2); // wraps to /export, not inert /model or commits
    applyIntent({ kind: "slash-move", delta: 1 }, deps);
    expect(deps.local.slashSelection()).toBe(0);
  });

  test("Enter executes /new, /chats, and /export through their action descriptions", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        trust: "trusted",
        capabilities: [
          { id: "chat.create", target: null, state: { available: true } },
          { id: "export.start", target: null, state: { available: true } },
        ],
      }),
    );

    applyIntent({ kind: "slash-open" }, deps);
    applyIntent({ kind: "slash-submit" }, deps);
    expect(dispatchedKinds(kernel)).toEqual(["chat.create"]);

    deps.local.composer.set("/chats");
    deps.local.overlay.set("slash-menu");
    deps.local.slashSelection.set(0);
    applyIntent({ kind: "slash-submit" }, deps);
    expect(deps.local.overlay()).toBe("chat-list");

    deps.local.composer.set("/export");
    deps.local.overlay.set("slash-menu");
    deps.local.slashSelection.set(0);
    applyIntent({ kind: "slash-submit" }, deps);
    expect(dispatchedKinds(kernel)).toEqual(["chat.create", "export.start"]);
  });

  test("an already-resolved slash submit cannot dispatch after transition to read-only", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        trust: "untrusted-read-only",
        capabilities: [{ id: "chat.create", target: null, state: { available: true } }],
      }),
    );
    deps.local.composer.set("/new");
    deps.local.overlay.set("slash-menu");
    deps.local.slashSelection.set(0);

    applyIntent({ kind: "slash-submit" }, deps);

    expect(kernel.dispatched).toHaveLength(0);
    expect(deps.local.overlay()).toBeNull();
  });
});

describe("applyIntent — chats and trust", () => {
  test("chat navigation wraps and Enter dispatches chat.switch for the selected chatId", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const first = uuidv7();
    const second = uuidv7();
    deps.mirror.apply(
      event("chat.changed", {
        activeChatId: first,
        added: [
          { chatId: first, createdAt: TEST_TS },
          { chatId: second, createdAt: TEST_TS },
        ],
        updated: [],
        removedChatIds: [],
      }),
    );
    deps.local.overlay.set("chat-list");
    applyIntent({ kind: "chat-move", delta: -1 }, deps);
    expect(deps.local.chatSelection()).toBe(1);
    applyIntent({ kind: "chat-switch" }, deps);
    expect(dispatchedKinds(kernel)).toEqual(["chat.switch"]);
    expect((kernel.dispatched[0] as { payload: { chatId: string } }).payload).toEqual({
      chatId: second,
    });
    expect(deps.local.overlay()).toBeNull();
  });

  test("trust accept and decline dispatch the exact project.setTrust payloads", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(
      kernel,
      { w: 120, h: 36 },
      { root: "/project", workspaceIdentity: "workspace-id" },
    );
    applyIntent({ kind: "trust-accept" }, deps);
    applyIntent({ kind: "trust-decline" }, deps);
    expect(kernel.dispatched.map((raw) => (raw as { payload: unknown }).payload)).toEqual([
      { trust: "trusted", workspaceIdentity: "workspace-id" },
      { trust: "untrusted-read-only", workspaceIdentity: "workspace-id" },
    ]);
  });

  test("popup dismissal closes the overlay without reaching lower Esc layers", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.local.overlay.set("slash-menu");
    deps.local.focus.set("preview");
    applyIntent({ kind: "overlay-dismiss" }, deps);
    expect(deps.local.overlay()).toBeNull();
    expect(deps.local.focus()).toBe("preview");
  });
});

describe("applyIntent — export popup dismissal (M14)", () => {
  test("export-dismiss records the done export's operationId, dispatching nothing", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const operationId = uuidv7();
    deps.mirror.apply(
      event("export.completed", {
        operationId,
        phase: "publishing",
        destination: ".termcraft/export",
        generationId: null,
        failure: null,
      }),
    );
    expect(deps.local.exportDismissed()).toBeNull();
    applyIntent({ kind: "export-dismiss" }, deps);
    expect(deps.local.exportDismissed()).toBe(operationId);
    expect(kernel.dispatched).toHaveLength(0);
  });

  test("export-dismiss records the failed export's operationId", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const operationId = uuidv7();
    deps.mirror.apply(
      event("export.failed", {
        operationId,
        phase: "rendering",
        destination: ".termcraft/export",
        generationId: null,
        failure: null,
      }),
    );
    applyIntent({ kind: "export-dismiss" }, deps);
    expect(deps.local.exportDismissed()).toBe(operationId);
  });

  test("export-dismiss is a no-op while no export result is showing", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    applyIntent({ kind: "export-dismiss" }, deps);
    expect(deps.local.exportDismissed()).toBeNull();
    expect(kernel.dispatched).toHaveLength(0);
  });
});

describe("applyIntent — Home agent-health re-check (M15)", () => {
  test("home-recheck re-runs the injected health probe and updates the health atom", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 }, undefined, () =>
      Promise.resolve({ present: true, agent: "claude", version: "0.99", detail: "agent ready" }),
    );
    applyIntent({ kind: "home-recheck" }, deps);
    await tick();
    expect(deps.local.homeHealth()).toEqual({
      present: true,
      agent: "claude",
      version: "0.99",
      detail: "agent ready",
    });
  });

  test("home-recheck reflects a still-missing agent from the probe", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 }, undefined, () =>
      Promise.resolve({ present: false, agent: "claude", detail: "claude CLI not found" }),
    );
    applyIntent({ kind: "home-recheck" }, deps);
    await tick();
    expect(deps.local.homeHealth()).toEqual({
      present: false,
      agent: "claude",
      detail: "claude CLI not found",
    });
  });
});

describe("applyIntent — pin draft", () => {
  test("save dispatches only the opaque geometry token plus text", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.mirror.apply(snapshot({ projectId: uuidv7(), activePageSlug: "main", trust: "trusted" }));
    const geometryToken = uuidv7();
    deps.interaction.pendingPin.set({ geometryToken, point: { x: 4, y: 5 } });
    deps.local.pinDraft.set("why is this always on top?");
    deps.local.overlay.set("pin-input");

    applyIntent({ kind: "pin-save" }, deps);

    const command = kernel.dispatched[0] as { kind: string; payload: Record<string, unknown> };
    expect(command.kind).toBe("pin.create");
    expect(command.payload).toEqual({ geometryToken, text: "why is this always on top?" });
    expect(command.payload).not.toHaveProperty("pageSlug");
    expect(command.payload).not.toHaveProperty("elementId");
    expect(deps.local.overlay()).toBeNull();
    expect(deps.local.pinDraft()).toBe("");
  });

  test("save remains inert after transition to read-only", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        trust: "untrusted-read-only",
      }),
    );
    deps.interaction.pendingPin.set({ geometryToken: uuidv7(), point: { x: 1, y: 1 } });
    deps.local.pinDraft.set("must not save");
    deps.local.overlay.set("pin-input");

    applyIntent({ kind: "pin-save" }, deps);

    expect(kernel.dispatched).toHaveLength(0);
  });
});

describe("applyIntent — Esc layers", () => {
  test("esc closes an open overlay first", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.local.overlay.set("chat-list");
    applyIntent({ kind: "esc" }, deps);
    expect(deps.local.overlay()).toBeNull();
  });

  test("esc cancels a running generation (turn.cancel with the active turn id)", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const turnId = uuidv7();
    deps.mirror.apply(snapshot());
    deps.mirror.apply(event("turn.started", { turnId, chatId: uuidv7(), deadline: TEST_TS }));
    applyIntent({ kind: "esc" }, deps);
    expect(dispatchedKinds(kernel)).toEqual(["turn.cancel"]);
    expect((kernel.dispatched[0] as { payload: { turnId: string } }).payload.turnId).toBe(turnId);
  });

  test("esc with focus on preview returns focus to the composer before cancelling", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.local.focus.set("preview");
    deps.mirror.apply(
      event("turn.started", { turnId: uuidv7(), chatId: uuidv7(), deadline: TEST_TS }),
    );
    applyIntent({ kind: "esc" }, deps);
    expect(deps.local.focus()).toBe("composer");
    expect(kernel.dispatched).toHaveLength(0);
  });
});
