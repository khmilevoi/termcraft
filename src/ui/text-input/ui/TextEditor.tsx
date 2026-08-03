import type { InputRenderable, TextareaRenderable } from "@opentui/core";

import { TEXT_EDITOR_KEY_BINDINGS } from "../model/key-bindings";
import type { EditorBridge, TextEditorHandle, TextEditorProps } from "../types";

type EditorRenderable = TextareaRenderable | InputRenderable;

const KEY_BINDINGS = [...TEXT_EDITOR_KEY_BINDINGS];

/**
 * Stable ref sinks, one per bridge.
 *
 * React re-invokes a ref callback whenever its identity changes — with `null` for the old one,
 * then the instance for the new one. An inline callback would therefore tear the editor's handle
 * down and re-seed the buffer on EVERY render, snapping the cursor back to the end while the user
 * types. Caching by the bridge (which `createUiDeps` creates once) makes the sink as stable as the
 * bridge it wraps. A `WeakMap` so a bridge belonging to a destroyed deps graph is collectable.
 */
interface Sink {
  /** The React ref callback — one identity per bridge, for the lifetime of the bridge. */
  readonly ref: (renderable: EditorRenderable | null) => void;
  /**
   * The live renderable. Kept here because `onContentChange`'s event object is empty
   * (`ContentChangeEvent` is `{}`), so the handler has to read `plainText` off the renderable
   * itself — and this is the only reference to it the component has.
   */
  current: EditorRenderable | null;
}

const REF_SINKS = new WeakMap<EditorBridge, Sink>();

function createHandle(renderable: EditorRenderable): TextEditorHandle {
  return {
    // G11 (measured against the installed @opentui/core@0.4.5): `EditBufferRenderable.setText`
    // replaces the content but leaves the cursor wherever the native buffer already had it —
    // offset 0 on a freshly-mounted or freshly-cleared editor — rather than moving it to the end
    // of the new text. `TextEditorHandle.setText`'s own contract (`types.ts`) already promised
    // "cursor to the end"; this line is what actually keeps that promise, so typing right after an
    // external write (`slash-open`'s `"/"`, the F6 repair fill) continues from the END of what was
    // just inserted instead of inserting before it.
    setText: (text) => {
      renderable.setText(text);
      renderable.cursorOffset = text.length;
    },
    // `EditBuffer.getText()` reads straight out of the native buffer, so this is the buffer's
    // OWN truth at call time — not the mirror atom, which the native event bus only catches up
    // on a microtask. That difference is the whole point of the accessor (`types.ts`).
    text: () => renderable.plainText,
    deleteCharBackward: () => {
      renderable.deleteCharBackward();
    },
  };
}

function sinkFor(bridge: EditorBridge): Sink {
  const cached = REF_SINKS.get(bridge);
  if (cached !== undefined) return cached;
  const sink: Sink = {
    current: null,
    ref: (renderable) => {
      sink.current = renderable;
      bridge.attach(renderable === null ? null : createHandle(renderable));
      // G10 (measured against the installed @opentui/core@0.4.5): `EditBufferRenderable`'s
      // constructor reads `options.showCursor` directly into its private field, bypassing the
      // `showCursor` setter's explicit native-cursor-hide branch, which only fires on a
      // `true -> false` TRANSITION. Left alone, an editor that mounts already
      // `showCursor={false}` leaves the terminal's native cursor at its own default
      // (`visible: true`) — exactly the running-turn-with-empty-draft case §7.5 needs hidden.
      // Forcing the transition here, through the renderable's own public getter/setter, closes
      // that gap without touching any private field.
      if (renderable !== null && renderable.showCursor === false) {
        renderable.showCursor = true;
        renderable.showCursor = false;
      }
    },
  };
  REF_SINKS.set(bridge, sink);
  return sink;
}

/**
 * The one editable text surface in the shell: the Workspace composer, the Home prompt, the
 * pin-input popup, and — because the slash filter IS the composer/prompt buffer — the slash menu.
 *
 * REPLACES the prior single-line input component (deleted 2026-08-03), and carries its design
 * citations forward. The placeholder-overlap rule that component emulated came from
 * `put`-over-`text` at the same column in
 * `design/termcraft-engine.js` — Home's `home()` `:145-146`
 * (`this.text(b,ix+4,iy+1,'Describe the TUI you want to design…',{fg:P.faint});
 * this.put(b,ix+4,iy+1,'█',{fg:P.amber,blink:true});`) and the composer's own placeholder branch,
 * `drawChat()` `:652` (`this.ctext(b,chatX+3,composerTop+2,…'Ask for changes…'…);` then
 * `this.put(b,chatX+3,composerTop+2,'█',…)` at the SAME column). Here the rule stops needing
 * emulation and starts holding by construction: the placeholder comes from the renderable's own
 * `placeholder` option and the cursor is the terminal's real cursor, which physically occupies
 * the first cell of the placeholder. `wsGenTyping()` `:270-274`'s "one column past the text once
 * a draft is held" falls out of the same mechanism.
 *
 * `multiline` selects the intrinsic. `<input>` is used for the single-line case rather than a
 * constrained `<textarea>` because `InputRenderable` already enforces height 1, no wrapping, and
 * newline stripping — including from paste. Both expose the same {@link TextEditorHandle}, so no
 * caller ever learns the difference. `runtime/ui/input.tsx` already renders the `<input>`
 * intrinsic for generated pages, so this is an established pattern in the repo.
 */
export function TextEditor(props: TextEditorProps) {
  const sink = sinkFor(props.bridge);
  const onContentChange = (): void => {
    if (sink.current === null) return;
    props.bridge.mirror(sink.current.plainText);
  };

  return (
    <box
      id={props.id}
      flexDirection="row"
      // The caret is one row tall and must stay on the FIRST row of a grown editor, exactly where
      // the design draws it. Yoga's default `stretch` would size it to the whole column.
      alignItems="flex-start"
      height={props.multiline ? props.rows : 1}
    >
      <text id={`${props.id}-caret`} fg={props.caretFg}>
        {props.caret}
      </text>
      {props.multiline ? (
        <textarea
          id={`${props.id}-editor`}
          ref={sink.ref}
          width={props.width}
          height={props.rows}
          // Word wrap with a character-break fallback for a word wider than the viewport
          // (measured, §4.2). Nothing is clipped and nothing overflows horizontally, so URLs and
          // paths need no separate policy.
          wrapMode="word"
          keyBindings={KEY_BINDINGS}
          placeholder={props.placeholder}
          placeholderColor={props.placeholderFg}
          textColor={props.valueFg}
          cursorColor={props.cursorFg}
          focused={props.focused}
          showCursor={props.showCursor}
          onContentChange={onContentChange}
        />
      ) : (
        <input
          id={`${props.id}-editor`}
          ref={sink.ref}
          width={props.width}
          keyBindings={KEY_BINDINGS}
          placeholder={props.placeholder}
          placeholderColor={props.placeholderFg}
          textColor={props.valueFg}
          cursorColor={props.cursorFg}
          focused={props.focused}
          showCursor={props.showCursor}
          onContentChange={onContentChange}
        />
      )}
    </box>
  );
}
