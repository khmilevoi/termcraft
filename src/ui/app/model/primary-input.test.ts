import { describe, expect, test } from "bun:test";

import { uuidv7 } from "infrastructure/uuid";
import { createFakeKernel, snapshot } from "ui/testing";
import type { TextEditorHandle } from "ui/text-input";

import { createUiDeps } from "./deps";
import {
  applyTurnTerminal,
  mirrorPrimaryInput,
  primaryInputAtom,
  setPrimaryInput,
} from "./primary-input";

/**
 * A handle that records what was done to it, standing in for a mounted editor.
 *
 * It carries its own buffer so `text()` answers what a real editor's live buffer would, which is
 * what `flushEditors` reads — the mirror atom and the buffer are allowed to disagree here exactly
 * as they transiently do in production.
 */
function fakeHandle(buffer = ""): TextEditorHandle & { readonly calls: string[] } {
  const calls: string[] = [];
  const state = { text: buffer };
  return {
    calls,
    setText: (text) => {
      state.text = text;
      calls.push(`setText:${text}`);
    },
    text: () => state.text,
    deleteCharBackward: () => calls.push("deleteCharBackward"),
  };
}

/**
 * Deps whose screen is `workspace`, so the primary input is the composer. The snapshot is not
 * optional decoration: `deriveScreen` holds Home until a `projectId` lands, and on Home
 * `primaryInputAtom` selects the PROMPT.
 */
const workspaceDeps = () => {
  const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
  deps.mirror.apply(snapshot({ projectId: uuidv7(), activePageSlug: "main", trust: "trusted" }));
  return deps;
};

describe("setPrimaryInput — the one upstream write (§7.2)", () => {
  test("writes the mirror AND the mounted editor", () => {
    const deps = workspaceDeps();
    const handle = fakeHandle();
    deps.local.composerEditor.set(handle);
    setPrimaryInput(deps, "repair this page");
    expect(deps.local.composer()).toBe("repair this page");
    expect(handle.calls).toEqual(["setText:repair this page"]);
  });

  test("writes the mirror even with no editor mounted — the unmount race (§7.2)", () => {
    const deps = workspaceDeps();
    deps.local.composerEditor.set(null);
    deps.local.composer.set("already sent");
    // The composer can unmount between `turn.start` and its accepted continuation. If the clear
    // only reached the handle, the mirror would still hold the sent text and a later remount
    // would seed the editor from it — the sent message reappearing in the composer.
    expect(() => setPrimaryInput(deps, "")).not.toThrow();
    expect(deps.local.composer()).toBe("");
  });

  test("targets the Home prompt while Home is the screen", () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    const handle = fakeHandle();
    deps.local.promptEditor.set(handle);
    expect(deps.screen()).toBe("home");
    setPrimaryInput(deps, "/");
    expect(deps.local.prompt()).toBe("/");
    expect(deps.local.composer()).toBe("");
    expect(handle.calls).toEqual(["setText:/"]);
  });
});

// WP-9 (design-agent-feedback-loop repair, Task 11): "on a terminal turn failure, the failed
// turn's user text is restored into the EXISTING composer draft" — never a new affordance, see
// `applyTurnTerminal`'s own doc comment above for the full reasoning and its citations.
describe("applyTurnTerminal — restoring (or discarding) the in-flight turn's own text", () => {
  test("a terminal turn failure leaves the failed turn's text in the composer draft", () => {
    const deps = workspaceDeps();
    deps.local.pendingTurnText.set("add a gpu temperature panel");
    applyTurnTerminal(deps, "turn.failed");
    expect(deps.local.composer()).toBe("add a gpu temperature panel");
    // Consumed, not left around for a LATER unrelated terminal event to restore again.
    expect(deps.local.pendingTurnText()).toBeNull();
  });

  test("restoring APPENDS to whatever the user typed while the turn was failing — never overwrites (R5)", () => {
    const deps = workspaceDeps();
    deps.local.composer.set("meanwhile I also want");
    deps.local.pendingTurnText.set("add a gpu temperature panel");
    applyTurnTerminal(deps, "turn.failed");
    expect(deps.local.composer()).toBe("meanwhile I also want\n\nadd a gpu temperature panel");
  });

  test("a CANCELLED turn does not restore the draft — the user chose to stop", () => {
    const deps = workspaceDeps();
    deps.local.pendingTurnText.set("add a gpu temperature panel");
    applyTurnTerminal(deps, "turn.cancelled");
    expect(deps.local.composer()).toBe("");
    // Still consumed — a cancel is terminal too, and a stray later restore would be worse.
    expect(deps.local.pendingTurnText()).toBeNull();
  });

  test("a COMPLETED turn discards the remembered text without touching the composer", () => {
    const deps = workspaceDeps();
    deps.local.composer.set("already typing the next thing");
    deps.local.pendingTurnText.set("add a gpu temperature panel");
    applyTurnTerminal(deps, "turn.completed");
    expect(deps.local.composer()).toBe("already typing the next thing");
    expect(deps.local.pendingTurnText()).toBeNull();
  });

  test("no pending text (e.g. this turn started before Task 11 wired the atom) is a no-op, not a crash", () => {
    const deps = workspaceDeps();
    expect(deps.local.pendingTurnText()).toBeNull();
    expect(() => applyTurnTerminal(deps, "turn.failed")).not.toThrow();
    expect(deps.local.composer()).toBe("");
  });
});

