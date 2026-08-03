import { type Atom, bind } from "@reatom/core";

import { trace } from "infrastructure/debug-log";
import { filterSlashRows } from "ui/actions";
import type { EditorBridge, TextEditorHandle } from "ui/text-input";

import type { UiDeps } from "./deps";

/**
 * The two directions §5 keeps deliberately un-interchangeable.
 *
 * `mirrorPrimaryInput` runs DOWNSTREAM — the editor changed, project it into the atom.
 * `setPrimaryInput` runs UPSTREAM — something outside the editor decided the text, put it into
 * both. Editing flows one way only, buffer to mirror; external writes are the one bidirectional
 * point and they write both sides from a single call site, which is what closes the unmount race
 * (§7.2): the composer can unmount between `turn.start` and its accepted continuation, and a
 * clear that reached only the handle would leave the mirror holding the sent text for a later
 * remount to seed from.
 *
 * "Primary input" keeps the meaning `intent.ts` already gives it: the Home prompt on `home`, the
 * Workspace composer everywhere else. The pin popup is not a primary input — it owns its own
 * `pinDraft`/`pinEditor` pair.
 */

/** The mirror atom for the current screen's primary input. Selects between two atoms; never creates one. */
export function primaryInputAtom(deps: UiDeps): Atom<string> {
  return deps.screen() === "home" ? deps.local.prompt : deps.local.composer;
}

/** The handle atom for the current screen's primary input. */
export function primaryEditorAtom(deps: UiDeps): Atom<TextEditorHandle | null> {
  return deps.screen() === "home" ? deps.local.promptEditor : deps.local.composerEditor;
}

/**
 * Synchronously catches every mounted editor's mirror atom up with its own live buffer.
 *
 * `onContentChange` — the downstream projection {@link mirrorPrimaryInput} implements — is
 * delivered through `queueMicrotask` by `@opentui/core`'s native event bus, but a stdin chunk
 * carrying more than one key is drained synchronously in a single pass (`CliRenderer
 * .stdinListener` -> `StdinParser.drain`'s `while` loop). So a second key in the same chunk (fast
 * typing, key-repeat, an SSH/tmux-coalesced burst) would otherwise be resolved against the
 * PREVIOUS key's pre-edit mirror value: typing `"abc/"` in one chunk resolved `slash-open`
 * (`keymap.ts` read `composerValue` as still empty) and `setPrimaryInput(deps, "/")` then
 * destroyed the `"abc"`; an `Enter` in the same chunk as its own text was refused as an empty
 * composer.
 *
 * `App.tsx`'s `onKey` calls this before building `resolveKey`'s context and before `applyIntent`
 * reads any mirror atom, which closes the gap for every surface rather than just whichever
 * happens to be focused — the cost of checking an unmounted or already-current editor is one
 * atom read.
 *
 * Writes each atom DIRECTLY, not through {@link mirrorPrimaryInput}: this flush's only job is
 * making the mirror accurate for THIS key's synchronous reads. The buffer's own
 * `onContentChange` call is still scheduled on that edit's microtask and still runs afterwards,
 * still carrying the slash-menu-closing checks — duplicating those here would only risk running
 * them twice.
 */
export function flushEditors(deps: UiDeps): void {
  flushEditor(deps.local.composerEditor, deps.local.composer);
  flushEditor(deps.local.promptEditor, deps.local.prompt);
  flushEditor(deps.local.pinEditor, deps.local.pinDraft);
}

function flushEditor(handleAtom: Atom<TextEditorHandle | null>, mirrorAtom: Atom<string>): void {
  const handle = handleAtom();
  // No trace here, unlike `withEditor` below: an unmounted editor is the ORDINARY case for two of
  // the three surfaces on every keystroke, so reporting it would bury the diagnostics that matter.
  if (handle === null) return;
  const live = handle.text();
  if (live !== mirrorAtom()) mirrorAtom.set(live);
}

/**
 * Applies `apply` to a mounted editor, or records that there was none.
 *
 * The atom always exists; the handle does not — the component may be unmounted, or belong to
 * another screen. A silent return is not acceptable here: this codebase has already paid for one,
 * when `dispatchAndReport` swallowed Kernel refusals and the fix was to add exactly this kind of
 * trace (§9.1).
 */
function withEditor(
  handleAtom: Atom<TextEditorHandle | null>,
  reason: string,
  apply: (handle: TextEditorHandle) => void,
): void {
  const handle = handleAtom();
  if (handle === null) {
    trace("ui.editor.missing", { intent: reason });
    return;
  }
  apply(handle);
}

/** UPSTREAM: something outside the editor decided the text. Writes the atom ALWAYS, the handle when one exists. */
export function setPrimaryInput(deps: UiDeps, text: string): void {
  primaryInputAtom(deps).set(text);
  withEditor(primaryEditorAtom(deps), "setPrimaryInput", (handle) => handle.setText(text));
}

/** UPSTREAM, for the pin popup's own draft. */
export function setPinInput(deps: UiDeps, text: string): void {
  deps.local.pinDraft.set(text);
  withEditor(deps.local.pinEditor, "setPinInput", (handle) => handle.setText(text));
}

/** Deletes the character behind the cursor in the current primary input, through its handle. */
export function deletePrimaryInputChar(deps: UiDeps): void {
  withEditor(primaryEditorAtom(deps), "home-backspace", (handle) => handle.deleteCharBackward());
}

/**
 * DOWNSTREAM: the editor's buffer changed, project it into the mirror.
 *
 * The slash menu's closing rule lives here rather than in a key handler, because the editor now
 * does the editing and this is the one place that sees every edit. Three cases close it: the
 * filter erased to empty, the leading `/` itself deleted (newly reachable, now that the cursor
 * can move into the string), and a filter that matches no row. Leaving the menu open over text
 * with no leading slash would recreate exactly the invisible dead end `intent.ts` already fixed
 * once — a menu with no rows draws as nothing, so the user presses Enter into silence (§7.3).
 */
export function mirrorPrimaryInput(deps: UiDeps, text: string): void {
  primaryInputAtom(deps).set(text);
  if (deps.local.overlay() !== "slash-menu") return;
  const screen = deps.screen();
  if (screen !== "workspace" && screen !== "home") return;
  if (!text.startsWith("/")) {
    deps.local.overlay.set(null);
    return;
  }
  if (filterSlashRows(text, deps.actionContext()).length === 0) deps.local.overlay.set(null);
}

/**
 * Builds one editor's bridge.
 *
 * `bind` (RTM-A06) because both halves are callbacks invoked later from outside Reatom — the
 * renderable's content-change listener and React's ref sink — and both write atoms. Binding here,
 * once, is also what gives them the stable identity `TextEditor`'s ref sink requires.
 */
export function createEditorBridge(input: {
  readonly handleAtom: Atom<TextEditorHandle | null>;
  readonly readSeed: () => string;
  readonly mirror: (text: string) => void;
}): EditorBridge {
  return {
    attach: bind((handle: TextEditorHandle | null) => {
      input.handleAtom.set(handle);
      // The mirror is the seed at mount; the buffer is the truth while mounted (§7.2). Seeding
      // here rather than through a prop is what keeps a re-render from snapping the cursor to the
      // end of the text mid-edit.
      if (handle !== null) handle.setText(input.readSeed());
    }),
    mirror: bind(input.mirror),
  };
}
