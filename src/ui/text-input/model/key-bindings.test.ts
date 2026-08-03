import { afterEach, describe, expect, test } from "bun:test";

import { TextareaRenderable } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createTestRenderer } from "@opentui/core/testing";

import { TEXT_EDITOR_KEY_BINDINGS } from "./key-bindings";

/**
 * The table is asserted THROUGH OPENTUI'S OWN RESOLUTION, by pressing real keys at a real
 * `TextareaRenderable`, not by reading the array back. Its internal lookup helpers
 * (`mergeKeyBindings`, `buildKeyBindingsMap`, `getKeyBindingAction`) live in
 * `lib/keybinding.internal.js`, which the package neither re-exports nor makes reachable by deep
 * import — `package.json`'s `exports` map has no wildcard entry. Driving the renderable is the
 * same resolution path, exercised end to end.
 *
 * G8 (measured against the installed `@opentui/core@0.4.5`'s `createTestRenderer`, on top of
 * G1–G7 in the plan): the mock's `mockInput.pressKey(value, modifiers)` behaves asymmetrically
 * across keyboard modes. Under `kittyKeyboard: true` it ALWAYS re-encodes a single-character
 * `value` into a kitty CSI sequence — even with no `modifiers` argument — so a pre-encoded raw
 * ASCII control byte (e.g. `"\u0017"` for Ctrl+W) loses its ctrl-ness and arrives as an unmodified
 * keypress of that codepoint instead. Under `kittyKeyboard: false` the same call passes the raw
 * byte straight through. Chords below that need an explicit ctrl modifier under the kitty tests
 * therefore use `pressKey("<letter>", { ctrl: true })` (or `{ ctrl: true, shift: true }`) rather
 * than a pre-encoded byte; a bare Ctrl+J uses `pressKeys(["\n"])` (the same raw-passthrough
 * primitive `typeText` is built on) since the mock has no symbolic name for a modified linefeed.
 * Separately, `TextareaRenderable`'s `initialValue` seeds the buffer with the cursor at position
 * 0, not at the end — tests that need to type AFTER a seeded value seed with `""` and type the
 * seed as their own first action instead. And `pressBackspace({ ctrl: true })` always encodes an
 * explicit modifier-carrying sequence in both keyboard modes (verified by reading
 * `testing.bun.js`), so it cannot simulate a legacy terminal's inability to distinguish
 * Ctrl+Backspace from plain Backspace — that one test sends a bare, unmodified `pressBackspace()`
 * instead, which is what a real legacy terminal actually sends either way.
 */
let open: TestRendererSetup | null = null;
let editor: TextareaRenderable | null = null;

afterEach(() => {
  open?.renderer.destroy();
  open = null;
  editor = null;
});

async function mount(kittyKeyboard: boolean, initialValue = ""): Promise<TestRendererSetup> {
  const setup = await createTestRenderer({ width: 40, height: 10, kittyKeyboard });
  open = setup;
  const textarea = new TextareaRenderable(setup.renderer, {
    id: "kb-editor",
    width: 30,
    height: 6,
    wrapMode: "word",
    keyBindings: [...TEXT_EDITOR_KEY_BINDINGS],
    initialValue,
  });
  setup.renderer.root.add(textarea);
  textarea.focus();
  editor = textarea;
  await setup.renderOnce();
  return setup;
}

const text = (): string => editor?.plainText ?? "<no editor>";