describe("primaryInputAtom — the screen's own primary input", () => {
  test("is the prompt on Home and the composer elsewhere", () => {
    const home = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    expect(primaryInputAtom(home)).toBe(home.local.prompt);
  });
});

describe("mirrorPrimaryInput — the one downstream projection (§7.3)", () => {
  test("writes the mirror and leaves a closed menu closed", () => {
    const deps = workspaceDeps();
    mirrorPrimaryInput(deps, "hello");
    expect(deps.local.composer()).toBe("hello");
    expect(deps.local.overlay()).toBeNull();
  });

  test("closes the menu once the filter is erased to empty", () => {
    const deps = workspaceDeps();
    deps.local.composer.set("/ex");
    deps.local.overlay.set("slash-menu");
    mirrorPrimaryInput(deps, "");
    expect(deps.local.overlay()).toBeNull();
    expect(deps.local.composer()).toBe("");
  });

  test("closes the menu once the leading slash itself is deleted", () => {
    const deps = workspaceDeps();
    deps.local.composer.set("/export");
    deps.local.overlay.set("slash-menu");
    // Reachable only now that the cursor can move into the string — a menu left open over text
    // with no leading slash draws as nothing, so Enter would go into silence.
    mirrorPrimaryInput(deps, "export");
    expect(deps.local.overlay()).toBeNull();
    expect(deps.local.composer()).toBe("export");
  });

  test("closes the menu once the filter matches no row", () => {
    const deps = workspaceDeps();
    deps.local.composer.set("/exp");
    deps.local.overlay.set("slash-menu");
    mirrorPrimaryInput(deps, "/nothing-matches-this");
    expect(deps.local.overlay()).toBeNull();
    expect(deps.local.composer()).toBe("/nothing-matches-this");
  });

  test("keeps the menu open while the prefix still matches", () => {
    const deps = workspaceDeps();
    deps.local.composer.set("/");
    deps.local.overlay.set("slash-menu");
    mirrorPrimaryInput(deps, "/e");
    expect(deps.local.overlay()).toBe("slash-menu");
  });

  test("the same closing rules apply on Home, whose prompt is the other primary input", () => {
    // NO `mirror.apply(snapshot(...))`: `deriveScreen` holds `"home"` until a `projectId` lands.
    // `mirrorPrimaryInput` branches on `screen !== "workspace" && screen !== "home"`, so `"home"`
    // is a genuinely distinct arm — and every test above runs on `workspace`, leaving it unproven.
    const home = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    expect(home.screen()).toBe("home");

    // Erased to empty.
    home.local.prompt.set("/e");
    home.local.overlay.set("slash-menu");
    mirrorPrimaryInput(home, "");
    expect(home.local.overlay()).toBeNull();
    expect(home.local.prompt()).toBe("");

    // The leading slash itself deleted.
    home.local.overlay.set("slash-menu");
    mirrorPrimaryInput(home, "exit");
    expect(home.local.overlay()).toBeNull();
    expect(home.local.prompt()).toBe("exit");

    // A filter matching no row. `/export` is the honest Home case rather than a contrived string:
    // `filterSlashRows` runs its SCREEN filter first and Home carries only `/model` and `/exit`,
    // so a prefix that matches on Workspace matches nothing here.
    home.local.overlay.set("slash-menu");
    mirrorPrimaryInput(home, "/export");
    expect(home.local.overlay()).toBeNull();

    // …while a prefix that does still match a Home row leaves the menu open.
    home.local.overlay.set("slash-menu");
    mirrorPrimaryInput(home, "/e");
    expect(home.local.overlay()).toBe("slash-menu");
    // The Workspace composer is never touched by any of it — `primaryInputAtom` picked the prompt.
    expect(home.local.composer()).toBe("");
  });
});

describe("the editor bridges createUiDeps exposes", () => {
  test("attach records the handle and seeds it from the mirror", () => {
    const deps = workspaceDeps();
    deps.local.composer.set("draft in flight");
    const handle = fakeHandle();
    deps.editors.composer.attach(handle);
    expect(deps.local.composerEditor()).toBe(handle);
    expect(handle.calls).toEqual(["setText:draft in flight"]);
  });

  test("attach(null) clears the handle without touching the mirror", () => {
    const deps = workspaceDeps();
    deps.local.composer.set("kept");
    deps.editors.composer.attach(fakeHandle());
    deps.editors.composer.attach(null);
    expect(deps.local.composerEditor()).toBeNull();
    expect(deps.local.composer()).toBe("kept");
  });

  test("the bridge functions keep one identity for the whole deps lifetime", () => {
    const deps = workspaceDeps();
    // A ref sink whose identity changes is detached and re-attached on every render, which would
    // re-seed the buffer mid-edit. Stability is the contract `TextEditor` documents.
    expect(deps.editors.composer.attach).toBe(deps.editors.composer.attach);
    expect(deps.editors.prompt.mirror).toBe(deps.editors.prompt.mirror);
  });

  test("the pin bridge writes only the pin draft", () => {
    const deps = workspaceDeps();
    deps.editors.pin.mirror("why is this always on top?");
    expect(deps.local.pinDraft()).toBe("why is this always on top?");
    expect(deps.local.composer()).toBe("");
  });
});
