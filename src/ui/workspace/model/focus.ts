/**
 * Focus and the layered `Esc` stack (design §3.8, phase-7 plan GAP decision on focus).
 *
 * OpenTUI exposes no `tabIndex`, so focus is driven declaratively: exactly one widget owns
 * focus (`FocusTarget`), `Tab` toggles chat <-> preview, and a single global `Esc`
 * handler pops the topmost active layer. This file is the pure logic; the App drives it via
 * a `focusTargetAtom` mapped to the React `focused` prop and a `useKeyboard` handler.
 */

/** The overlays that can sit above the workspace and swallow the first `Esc`. */
export type OverlayKind =
  | "slash-menu"
  | "chat-list"
  | "pin-input"
  | "export"
  | "trust"
  | "tab-menu"
  | "history"
  | "design-system";

/**
 * The single widget that owns focus in the workspace.
 *
 * `"chat"` NAMES A ZONE, NOT A WIDGET (focus-scoped-hotkeys §11). It was `"composer"` until
 * click-to-focus made that name false: a click on the scrollback or the pin list sets this same
 * value, and neither is the composer. The composer is simply the one thing INSIDE the zone that
 * takes a caret, which is why `Workspace.tsx` still derives the editor's own `focused` prop from
 * this value rather than from a second piece of state.
 */
export type FocusTarget = "chat" | "preview";

/** The live UI state one `Esc` press is resolved against (design §3.8's five layers). */
export interface EscState {
  /** An open popup or the slash menu (layer 1), or `null`. */
  readonly overlayOpen: OverlayKind | null;
  /**
   * A non-composer text input, or the preview focused in interactive mode, holds focus (layer 2).
   *
   * CORRECTED (final-review Finding 1, focus-scoped-hotkeys, 2026-08-10): this used to name only a
   * deliberate `Tab` gesture. Since Task 5 of this same plan, `Workspace.tsx` ALSO sets `local.focus`
   * to `"preview"` as a side effect of an ordinary click that selects an element or hits a page tab —
   * so this field no longer implies "the user explicitly asked to leave the composer." See
   * {@link resolveEsc}'s own doc comment for how layer 2 now accounts for that.
   */
  readonly focusAwayFromComposer: boolean;
  /** A historical browse view is active (layer 3). */
  readonly historicalBrowse: boolean;
  /** A generation is running (layer 4). */
  readonly generationRunning: boolean;
  /** An element is selected (layer 5). */
  readonly hasSelection: boolean;
}

/** What one `Esc` press does — exactly one layer pops per press (design §3.8). */
export type EscOutcome =
  | { readonly kind: "close-overlay"; readonly overlay: OverlayKind }
  | { readonly kind: "unfocus-to-composer" }
  | { readonly kind: "leave-history" }
  | { readonly kind: "cancel-generation" }
  | { readonly kind: "deselect" }
  | { readonly kind: "none" };

/**
 * Resolves one `Esc` press against the layered priority stack (design §3.8, exact order):
 * 1 open popup / slash menu -> close it; 2 non-composer input or interactive preview ->
 * unfocus to composer; 3 historical browse -> return to Current; 4 running generation ->
 * cancel; 5 selected element -> deselect. Pure and total — `"none"` when no layer is active.
 *
 * CORRECTED (final-review Finding 1, focus-scoped-hotkeys, 2026-08-10): layer 2 no longer wins
 * outright. Before this branch, `focus` only ever changed via a deliberate `Tab`, so "focus away
 * from chat" reliably meant "the user explicitly asked to leave the composer, and `Esc` should
 * bring them back." Since Task 5, `Workspace.tsx` also sets `local.focus` to `"preview"` as a mere
 * SIDE EFFECT of a click that selects an element or hits a page tab — so a click that both selects
 * something and moves focus made the first `Esc` after it return focus to chat instead of
 * deselecting, and a click into the preview while a turn ran made it swallow "esc cancel" instead
 * of cancelling. Layer 2 now yields to a more urgent reason to be there: while a generation is
 * running or a selection is active, `Esc` addresses THAT first, falling through to layer 4/5 as if
 * focus were still on chat. A plain `Tab`-away with nothing else active is unaffected — layer 2
 * still wins there, exactly as before.
 */
export function resolveEsc(state: EscState): EscOutcome {
  if (state.overlayOpen !== null) return { kind: "close-overlay", overlay: state.overlayOpen };
  if (state.focusAwayFromComposer && !state.generationRunning && !state.hasSelection)
    return { kind: "unfocus-to-composer" };
  if (state.historicalBrowse) return { kind: "leave-history" };
  if (state.generationRunning) return { kind: "cancel-generation" };
  if (state.hasSelection) return { kind: "deselect" };
  return { kind: "none" };
}

/** `Tab` toggles focus between the chat zone and the preview (design §3.8). */
export function nextFocus(current: FocusTarget): FocusTarget {
  return current === "chat" ? "preview" : "chat";
}

/**
 * The zone a key is resolved against (focus-scoped-hotkeys §4). DERIVED, never stored.
 *
 * Deriving it is what keeps it honest: in fullscreen the chat pane is not rendered at all
 * (`ui/workspace/ui/Workspace.tsx`'s `!fullscreen &&` guard) and the preview border is already
 * painted amber for that case, so a stored zone could disagree with the drawn one. A derived zone
 * cannot.
 *
 * REPLACES `singleCharKeysActive`, deleted here. That helper expressed design §3.8's second hotkey
 * tier — "`v`, arrows and `r` work only when no text input is focused" — and was never called from
 * anywhere in `src/`. The tier it described IS the `preview` scope: the helper was the concept
 * without a mechanism, and the scope is the mechanism.
 */
export function effectiveZone(focus: FocusTarget, fullscreen: boolean): FocusTarget {
  return fullscreen ? "preview" : focus;
}
