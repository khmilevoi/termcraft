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
  | "history";

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
  /** A non-composer text input, or the preview focused in interactive mode, holds focus (layer 2). */
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
 */
export function resolveEsc(state: EscState): EscOutcome {
  if (state.overlayOpen !== null) return { kind: "close-overlay", overlay: state.overlayOpen };
  if (state.focusAwayFromComposer) return { kind: "unfocus-to-composer" };
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
 * Whether single-character keys (`v`, arrow navigation, `r`) are live. Per §3.8 they work
 * only when no text input is focused — i.e. focus is on the preview and no overlay is open.
 * Global keys (F2/F3/F4, Ctrl+E, Ctrl+P) are unaffected and handled separately.
 */
export function singleCharKeysActive(focus: FocusTarget, overlayOpen: OverlayKind | null): boolean {
  return focus === "preview" && overlayOpen === null;
}
