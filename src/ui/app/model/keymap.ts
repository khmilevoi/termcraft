import type { ScreenKind } from "ui/mirror";
import type { FocusTarget } from "ui/workspace";

/**
 * Keyboard → intent mapping (design §3.8 hotkey tiers). Pure and testable in isolation: the
 * App wraps a single `useKeyboard` handler that runs this and applies the returned intent
 * (touching UI-local atoms or dispatching a command). Keeping the decision here — not inside
 * the wrapped handler — is what lets the whole key table be unit-tested without a renderer.
 */

/** The minimal key-event shape this resolver reads (a subset of OpenTUI's `KeyEvent`). */
export interface KeyLike {
  readonly name: string;
  readonly ctrl: boolean;
  readonly sequence: string;
}

/** The screen/focus/overlay context a key is resolved against. */
export interface KeyContext {
  readonly screen: ScreenKind;
  readonly focus: FocusTarget;
  readonly overlayOpen: boolean;
}

export type KeyIntent =
  | { readonly kind: "home-input"; readonly ch: string }
  | { readonly kind: "home-backspace" }
  | { readonly kind: "home-submit" }
  | { readonly kind: "composer-input"; readonly ch: string }
  | { readonly kind: "composer-backspace" }
  | { readonly kind: "composer-submit" }
  | { readonly kind: "esc" }
  | { readonly kind: "tab" }
  | { readonly kind: "fullscreen" }
  | { readonly kind: "export" }
  | { readonly kind: "none" };

/** A single printable character (no modifier, not a control byte). */
function printableChar(key: KeyLike): string | null {
  if (key.ctrl) return null;
  if (key.sequence.length !== 1) return null;
  const code = key.sequence.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return null;
  return key.sequence;
}

const RETURN_NAMES: ReadonlySet<string> = new Set(["return", "enter"]);

/** Resolves one key event into a UI intent, given the current screen/focus/overlay context. */
export function resolveKey(key: KeyLike, context: KeyContext): KeyIntent {
  // Global keys work regardless of focus (design §3.8 "Global" tier).
  if (key.name === "escape") return { kind: "esc" };
  if (key.name === "f2") return { kind: "fullscreen" };
  if (key.ctrl && key.name === "e") return { kind: "export" };

  const composerActive =
    (context.screen === "workspace" || context.screen === "read-only") &&
    context.focus === "composer" &&
    !context.overlayOpen;

  if (context.screen === "home") {
    if (RETURN_NAMES.has(key.name)) return { kind: "home-submit" };
    if (key.name === "backspace") return { kind: "home-backspace" };
    const ch = printableChar(key);
    if (ch !== null) return { kind: "home-input", ch };
    return { kind: "none" };
  }

  // Tab cycles focus in the workspace (not while a text input's own Tab is needed — MVP has none).
  if (key.name === "tab" && !context.overlayOpen) return { kind: "tab" };

  if (composerActive) {
    if (RETURN_NAMES.has(key.name)) return { kind: "composer-submit" };
    if (key.name === "backspace") return { kind: "composer-backspace" };
    const ch = printableChar(key);
    if (ch !== null) return { kind: "composer-input", ch };
  }

  return { kind: "none" };
}
