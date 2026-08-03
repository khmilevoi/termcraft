/**
 * `ui/text-input`'s contracts: the imperative handle an external write reaches a mounted editor
 * through, the two-way bridge that wires one editor to one mirror atom, and the component props.
 */

/**
 * A mounted editor, reduced to the three operations something outside it actually performs:
 * the one external write, the one synchronous read-back the key layer needs, and the one edit
 * routed through the handle rather than through a key.
 *
 * Nothing speculative, and nothing kept for symmetry. A `clear()`, a `focus()` and a `blur()`
 * lived here until 2026-08-03 and were removed once verified dead in production: the post-accept
 * clear their doc comment named has gone through `setPrimaryInput(deps, "")` -> `setText("")`
 * since this module landed, and focus is a PROP (`TextEditorProps.focused`), driven by the
 * render, never imperatively.
 */
export interface TextEditorHandle {
  /** Replace the whole content, cursor to the end. Used by the F6 repair fill and by seeding. */
  setText(text: string): void;
  /**
   * The editor's current text, read synchronously off its live buffer.
   *
   * Exists for exactly one caller: `App.tsx`'s `onKey`, which must catch the mirror atom up with
   * the buffer BEFORE `resolveKey` reads it. `onContentChange` — the buffer's own downstream
   * projection into the mirror — is delivered through `queueMicrotask` by `@opentui/core`'s
   * native event bus, while every key carried by one stdin chunk is drained synchronously. So
   * without this, a second key in the same chunk sees the previous key's edit still unmirrored.
   */
  text(): string;
  /**
   * Delete the character left of the cursor.
   *
   * This exists to preserve an already-documented escape route. While `homeHealth.kind` is
   * `"blocked"` the Home prompt is non-typeable, `q` quits only while the prompt is EMPTY, and
   * backspace is the only thing that can empty it — `ui/app/model/keymap.ts` records the full
   * reasoning as a fix-round-3 correction. In `blocked` the editor is blurred and receives no
   * keys, so the `home-backspace` intent survives and drives this instead.
   *
   * Unlike {@link setText} this needs no paired mirror write: it mutates the buffer, and the
   * buffer's own content-change listener is registered against the edit buffer rather than
   * against focus, so the mirror updates exactly as it does for a typed key. It is an edit routed
   * through the handle, not an external write.
   */
  deleteCharBackward(): void;
}

/**
 * One editor's two wiring points, in the two directions §5 keeps deliberately separate.
 *
 * Both MUST be stable across renders. `attach` is used as a React ref sink, and a ref whose
 * identity changes is detached and re-attached on every render — which would re-seed the buffer
 * and throw the cursor back to the end while the user is typing. `createUiDeps` builds both once,
 * with `bind`, which satisfies stability and the Reatom context requirement at the same time.
 */
export interface EditorBridge {
  /**
   * Called with the handle when the editor mounts and with `null` when it unmounts. The
   * implementation records the handle AND seeds the buffer from the mirror — the mirror is the
   * seed at mount, the buffer is the truth while mounted (§7.2).
   */
  attach(handle: TextEditorHandle | null): void;
  /** Called with the editor's full text on every buffer change — the downstream projection. */
  mirror(text: string): void;
}

/**
 * Props for {@link TextEditor}.
 *
 * There is deliberately NO text prop. A prop tracking the mirror atom would be re-applied on
 * every keystroke — `InputRenderable.value` is a live setter — moving the cursor to the end
 * mid-edit, and pinning a mount-time seed with `useRef` is not available here (the repo ships no
 * `@types/react`, so importing React's own hooks is a TS7016 error). The seed travels through
 * {@link EditorBridge.attach} instead, which runs exactly once per mount.
 */
export interface TextEditorProps {
  readonly id: string;
  /** The caret run drawn before the editor, e.g. `"❯ "`. Rendered on the first row only. */
  readonly caret: string;
  readonly caretFg: `#${string}`;
  readonly placeholder: string;
  readonly placeholderFg: `#${string}`;
  readonly valueFg: `#${string}`;
  readonly cursorFg: `#${string}`;
  /** `true` renders a growing `<textarea>`; `false` a single-row `<input>`. */
  readonly multiline: boolean;
  /** Visible rows — always 1 when {@link multiline} is false. */
  readonly rows: number;
  /** The editor's own width in cells, EXCLUDING the caret run. */
  readonly width: number;
  /** Whether keys reach this editor at all. */
  readonly focused: boolean;
  /**
   * Whether the terminal cursor is painted. Independent of {@link focused} on purpose (§7.5):
   * a running turn with an empty draft keeps typing live while the design draws no cursor.
   */
  readonly showCursor: boolean;
  /** See {@link EditorBridge} — must be stable across renders. */
  readonly bridge: EditorBridge;
}
