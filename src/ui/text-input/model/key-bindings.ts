import type { KeyBinding } from "@opentui/core";

/**
 * The editor's key table — OUR rows only. `TextareaRenderable` merges them over
 * `defaultTextareaKeyBindings` internally (measured: a two-row custom table leaves `backspace`,
 * the arrows and every other default working), so nothing here needs to restate a default it is
 * happy with. The merge keys on `name:ctrl:shift:meta:super`, which means a row can SHADOW a
 * default but never remove one — the reason for two decisions below.
 *
 * The fallbacks are always bound, never gated on protocol detection, because no reliable
 * detection exists (§9.2): `renderer.useKittyKeyboard` reports what we REQUESTED, not what the
 * terminal implements, and `KeyEvent.source` is an after-the-fact observation. So each affected
 * action carries a primary chord plus a universal fallback and both stay live everywhere.
 */
export const TEXT_EDITOR_KEY_BINDINGS: readonly KeyBinding[] = [
  // ENTER SUBMITS, shadowing the default `return -> newline`. `onSubmit` is deliberately left
  // unwired: the App owns Enter and submits through the existing `composer-submit` path, which
  // carries the accept-then-clear semantics. `submit()` with no listener is a no-op, so if the
  // App ever fails to claim Enter the editor does NOTHING — whereas the default would silently
  // insert a line break instead of sending. A refusal beats a silent wrong action.
  { name: "return", action: "submit" },
  // NUMPAD ENTER NEEDS ITS OWN ROWS. Alias resolution is single-hop and applied to bindings, not
  // to incoming keys: `defaultKeyAliases` has `kpenter -> enter` and `enter -> return`, but the
  // chain is not walked and the lookup uses the incoming key's literal name. Without these the
  // numpad Enter would fall through to the default `newline` and break the line where the main
  // Enter sends.
  { name: "kpenter", action: "submit" },

  // NEWLINE — three routes, two of which need no extended keyboard protocol (§4.4).
  { name: "return", shift: true, action: "newline" },
  { name: "return", meta: true, action: "newline" }, // Alt+Enter; the default here was `submit`
  { name: "linefeed", action: "newline" }, // Ctrl+J; also a default, pinned explicitly
  { name: "kpenter", shift: true, action: "newline" },

  // UNDO/REDO — nothing usable exists in the defaults (§4.5). They bind `super+z` (Cmd+Z, absent
  // on this platform) and `ctrl+-`, which is dead: physical Ctrl+- parses as `name: "_"` and the
  // alias table has no `_ -> -` entry. Undo is unreachable out of the box, so these are required.
  { name: "z", ctrl: true, action: "undo" },
  { name: "z", ctrl: true, shift: true, action: "redo" },
  { name: "y", ctrl: true, action: "redo" },

  // CTRL+A IS REMAPPED, NOT REMOVED, because removal is not expressible through the merge.
  // Mapping it to `select-all` both kills the default `line-home` and gives the behaviour most
  // users expect. `ctrl+e` (`line-end`) stays unreachable: the App claims it globally for export
  // through the action registry — asserted by the dead-binding guard in
  // `ui/app/model/keymap.test.ts`, not assumed. `ctrl+b` (`move-left`) came BACK on 2026-08-10:
  // `page.prev` is `preview`-scoped now, so in the chat zone the key is never looked up in the
  // registry at all and reaches this map unshadowed.
  { name: "a", ctrl: true, action: "select-all" },
];
