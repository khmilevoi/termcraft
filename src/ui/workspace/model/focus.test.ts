import { describe, expect, test } from "bun:test";

import type { EscState } from "./focus";
import { effectiveZone, nextFocus, resolveEsc } from "./focus";

const base: EscState = {
  overlayOpen: null,
  focusAwayFromComposer: false,
  historicalBrowse: false,
  generationRunning: false,
  hasSelection: false,
};

describe("resolveEsc — layered priority (design §3.8)", () => {
  test("layer 1: an open overlay closes first, above everything else", () => {
    expect(
      resolveEsc({
        ...base,
        overlayOpen: "slash-menu",
        generationRunning: true,
        hasSelection: true,
      }),
    ).toEqual({ kind: "close-overlay", overlay: "slash-menu" });
  });

  test("layer 2: focus away from composer returns to the composer", () => {
    // Combined with a LOWER-priority layer (3, historical browse) — layer 2 still wins over that,
    // unaffected by final-review Finding 1's fix. The two cases layer 2 now yields to (a running
    // generation, an active selection) get their own tests right below.
    expect(resolveEsc({ ...base, focusAwayFromComposer: true, historicalBrowse: true })).toEqual({
      kind: "unfocus-to-composer",
    });
  });

  // CORRECTED (final-review Finding 1, focus-scoped-hotkeys, 2026-08-10): this combination used to
  // assert `unfocus-to-composer` — the OLD, buggy behavior. Since Task 5, a click that both selects
  // an element/tab AND moves focus to the preview (a mouse click's side effect, not a deliberate
  // `Tab`) made this exact state reachable by mouse, and the first `Esc` afterward silently ate a
  // cancel the status bar's own "esc cancel" hint promised. Layer 2 now yields to a running
  // generation.
  test("layer 2 yields to a running generation — Esc cancels instead of returning focus", () => {
    expect(resolveEsc({ ...base, focusAwayFromComposer: true, generationRunning: true })).toEqual({
      kind: "cancel-generation",
    });
  });

  // Same fix, the selection half: a click that selects an element also moves focus to the preview
  // as a side effect, so the first `Esc` must deselect, not return focus.
  test("layer 2 yields to an active selection — Esc deselects instead of returning focus", () => {
    expect(resolveEsc({ ...base, focusAwayFromComposer: true, hasSelection: true })).toEqual({
      kind: "deselect",
    });
  });

  // The plain `Tab`-away case — nothing else active — is exactly the pre-fix behavior, unchanged.
  test("layer 2 alone (no running generation, no selection) still wins — the plain Tab-away case", () => {
    expect(resolveEsc({ ...base, focusAwayFromComposer: true })).toEqual({
      kind: "unfocus-to-composer",
    });
  });

  test("layer 3: historical browse returns to Current", () => {
    expect(resolveEsc({ ...base, historicalBrowse: true, hasSelection: true })).toEqual({
      kind: "leave-history",
    });
  });

  test("layer 4: a running generation is cancelled", () => {
    expect(resolveEsc({ ...base, generationRunning: true, hasSelection: true })).toEqual({
      kind: "cancel-generation",
    });
  });

  test("layer 5: a selected element is deselected", () => {
    expect(resolveEsc({ ...base, hasSelection: true })).toEqual({ kind: "deselect" });
  });

  test("nothing active -> none", () => {
    expect(resolveEsc(base)).toEqual({ kind: "none" });
  });

  // CORRECTED (final-review Finding 1, focus-scoped-hotkeys, 2026-08-10): the original version set
  // `generationRunning`/`hasSelection` true from the very first step, alongside
  // `focusAwayFromComposer` — under the fix, layer 2 yields to either of those, so that state can no
  // longer demonstrate "unfocus-to-composer" at all. Those two flags are introduced later in the
  // sequence instead, once the layer-2 step is already past.
  test("full priority order pops exactly one layer per press", () => {
    let state: EscState = {
      overlayOpen: "chat-list",
      focusAwayFromComposer: true,
      historicalBrowse: true,
      generationRunning: false,
      hasSelection: false,
    };
    expect(resolveEsc(state).kind).toBe("close-overlay");
    state = { ...state, overlayOpen: null };
    expect(resolveEsc(state).kind).toBe("unfocus-to-composer");
    state = { ...state, focusAwayFromComposer: false };
    expect(resolveEsc(state).kind).toBe("leave-history");
    state = { ...state, historicalBrowse: false, generationRunning: true, hasSelection: true };
    expect(resolveEsc(state).kind).toBe("cancel-generation");
    state = { ...state, generationRunning: false };
    expect(resolveEsc(state).kind).toBe("deselect");
  });
});

describe("nextFocus", () => {
  test("Tab toggles chat <-> preview", () => {
    expect(nextFocus("chat")).toBe("preview");
    expect(nextFocus("preview")).toBe("chat");
  });
});

describe("effectiveZone", () => {
  test("is the focus target while windowed", () => {
    expect(effectiveZone("chat", false)).toBe("chat");
    expect(effectiveZone("preview", false)).toBe("preview");
  });

  // The chat pane is not rendered in fullscreen (`Workspace.tsx`'s `!fullscreen &&` guard), so a
  // zone that could read "chat" there would name a pane that is not on screen.
  test("is forced to preview while fullscreen, whatever focus says", () => {
    expect(effectiveZone("chat", true)).toBe("preview");
    expect(effectiveZone("preview", true)).toBe("preview");
  });
});
