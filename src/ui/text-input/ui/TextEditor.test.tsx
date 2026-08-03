import { afterEach, describe, expect, test } from "bun:test";

import { type ReactTestRenderer, createReactTestRenderer } from "ui/testing";
import { SHELL_PALETTE } from "ui/theme";

import type { EditorBridge, TextEditorHandle } from "../types";
import { TextEditor } from "./TextEditor";

let open: ReactTestRenderer | null = null;
afterEach(async () => {
  await open?.destroy();
  open = null;
});

interface Probe {
  readonly bridge: EditorBridge;
  readonly seen: string[];
  handle: TextEditorHandle | null;
}

/**
 * A bridge shaped exactly like the one `createUiDeps` builds: it seeds the editor from a caller
 * -owned mirror on attach and records every projection back out. Created ONCE per test so its
 * `attach` identity is stable, which is the contract `TextEditor` documents.
 */
/**
 * G9 (measured against the installed `@opentui/core@0.4.5`): `EditorBridge.attach()`'s seed-time
 * `handle.setText(seed)` always echoes exactly one `mirror()` call at mount, through
 * `onContentChange` — regardless of `focused` — because `EditBufferRenderable` wires that
 * listener in its constructor, before React's ref ever fires, and `setText` does not diff
 * against the (empty) previous content. This is harmless in production (an idempotent re-set of
 * the same seed value) and orthogonal to focus, so "receives nothing while unfocused" below
 * asserts what actually matters: unfocused TYPING adds nothing beyond that one mount-time echo,
 * not that the echo itself doesn't happen.
 */
function probe(seed: string): Probe {
  const state: Probe = {
    seen: [],
    handle: null,
    bridge: {
      attach: (handle) => {
        state.handle = handle;
        if (handle !== null) handle.setText(seed);
      },
      mirror: (text) => {
        state.seen.push(text);
      },
    },
  };
  return state;
}

const STYLE = {
  caret: "❯ ",
  caretFg: SHELL_PALETTE.amber,
  valueFg: SHELL_PALETTE.fg,
  placeholderFg: SHELL_PALETTE.faint,
  cursorFg: SHELL_PALETTE.amber,
} as const;

describe("TextEditor — the shared editable buffer", () => {
  test("draws the caret run and the placeholder while empty", async () => {
    const state = probe("");
    const renderer = await createReactTestRenderer(
      <TextEditor
        id="ed"
        {...STYLE}
        placeholder="Ask for changes…"
        multiline
        rows={1}
        width={24}
        focused
        showCursor
        bridge={state.bridge}
      />,
      { width: 30, height: 4 },
    );
    open = renderer;
    expect(renderer.captureCharFrame()).toContain("❯ Ask for changes…");
  });

  test("seeds itself from the mirror at mount, through the bridge", async () => {
    const state = probe("carried over");
    const renderer = await createReactTestRenderer(
      <TextEditor
        id="ed"
        {...STYLE}
        placeholder="…"
        multiline
        rows={1}
        width={24}
        focused
        showCursor
        bridge={state.bridge}
      />,
      { width: 30, height: 4 },
    );
    open = renderer;
    expect(renderer.captureCharFrame()).toContain("carried over");
  });

  test("projects every buffer change back through the bridge", async () => {
    const state = probe("");
    const renderer = await createReactTestRenderer(
      <TextEditor
        id="ed"
        {...STYLE}
        placeholder="…"
        multiline
        rows={1}
        width={24}
        focused
        showCursor
        bridge={state.bridge}
      />,
      { width: 30, height: 4 },
    );
    open = renderer;
    await renderer.act(() => renderer.mockInput.typeText("abc"));
    expect(state.seen.at(-1)).toBe("abc");
  });

  test("receives nothing at all while unfocused", async () => {
    const state = probe("");
    const renderer = await createReactTestRenderer(
      <TextEditor
        id="ed"
        {...STYLE}
        placeholder="…"
        multiline
        rows={1}
        width={24}
        focused={false}
        showCursor={false}
        bridge={state.bridge}
      />,
      { width: 30, height: 4 },
    );
    open = renderer;
    const seenAtMount = state.seen.length;
    await renderer.act(() => renderer.mockInput.typeText("abc"));
    expect(state.seen.length).toBe(seenAtMount);
  });

  test("paints no cursor while showCursor is false, even though keys still arrive (§7.5)", async () => {
    const state = probe("");
    const renderer = await createReactTestRenderer(
      <TextEditor
        id="ed"
        {...STYLE}
        placeholder="…"
        multiline
        rows={1}
        width={24}
        focused
        showCursor={false}
        bridge={state.bridge}
      />,
      { width: 30, height: 4 },
    );
    open = renderer;
    // The cursor is the TERMINAL's own hardware cursor, never a painted glyph, so it cannot be
    // read out of `captureCharFrame()` — `getCursorState()` is the only honest assertion.
    expect(renderer.renderer.getCursorState().visible).toBe(false);
    await renderer.act(() => renderer.mockInput.typeText("typed anyway"));
    expect(state.seen.at(-1)).toBe("typed anyway");
  });

  test("paints the cursor while focused and showCursor is true", async () => {
    const state = probe("");
    const renderer = await createReactTestRenderer(
      <TextEditor
        id="ed"
        {...STYLE}
        placeholder="…"
        multiline
        rows={1}
        width={24}
        focused
        showCursor
        bridge={state.bridge}
      />,
      { width: 30, height: 4 },
    );
    open = renderer;
    expect(renderer.renderer.getCursorState().visible).toBe(true);
  });

  test("wraps and grows to the row count it is given", async () => {
    const state = probe("");
    const renderer = await createReactTestRenderer(
      <box id="wrap" width={20} height={6} flexDirection="column">
        <TextEditor
          id="ed"
          {...STYLE}
          placeholder="…"
          multiline
          rows={3}
          width={14}
          focused
          showCursor
          bridge={state.bridge}
        />
        <text id="below">{"---"}</text>
      </box>,
      { width: 20, height: 6 },
    );
    open = renderer;
    await renderer.act(() => renderer.mockInput.typeText("hello world again"));
    const frame = renderer.captureCharFrame();
    expect(frame).toContain("❯ hello world");
    expect(frame.split("\n")[1]).toContain("again");
    // The sibling below is pushed down by the editor's full height, never overdrawn.
    expect(frame.split("\n")[3]).toContain("---");
  });

  test("the single-line variant refuses a newline outright", async () => {
    const state = probe("");
    const renderer = await createReactTestRenderer(
      <TextEditor
        id="ed"
        {...STYLE}
        placeholder="…"
        multiline={false}
        rows={1}
        width={24}
        focused
        showCursor
        bridge={state.bridge}
      />,
      { width: 30, height: 4 },
    );
    open = renderer;
    await renderer.act(() => {
      renderer.mockInput.typeText("a");
      renderer.mockInput.pressEnter({ shift: true });
      renderer.mockInput.typeText("b");
    });
    expect(state.seen.at(-1)).toBe("ab");
  });

  test("clears the handle when it unmounts, so nothing writes into a dead editor", async () => {
    const state = probe("");
    const renderer = await createReactTestRenderer(
      <TextEditor
        id="ed"
        {...STYLE}
        placeholder="…"
        multiline
        rows={1}
        width={24}
        focused
        showCursor
        bridge={state.bridge}
      />,
      { width: 30, height: 4 },
    );
    open = renderer;
    expect(state.handle).not.toBeNull();
    await renderer.destroy();
    open = null;
    expect(state.handle).toBeNull();
  });
});