describe("TEXT_EDITOR_KEY_BINDINGS — with the extended keyboard protocol", () => {
  test("Enter submits rather than inserting a line break (onSubmit is deliberately unwired)", async () => {
    const setup = await mount(true, "hello");
    setup.mockInput.pressEnter();
    await setup.renderOnce();
    // `submit()` with no listener is a no-op. If the App ever fails to claim Enter the editor
    // refuses rather than silently breaking the line — a refusal beats a wrong action (§6.2).
    expect(text()).toBe("hello");
  });

  test("numpad Enter submits too — alias resolution is single-hop, so it needs its own row", async () => {
    const setup = await mount(true, "hello");
    setup.mockInput.pressKey("\u001b[57414u");
    await setup.renderOnce();
    expect(text()).toBe("hello");
  });

  test("Shift+Enter, Alt+Enter and Ctrl+J all insert a newline", async () => {
    const setup = await mount(true, "");
    setup.mockInput.typeText("a");
    setup.mockInput.pressEnter({ shift: true });
    setup.mockInput.typeText("b");
    setup.mockInput.pressEnter({ meta: true });
    setup.mockInput.typeText("c");
    setup.mockInput.pressKeys(["\n"]);
    setup.mockInput.typeText("d");
    await setup.renderOnce();
    expect(text()).toBe("a\nb\nc\nd");
  });

  test("Shift+numpad-Enter inserts a newline", async () => {
    const setup = await mount(true, "");
    setup.mockInput.typeText("a");
    setup.mockInput.pressKey("\u001b[57414;2u");
    setup.mockInput.typeText("b");
    await setup.renderOnce();
    expect(text()).toBe("a\nb");
  });

  test("Ctrl+Backspace and Ctrl+W both delete the word behind the cursor", async () => {
    const setup = await mount(true, "");
    setup.mockInput.typeText("alpha beta gamma");
    setup.mockInput.pressBackspace({ ctrl: true });
    await setup.renderOnce();
    expect(text()).toBe("alpha beta ");
    setup.mockInput.pressKey("w", { ctrl: true });
    await setup.renderOnce();
    expect(text()).toBe("alpha ");
  });

  test("Ctrl+Delete deletes the word ahead of the cursor", async () => {
    const setup = await mount(true, "");
    setup.mockInput.typeText("alpha beta");
    setup.mockInput.pressKey("\u001b[1;5D");
    setup.mockInput.pressKey("\u001b[3;5~");
    await setup.renderOnce();
    expect(text()).toBe("alpha ");
  });

  test("Ctrl+Left and Ctrl+Right move by word", async () => {
    const setup = await mount(true, "");
    setup.mockInput.typeText("alpha beta");
    setup.mockInput.pressKey("\u001b[1;5D");
    setup.mockInput.typeText("X");
    await setup.renderOnce();
    expect(text()).toBe("alpha Xbeta");
    setup.mockInput.pressKey("\u001b[1;5C");
    setup.mockInput.typeText("Y");
    await setup.renderOnce();
    expect(text()).toBe("alpha XbetaY");
  });

  test("Ctrl+Z undoes and Ctrl+Shift+Z / Ctrl+Y redo — nothing usable exists in the defaults", async () => {
    const setup = await mount(true, "");
    setup.mockInput.typeText("abc");
    await setup.renderOnce();
    setup.mockInput.pressKey("z", { ctrl: true });
    await setup.renderOnce();
    expect(text()).not.toBe("abc");
    setup.mockInput.pressKey("\u001b[122;6u");
    await setup.renderOnce();
    expect(text()).toBe("abc");
    setup.mockInput.pressKey("z", { ctrl: true });
    await setup.renderOnce();
    setup.mockInput.pressKey("y", { ctrl: true });
    await setup.renderOnce();
    expect(text()).toBe("abc");
  });

  test("Ctrl+A selects all rather than jumping to line start — the default is not removable", async () => {
    const setup = await mount(true, "");
    setup.mockInput.typeText("abcdef");
    setup.mockInput.pressKey("a", { ctrl: true });
    setup.mockInput.typeText("Z");
    await setup.renderOnce();
    // select-all then a printable replaces the selection; line-home would have prefixed it.
    expect(text()).toBe("Z");
  });
});

describe("TEXT_EDITOR_KEY_BINDINGS — the universal fallbacks on a legacy terminal", () => {
  test("Ctrl+J still breaks the line where Shift+Enter cannot be encoded at all", async () => {
    const setup = await mount(false, "");
    setup.mockInput.typeText("a");
    setup.mockInput.pressEnter({ shift: true });
    await setup.renderOnce();
    // The byte for Shift+Enter does not exist outside the extended protocol, so nothing arrives.
    expect(text()).toBe("a");
    setup.mockInput.pressKey("\n");
    setup.mockInput.typeText("b");
    await setup.renderOnce();
    expect(text()).toBe("a\nb");
  });

  test("Ctrl+W still deletes a word where Ctrl+Backspace collapses to a plain backspace", async () => {
    const setup = await mount(false, "");
    setup.mockInput.typeText("alpha beta");
    // A legacy terminal cannot encode Ctrl+Backspace distinctly from plain Backspace — both arrive
    // as a bare 0x08 — so this sends that bare byte directly rather than asking the mock to
    // synthesize a modifier-carrying sequence no real legacy terminal would produce (G8).
    setup.mockInput.pressBackspace();
    await setup.renderOnce();
    // The parser reports `backspace` with NO ctrl for 0x08, so the word binding cannot fire.
    expect(text()).toBe("alpha bet");
    setup.mockInput.pressKey("\u0017");
    await setup.renderOnce();
    expect(text()).toBe("alpha ");
  });

  test("Ctrl+Y still redoes where Ctrl+Shift+Z cannot be encoded", async () => {
    const setup = await mount(false, "");
    setup.mockInput.typeText("abc");
    await setup.renderOnce();
    setup.mockInput.pressKey("\u001a");
    await setup.renderOnce();
    expect(text()).not.toBe("abc");
    setup.mockInput.pressKey("\u0019");
    await setup.renderOnce();
    expect(text()).toBe("abc");
  });
});
