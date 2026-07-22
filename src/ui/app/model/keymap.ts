import { resolveHotkey } from "ui/actions";
import type { ScreenKind } from "ui/mirror";
import type { FocusTarget, OverlayKind } from "ui/workspace";

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
  readonly overlay: OverlayKind | null;
  readonly composerValue: string;
}

export type KeyIntent =
  | { readonly kind: "home-input"; readonly ch: string }
  | { readonly kind: "home-backspace" }
  | { readonly kind: "home-submit" }
  | { readonly kind: "composer-input"; readonly ch: string }
  | { readonly kind: "composer-backspace" }
  | { readonly kind: "composer-submit" }
  | { readonly kind: "action-execute"; readonly actionId: string }
  | { readonly kind: "slash-open" }
  | { readonly kind: "slash-input"; readonly ch: string }
  | { readonly kind: "slash-backspace" }
  | { readonly kind: "slash-move"; readonly delta: -1 | 1 }
  | { readonly kind: "slash-submit" }
  | { readonly kind: "chat-move"; readonly delta: -1 | 1 }
  | { readonly kind: "chat-switch" }
  | { readonly kind: "pin-input"; readonly ch: string }
  | { readonly kind: "pin-backspace" }
  | { readonly kind: "pin-save" }
  | { readonly kind: "trust-accept" }
  | { readonly kind: "trust-decline" }
  | { readonly kind: "overlay-dismiss" }
  | { readonly kind: "esc" }
  | { readonly kind: "tab" }
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

function hotkeyName(key: KeyLike): string {
  if (key.ctrl) return `ctrl+${key.name.toLowerCase()}`;
  return key.name.toLowerCase();
}

/** Resolves one key event into a UI intent, given the current screen/focus/overlay context. */
export function resolveKey(key: KeyLike, context: KeyContext): KeyIntent {
  if (context.screen === "trust-prompt") {
    if (RETURN_NAMES.has(key.name)) return { kind: "trust-accept" };
    if (key.name === "escape") return { kind: "trust-decline" };
    return { kind: "none" };
  }

  if (context.screen === "read-only" && context.overlay === "slash-menu") {
    if (key.name === "escape") return { kind: "overlay-dismiss" };
    return { kind: "none" };
  }

  if (context.overlay === "slash-menu") {
    if (key.name === "escape") return { kind: "overlay-dismiss" };
    if (RETURN_NAMES.has(key.name)) return { kind: "slash-submit" };
    if (key.name === "up") return { kind: "slash-move", delta: -1 };
    if (key.name === "down") return { kind: "slash-move", delta: 1 };
    if (key.name === "backspace") return { kind: "slash-backspace" };
    const ch = printableChar(key);
    if (ch !== null) return { kind: "slash-input", ch };
    return { kind: "none" };
  }

  if (context.overlay === "chat-list") {
    if (key.name === "escape") return { kind: "overlay-dismiss" };
    if (RETURN_NAMES.has(key.name)) return { kind: "chat-switch" };
    if (key.name === "up") return { kind: "chat-move", delta: -1 };
    if (key.name === "down") return { kind: "chat-move", delta: 1 };
    return { kind: "none" };
  }

  if (context.overlay === "pin-input") {
    if (key.name === "escape") return { kind: "overlay-dismiss" };
    if (context.screen === "read-only") return { kind: "none" };
    if (RETURN_NAMES.has(key.name)) return { kind: "pin-save" };
    if (key.name === "backspace") return { kind: "pin-backspace" };
    const ch = printableChar(key);
    if (ch !== null) return { kind: "pin-input", ch };
    return { kind: "none" };
  }

  if (context.overlay !== null) {
    if (key.name === "escape") return { kind: "overlay-dismiss" };
    return { kind: "none" };
  }

  // Global keys resolve through the one action registry regardless of focus.
  if (key.name === "escape") return { kind: "esc" };
  const hotkey = resolveHotkey(hotkeyName(key));
  if (hotkey?.inert === true) return { kind: "none" };
  if (hotkey !== null) return { kind: "action-execute", actionId: hotkey.id };

  const composerActive =
    context.screen === "workspace" && context.focus === "composer" && context.overlay === null;

  if (context.screen === "home") {
    if (RETURN_NAMES.has(key.name)) return { kind: "home-submit" };
    if (key.name === "backspace") return { kind: "home-backspace" };
    const ch = printableChar(key);
    if (ch !== null) return { kind: "home-input", ch };
    return { kind: "none" };
  }

  // Tab cycles focus in the workspace (not while a text input's own Tab is needed — MVP has none).
  if (key.name === "tab" && context.overlay === null) return { kind: "tab" };

  if (composerActive) {
    if (key.sequence === "/" && context.composerValue.length === 0) return { kind: "slash-open" };
    if (RETURN_NAMES.has(key.name)) return { kind: "composer-submit" };
    if (key.name === "backspace") return { kind: "composer-backspace" };
    const ch = printableChar(key);
    if (ch !== null) return { kind: "composer-input", ch };
  }

  return { kind: "none" };
}
