import { beforeEach, describe, expect, test } from "bun:test";

import { uuidv7 } from "infrastructure/uuid";
import { TEST_TS, createFakeKernel, event, resetEventSeq, snapshot } from "ui/testing";

import { createUiDeps } from "./deps";
import { applyIntent } from "./intent";

beforeEach(() => resetEventSeq());

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
    applyIntent({ kind: "fullscreen" }, deps);
    expect(deps.local.fullscreen()).toBe(true);
  });

  test("export dispatches export.start", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    applyIntent({ kind: "export" }, deps);
    expect(dispatchedKinds(kernel)).toEqual(["export.start"]);
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
