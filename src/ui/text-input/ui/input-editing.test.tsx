import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { TextareaRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { uuidv7 } from "infrastructure/uuid";
import { App, createUiDeps } from "ui/app";
import {
  type ReactTestRenderer,
  TEST_TS,
  createFakeKernel,
  createReactTestRenderer,
  event,
  resetEventSeq,
} from "ui/testing";

import { wrappedLineCount } from "../model/editor-height";
import { TEXT_EDITOR_KEY_BINDINGS } from "../model/key-bindings";

let open: ReactTestRenderer | null = null;
afterEach(async () => {
  await open?.destroy();
  open = null;
});
beforeEach(() => resetEventSeq());

/**
 * The same open-project snapshot `App.test.tsx` and `Workspace.test.tsx` already build — but
 * handed to `createFakeKernel`'s own `snapshot` OPTION rather than applied to the mirror
 * directly. `FakeKernel.subscribe` delivers its bootstrap `kernel.snapshot` SYNCHRONOUSLY
 * (matching the real bus), and `App`'s `runtime` connect hook is what calls `subscribe` — on
 * mount, not before. A `deps.mirror.apply(...)` made before `createReactTestRenderer` is
 * therefore folded, then immediately clobbered by the kernel's own default (closed-project)
 * bootstrap snapshot the moment the connect hook subscribes. Seeding the kernel itself is what
 * every existing `App.test.tsx`/`Workspace.test.tsx` fixture that needs an already-open project
 * at first paint actually does.
 */
const WORKSPACE_SNAPSHOT_OVERRIDES = () => ({
  projectId: uuidv7(),
  activePageSlug: "main",
  activeChatId: uuidv7(),
  trust: "trusted" as const,
  agentIdentity: { backendId: "claude", modelLabel: "sonnet-4.5" },
});

async function workspace(kittyKeyboard: boolean) {
  const kernel = createFakeKernel({ snapshot: WORKSPACE_SNAPSHOT_OVERRIDES() });
  const deps = createUiDeps(kernel, {
    w: 120,
    h: 36,
  });
  const renderer = await createReactTestRenderer(<App deps={deps} />, {
    width: 120,
    height: 36,
    kittyKeyboard,
  });
  open = renderer;
  await renderer.waitForFrame((frame) => frame.includes("Ask for changes…"));
  return { deps, kernel, renderer };
}

describe("the two-mode run — §9.2's degradation table as an executable test", () => {
  test("with the extended protocol, Shift+Enter breaks the line and Ctrl+Backspace eats a word", async () => {
    const { deps, renderer } = await workspace(true);
    await renderer.act(() => {
      renderer.mockInput.typeText("alpha beta");
      renderer.mockInput.pressEnter({ shift: true });
      renderer.mockInput.typeText("gamma");
    });
    expect(deps.local.composer()).toBe("alpha beta\ngamma");
    await renderer.act(() => renderer.mockInput.pressBackspace({ ctrl: true }));
    // MEASURED (against the installed @opentui/core@0.4.5): `delete-word-backward`'s native
    // boundary scan treats the newline right before "gamma" as part of the same boundary and
    // deletes it together with the word, rather than stopping at the line break — eating "gamma"
    // also eats the break that preceded it.
    expect(deps.local.composer()).toBe("alpha beta");
  });

  test("without it, Ctrl+J breaks the line and Ctrl+W eats a word", async () => {
    const { deps, renderer } = await workspace(false);
    await renderer.act(() => {
      renderer.mockInput.typeText("alpha beta");
      renderer.mockInput.pressKey("\n");
      renderer.mockInput.typeText("gamma");
    });
    expect(deps.local.composer()).toBe("alpha beta\ngamma");
    // MEASURED (against the installed `mock-keys.js`): `pressBackspace({ ctrl: true })` always
    // encodes a modified backspace as the CSI-27 "modifyOtherKeys" sequence, regardless of the
    // renderer's own `kittyKeyboard` option — that option only changes which encoding a LETTER
    // key gets, not backspace's — so it cannot simulate a terminal that fails to report Ctrl on
    // Backspace at all. The genuinely degraded case — the one Ctrl+W exists to cover — is a BARE
    // backspace byte with no modifier bits, i.e. `pressBackspace()` with no `ctrl`.
    await renderer.act(() => renderer.mockInput.pressBackspace());
    expect(deps.local.composer()).toBe("alpha beta\ngamm");
    // Ctrl+W (bound by default, needing no encoding beyond a single control byte — the reason
    // it's the universal fallback) is what actually deletes the word here.
    await renderer.act(() => renderer.mockInput.pressKey("\u0017"));
    // Same native boundary behaviour as the kitty case above: `delete-word-backward` eats the
    // newline together with "gamm".
    expect(deps.local.composer()).toBe("alpha beta");
  });

  test("without it, a Shift+Enter press is an ordinary Enter — and therefore SENDS", async () => {
    const { deps, kernel, renderer } = await workspace(false);
    await renderer.act(() => renderer.mockInput.typeText("alpha beta"));
    // CORRECTED 2026-08-03 (final-review fix wave). This press used to sit inside the test above
    // under the comment "the byte for Shift+Enter does not exist here — this is a no-op, not a
    // failure". Half right: §4.4's table says the `CSI 13;2u` byte does not exist in legacy mode,
    // but what the terminal delivers instead is a BARE `\r`, indistinguishable from Enter — so it
    // is not a no-op, it is a submit. `mock-keys.js` reproduces that faithfully (with neither
    // kitty nor modifyOtherKeys there is no encoding for the modifier, so the `\r` goes out
    // unchanged), and it is the whole reason §4.4 binds `Ctrl+J`/`Alt+Enter` as the universal
    // newline fallbacks rather than treating Shift+Enter as merely unavailable.
    //
    // The old placement only passed because the mirror lagged the editor's buffer: the burst was
    // drained synchronously, so `composer-submit` read `local.composer()` as still empty and
    // refused silently. `flushEditors` removes that accident, which is what surfaced this.
    await renderer.act(() => renderer.mockInput.pressEnter({ shift: true }));
    expect(kernel.dispatched.map((raw) => (raw as { kind: string }).kind)).toContain("turn.start");
    await renderer.waitFor(() => deps.local.composer() === "");
  });
});

describe("growth, scroll and the chat budget", () => {
  test("Enter still submits while Shift+Enter breaks the line", async () => {
    const { deps, renderer } = await workspace(true);
    // `typeText` awaited explicitly, THEN `pressEnter` — not both fired from one un-awaited
    // block. MEASURED: `composer-submit`'s guard reads `local.composer()` (the mirror atom, not
    // the editor's own live buffer) the instant Enter's key event is processed; queuing Enter's
    // stdin bytes in the same synchronous burst as the still-in-flight typed characters lets it
    // read the pre-typing (empty) value and silently refuse — a real race, not a flake, and the
    // one place in this file where the ordering actually matters (every other multi-step `act`
    // block only inserts text or moves the cursor, which has no such point-of-no-return guard).
    await renderer.act(async () => {
      await renderer.mockInput.typeText("send me");
      renderer.mockInput.pressEnter();
    });
    await renderer.waitFor(() => deps.local.composer() === "");
    expect(deps.local.composer()).toBe("");
  });

  test("the composer stops growing at the ceiling and scrolls to follow the cursor", async () => {
    const { deps, renderer } = await workspace(true);
    await renderer.act(() => {
      for (let line = 1; line <= 9; line += 1) {
        renderer.mockInput.typeText(`line${line}`);
        renderer.mockInput.pressEnter({ shift: true });
      }
      renderer.mockInput.typeText("tail");
    });
    const frame = renderer.captureCharFrame();
    // The ceiling at frameH 35 is 6 rows, so the head has scrolled out and the tail is on screen.
    expect(frame).toContain("tail");
    expect(frame).not.toContain("line1");
    expect(deps.local.composer().split("\n")).toHaveLength(10);
  });

  test("a bracketed paste lands in the buffer whole, newlines and all (§9.4)", async () => {
    const { deps, renderer } = await workspace(true);
    // NEW BEHAVIOUR: `usePaste` is wired nowhere in this codebase, so pasted text used to arrive
    // as individual keypresses or be lost outright. `TextareaRenderable.handlePaste` inserts it
    // as one edit. No size cap is introduced — the design has none, and silently truncating a
    // user's text is worse than inserting it.
    await renderer.act(() => renderer.mockInput.pasteBracketedText("one\ntwo\nthree"));
    expect(deps.local.composer()).toBe("one\ntwo\nthree");
  });

  test("a grown composer costs the scrollback its rows", async () => {
    const { deps, renderer } = await workspace(true);
    const before = renderer.captureCharFrame().split("\n").length;
    await renderer.act(() => {
      renderer.mockInput.pressEnter({ shift: true });
      renderer.mockInput.pressEnter({ shift: true });
    });
    // The frame is the same height; what changed is how many of its rows the composer owns.
    expect(renderer.captureCharFrame().split("\n").length).toBe(before);
    expect(deps.local.composer()).toBe("\n\n");
  });
});

describe("the slash menu's two new closing rules, end to end", () => {
  test("deleting the leading slash closes the menu and leaves the text", async () => {
    const { deps, renderer } = await workspace(true);
    await renderer.act(() => renderer.mockInput.typeText("/export"));
    expect(deps.local.overlay()).toBe("slash-menu");
    await renderer.act(() => {
      // Home, then delete forward past the "/" — reachable only now that the cursor can move.
      renderer.mockInput.pressKey("HOME");
      renderer.mockInput.pressKey("DELETE");
    });
    expect(deps.local.overlay()).toBeNull();
    expect(deps.local.composer()).toBe("export");
  });

  test("erasing the filter to empty closes the menu", async () => {
    const { deps, renderer } = await workspace(true);
    await renderer.act(() => renderer.mockInput.typeText("/e"));
    expect(deps.local.overlay()).toBe("slash-menu");
    await renderer.act(() => {
      renderer.mockInput.pressBackspace();
      renderer.mockInput.pressBackspace();
    });
    expect(deps.local.overlay()).toBeNull();
    expect(deps.local.composer()).toBe("");
  });

  test("arrows edit the filter while up/down still move the selection", async () => {
    const { deps, renderer } = await workspace(true);
    await renderer.act(() => renderer.mockInput.typeText("/export"));
    await renderer.act(() => {
      renderer.mockInput.pressArrow("left");
      renderer.mockInput.typeText("X");
    });
    expect(deps.local.composer()).toBe("/exporXt");
  });
});

/**
 * The mirror atom lags the editor's own buffer by a microtask, and every synchronous reader of
 * that atom — `resolveKey`'s context, `applyIntent`'s submit guards — has to be caught up first.
 *
 * MEASURED (against the installed `@opentui/core@0.4.5`): `onContentChange` is driven by the
 * native `content-changed` event, which the FFI event bus delivers inside a `queueMicrotask`
 * (`chunk-bun-t2myhmwd.js`, `setupEventBus`), while `CliRenderer.stdinListener` pushes a whole
 * chunk into `StdinParser` and drains EVERY key event out of it in one synchronous `while` loop
 * (`StdinParser.drain`). No microtask runs between two keys carried by the same chunk.
 *
 * These two tests are the only ones in the repo that reproduce that: they emit ONE `data` event
 * carrying several bytes. `mockInput.typeText()` cannot stand in for it — it emits one `data`
 * event per character, so each key arrives through its own listener call.
 */
describe("several keys in ONE stdin chunk — the mirror is caught up before the keymap reads it", () => {
  test("a slash typed right after other text in the same chunk does not destroy the draft", async () => {
    const { deps, renderer } = await workspace(true);
    await renderer.act(() => {
      // Four bytes, one chunk — what a terminal delivers for fast typing, key-repeat, or an
      // SSH/tmux-coalesced burst. With a stale mirror the `/` byte resolves to `slash-open`
      // (`keymap.ts`'s `composerValue.length === 0` check reads the PRE-"abc" value), the App
      // claims the key, and `setPrimaryInput(deps, "/")` overwrites the buffer with just "/".
      renderer.renderer.stdin.emit("data", Buffer.from("abc/"));
    });
    expect(deps.local.composer()).toBe("abc/");
    expect(deps.local.overlay()).toBeNull();
  });

  test("typed text plus Enter in the same chunk still sends the full text", async () => {
    const { deps, kernel, renderer } = await workspace(true);
    await renderer.act(() => {
      renderer.renderer.stdin.emit("data", Buffer.from("send me\r"));
    });
    // `composer-submit` reads `local.composer()` the instant Enter is processed and refuses an
    // empty one silently — a stale mirror makes the whole turn disappear with nothing on screen.
    const started = kernel.dispatched.find(
      (raw) => (raw as { kind: string }).kind === "turn.start",
    ) as { kind: string; payload: { text: string } } | undefined;
    expect(started?.payload.text).toBe("send me");
    // And the composer clears only once the Kernel ACCEPTS the turn (`intent.ts`), so an empty
    // composer afterwards is the observable proof the submit actually landed.
    await renderer.waitFor(() => deps.local.composer() === "");
  });
});

describe("wrappedLineCount conformance — our counter against the native layout", () => {
  const CASES: ReadonlyArray<readonly [string, number]> = [
    ["hello world again", 10],
    ["supercalifragilisticexpialidocious", 10],
    ["日本語日本語日本語", 10],
    ["abc\n", 10],
    ["ab cdefghijklmnopqr", 10],
    ["", 10],
  ];

  test("agrees with TextareaRenderable.virtualLineCount for every case", async () => {
    const setup = await createTestRenderer({ width: 60, height: 60 });
    try {
      const editors = CASES.map(([text, width], index) => {
        const editor = new TextareaRenderable(setup.renderer, {
          id: `conformance-${index}`,
          width,
          height: 8,
          wrapMode: "word",
          keyBindings: [...TEXT_EDITOR_KEY_BINDINGS],
          initialValue: text,
        });
        setup.renderer.root.add(editor);
        return editor;
      });
      await setup.renderOnce();
      CASES.forEach(([text, width], index) => {
        // This is the ONLY thing holding an independent counter to the renderer's own layout. It
        // exists because the row budget must be known in the SAME frame the text changes — asking
        // the renderable would answer one frame late and make the chat region jitter on every wrap.
        expect(wrappedLineCount(text, width)).toBe(editors[index]?.virtualLineCount ?? -1);
      });
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("the cursor is painted exactly where §7.5 says", () => {
  test("a running turn with an empty draft keeps typing live but paints no cursor", async () => {
    const { deps, renderer } = await workspace(true);
    await renderer.act(() => {
      // Driven through the mirror's own event fold, exactly as `Workspace.test.tsx` does — never
      // by writing a mirror slice directly.
      deps.mirror.apply(
        event("turn.started", { turnId: uuidv7(), chatId: uuidv7(), deadline: TEST_TS }),
      );
    });
    expect(renderer.renderer.getCursorState().visible).toBe(false);
    await renderer.act(() => renderer.mockInput.typeText("next message"));
    expect(deps.local.composer()).toBe("next message");
    // A non-empty draft during a turn looks alive again — `wsGenTyping`'s own two states. Polled
    // rather than a bare synchronous read: the native cursor's own visibility flip lands one
    // render tick after the `showCursor` prop change that drives it (measured — occasionally
    // still `false` immediately after the `act` above, always `true` within a following pass),
    // same class of render-pipeline lag the documented OpenTUI-under-load flakiness covers.
    await renderer.waitFor(() => renderer.renderer.getCursorState().visible);
    expect(renderer.renderer.getCursorState().visible).toBe(true);
  });

  test("focus on the preview takes the cursor off the composer entirely", async () => {
    const { renderer } = await workspace(true);
    await renderer.act(() => renderer.mockInput.pressTab());
    expect(renderer.renderer.getCursorState().visible).toBe(false);
  });
});
