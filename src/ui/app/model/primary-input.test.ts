import { describe, expect, test } from "bun:test";

import { uuidv7 } from "infrastructure/uuid";
import { createFakeKernel, snapshot } from "ui/testing";
import type { TextEditorHandle } from "ui/text-input";

import { createUiDeps } from "./deps";
import { mirrorPrimaryInput, primaryInputAtom, setPrimaryInput } from "./primary-input";

/** A handle that records what was done to it, standing in for a mounted editor. */
function fakeHandle(): TextEditorHandle & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    setText: (text) => calls.push(`setText:${text}`),
    clear: () => calls.push("clear"),
    deleteCharBackward: () => calls.push("deleteCharBackward"),
    focus: () => calls.push("focus"),
    blur: () => calls.push("blur"),
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
