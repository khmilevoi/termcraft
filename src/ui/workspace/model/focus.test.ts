import { describe, expect, test } from "bun:test";

import type { EscState } from "./focus";
import { nextFocus, resolveEsc, singleCharKeysActive } from "./focus";

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
    expect(resolveEsc({ ...base, focusAwayFromComposer: true, generationRunning: true })).toEqual({
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

  test("full priority order pops exactly one layer per press", () => {
    let state: EscState = {
      overlayOpen: "chat-list",
      focusAwayFromComposer: true,
      historicalBrowse: true,
      generationRunning: true,
      hasSelection: true,
    };
    expect(resolveEsc(state).kind).toBe("close-overlay");
    state = { ...state, overlayOpen: null };
    expect(resolveEsc(state).kind).toBe("unfocus-to-composer");
    state = { ...state, focusAwayFromComposer: false };
    expect(resolveEsc(state).kind).toBe("leave-history");
    state = { ...state, historicalBrowse: false };
    expect(resolveEsc(state).kind).toBe("cancel-generation");
    state = { ...state, generationRunning: false };
    expect(resolveEsc(state).kind).toBe("deselect");
  });
});

describe("nextFocus", () => {
  test("Tab toggles composer <-> preview", () => {
    expect(nextFocus("composer")).toBe("preview");
    expect(nextFocus("preview")).toBe("composer");
  });
});

describe("singleCharKeysActive", () => {
  test("live only when the preview is focused and no overlay is open", () => {
    expect(singleCharKeysActive("preview", null)).toBe(true);
    expect(singleCharKeysActive("composer", null)).toBe(false);
    expect(singleCharKeysActive("preview", "slash-menu")).toBe(false);
  });
});
