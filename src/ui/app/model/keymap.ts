import { resolveHotkey } from "ui/actions";
import type { HomeAgentHealth } from "ui/home";
import { homeSubmitAllowed } from "ui/home";
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
  /**
   * The one surface that currently owns the keys, ALREADY precedence-resolved (M14 fix). The
   * App builds this with {@link resolveActiveOverlay} from the stored UI-local overlay atom and
   * the export-popup-showing flag — the SAME call `renderOverlay` makes to decide what is drawn
   * on screen — so `resolveKey`'s branches below and the popup the user sees can never disagree.
   * There is no separate `exportPopupOpen` flag: `"export"` is a plain `OverlayKind` member the
   * resolver already folds in only when no stored overlay (`slash-menu`/`chat-list`/`pin-input`)
   * is open.
   */
  readonly overlay: OverlayKind | null;
  readonly composerValue: string;
  /**
   * The current Home agent-health reading (M15, finding §2.7 / phase-8 Task 15). Only
   * meaningful on `screen === "home"`: `"missing"` and `"blocked"` (CORRECTED fix round 1,
   * Finding 6: `"blocked"` used to keep the idle prompt live, which let its own `r` re-check
   * steal a printable character mid-typing) both render a prompt with no PRINTABLE input —
   * `blocked` additionally accepts `backspace` (fix round 3), the one way to clear text typed
   * before the transition; `missing` has no prompt on screen at all, so it accepts neither. Only
   * `r`/`q` (plus, for `blocked`, `backspace`) are live; every other kind (`checking`/`ready`/
   * `advisory`) keeps the idle prompt genuinely live with no extra key —
   * {@link homeSubmitAllowed} alone decides whether Enter submits.
   */
  readonly homeHealth: HomeAgentHealth;
  /**
   * Home's own prompt text (M15). Only read on `screen === "home"`, for two purposes now:
   * guarding `blocked`'s literal `q`-quits key (fix round 2, Minor finding; escape route
   * CORRECTED fix round 3, both below), and — phase-8 Task 17, §3.10 — gating the `/`-opens-
   * the-slash-menu check the same branch also carries, the Home prompt's exact analogue of
   * `composerValue.length === 0` gating `composerActive`'s own `/`-open check below. Reusing this
   * field for that second purpose (rather than adding a same-valued `promptValue` sibling) keeps
   * `KeyContext` from carrying two fields that always hold the identical `deps.local.prompt()`
   * read.
   *
   * The original (fix round 2) doc for the FIRST purpose continues below:
   * `checking` keeps the prompt genuinely live and typeable, so a user can still be typing the
   * instant the health probe resolves to `blocked` mid-keystroke — without this guard, the very
   * next `q` they type (intended as a letter, not a quit gesture) would silently exit the whole
   * app and discard whatever they had typed. Guarding on non-empty `homePrompt` is the same class
   * of fix as the `q`→`/exit` divergence elsewhere: a bare single-letter quit key must never be
   * reachable from what reads, to the user, like ordinary typing.
   *
   * CORRECTED (fix round 3): round 2 justified this guard with "`Ctrl+C`/`SIGINT` remains
   * available regardless" — asserted, not verified, and actually false: `ui/app/model/root.tsx`
   * passes `exitOnCtrlC: false` to `createCliRenderer`, `ui/actions/model/registry.ts` registers
   * no `ctrl+c` hotkey, so an unhandled `ctrl+c` keypress resolves to `{kind:"none"}` here like
   * any other — a quit key that silently does nothing, worse than the trap it replaced. The real
   * escape route is `backspace`, which `blocked`'s own branch below now accepts specifically so
   * a non-empty `homePrompt` is never a dead end: clear it, then `q` exits.
   */
  readonly homePrompt: string;
  /**
   * Whether a `project.create`/`project.open` is already in flight (`ProjectMirror.opening`).
   *
   * Enter is refused while it is. Not a new restriction — the Kernel ALREADY refuses it, because
   * `beginOpen`/`beginCreate` are legal only from the project machine's `closed` phase — but it
   * used to refuse it invisibly: `deriveScreen` keeps Home mounted for the whole (multi-second)
   * open, so the user pressed Enter on a live-looking prompt and the dispatch came back
   * `CAPABILITY_UNAVAILABLE` with nothing on screen to show for it. Refusing here instead lets
   * `Home.tsx` draw the `⏎ create` hint in its `dis` state for the same window, so the refusal
   * is visible BEFORE the key is pressed. The typed text is untouched either way.
   */
  readonly projectOpening: boolean;
  /**
   * Whether a turn is currently `running` (mirror's `TurnMirror.phase`). CORRECTED (finding
   * §2.5, phase-8 Task 16): this used to also gate `composerActive` below, freezing the whole
   * composer — no character, no backspace, no `/` — for the entire duration of a turn. Master
   * §3.2 only refuses *sending*: "Typing the next message while a turn runs is allowed, but
   * sending is disabled." `resolveKey` no longer reads this field at all; the real hazard it
   * used to guard against (a second `turn.start` the Kernel rejects, discarding the draft) is
   * closed at its actual source instead — `applyIntent`'s `composer-submit` no-ops while a turn
   * runs rather than dispatching. The field stays on `KeyContext` because `App.tsx`'s `onKey`
   * still records it in every `trace("ui.onKey", ...)` call, which is genuinely useful context
   * for diagnosing a key resolution captured during a running turn.
   */
  readonly turnRunning: boolean;
}

/**
 * The single precedence rule for "which surface owns the keys / is drawn on top" (fix for the
 * export-popup key-hijack bug): a stored UI-local overlay always outranks an undismissed export
 * result. `App.tsx`'s `renderOverlay` and its key-context builder both call this ONE function —
 * not two independently maintained condition chains that can drift apart — so an export terminal
 * event arriving while another overlay is open can never steal Enter/Esc from it.
 */
export function resolveActiveOverlay(
  overlay: OverlayKind | null,
  exportPopupShowing: boolean,
): OverlayKind | null {
  if (overlay !== null) return overlay;
  return exportPopupShowing ? "export" : null;
}

export type KeyIntent =
  | { readonly kind: "home-input"; readonly ch: string }
  | { readonly kind: "home-backspace" }
  | { readonly kind: "home-submit" }
  | { readonly kind: "home-recheck" }
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
  | { readonly kind: "export-dismiss" }
  | { readonly kind: "esc" }
  | { readonly kind: "tab" }
  | { readonly kind: "exit" }
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

  // The export popup (M14, design/13-export-feedback.dc.html wsExport) is modal. `context.overlay`
  // only ever reads "export" here when `resolveActiveOverlay` found no stored overlay ahead of it
  // (App.tsx), so this branch and every stored-overlay branch below are mutually exclusive by
  // construction — not by two independently ordered checks.
  if (context.overlay === "export") {
    if (key.name === "escape" || RETURN_NAMES.has(key.name)) return { kind: "export-dismiss" };
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

  // §3.2: typing the next message WHILE a turn runs is allowed — only sending is refused. The
  // hazard the old `!context.turnRunning` guarded against (a second `turn.start` the Kernel
  // rejects, discarding the draft) is closed at its real source instead: `applyIntent`'s
  // `composer-submit` no longer clears the composer, and no-ops while a turn runs.
  const composerActive =
    context.screen === "workspace" && context.focus === "composer" && context.overlay === null;

  if (context.screen === "home") {
    // The missing-CLI panel has no prompt input at all, so every key but the two the design's
    // own status bar names is inert there (design `homeErr()` `:727` — CORRECTED fix round 1,
    // Finding 2, was miscited `:583`, a chat-colour branch inside `chatSeq()` unrelated to Home —
    // `this.statusBar(b,h-1,[...],[['r','re-check'],['q','quit']]);`).
    if (context.homeHealth.kind === "missing") {
      if (key.sequence === "r") return { kind: "home-recheck" };
      if (key.sequence === "q") return { kind: "exit" };
      return { kind: "none" };
    }
    // `blocked` dims the SAME shared box `missing` doesn't even draw (design `homeHealth('login')`
    // `:170-173` — no cursor, faint caret). CORRECTED (fix round 1, Finding 6): this branch used
    // to keep accepting typed input despite the prompt reading as disabled, so `r` silently stole
    // a printable character from anything the user typed ("red dashboard" -> re-check + "ed
    // dashboard"). It is now inert to PRINTABLE input like `missing`, matching its own appearance
    // for composition; `q` is safe to bind literally here too (no live typing left to collide
    // with), matching design's own `homeHealth()` hint row (`:194`, which reads literal `q` for
    // BOTH branches) — GUARDED, see `KeyContext.homePrompt`'s own doc comment: `q` exits only
    // once nothing typed is left to lose.
    if (context.homeHealth.kind === "blocked") {
      if (key.sequence === "r") return { kind: "home-recheck" };
      if (key.sequence === "q" && context.homePrompt.length === 0) return { kind: "exit" };
      // CORRECTED (fix round 3): `backspace` is the escape route the `q` guard above needs —
      // without it, a prompt non-empty at the moment `checking` resolved to `blocked` could
      // never be cleared (no printable input, `r` re-check does not touch it, and if the
      // underlying cause persists across re-checks, never resolves on its own either), leaving
      // `q` permanently inert and the user stuck. Backspace is the one edit that can only ever
      // shrink the prompt toward empty, never re-introduce the printable-input-vs-`r`/`q`
      // collision Finding 6 fixed — so it is safe to keep live here alone.
      if (key.name === "backspace") return { kind: "home-backspace" };
      return { kind: "none" };
    }
    // `checking`/`advisory`/`ready` keep a live prompt — design draws a blinking cursor for all
    // three (`:145-146`, `:173`) — so Enter is the only thing ever refused here (finding §2.7),
    // gated purely by `homeSubmitAllowed`. No bare `r`/`q` binding for any of them: both would
    // steal a character from live typing, the exact bug just fixed for `blocked` above.
    if (RETURN_NAMES.has(key.name)) {
      if (context.projectOpening) return { kind: "none" };
      return homeSubmitAllowed(context.homeHealth) ? { kind: "home-submit" } : { kind: "none" };
    }
    if (key.name === "backspace") return { kind: "home-backspace" };
    // §3.10: `/` as the first character of an empty primary input opens the slash menu — the Home
    // prompt is a primary input, exactly like the Workspace composer (`composerActive`'s own `/`
    // check below). The overlay branch above is checked BEFORE the screen branches, so an
    // already-open menu is served by the same code and needs nothing further here. Only reachable
    // from this point in the function at all when `missing`/`blocked` already returned above —
    // §3.10's "the menu is only reachable when the prompt is live" (Task 15's health gate) falls
    // out of that ordering for free, not from a second check on `context.homeHealth` here.
    if (key.sequence === "/" && context.homePrompt.length === 0) return { kind: "slash-open" };
    const ch = printableChar(key);
    if (ch !== null) return { kind: "home-input", ch };
    return { kind: "none" };
  }

  // The too-small-terminal takeover (design `termSmall()`, `design/termcraft-engine.js:610-615`)
  // has no input of any kind — it is four centered lines of static text, no chrome, no status
  // bar. `q` quits (phase-8 WP-10) because there is nothing here to type into, matching the
  // agent-missing panel's identical reasoning above. NOTE ON THE CITED LINE: the WP-10 design
  // (`docs/superpowers/specs/2026-07-25-mvp-phase-8-design.md`) cites `:622` for this screen's
  // `q quit`, but reading the engine source shows `:622` is inside a DIFFERENT function,
  // `lockScreen()` (the already-running-instance lock screen, `:617-623`) — `termSmall()` itself
  // (`:610-615`) draws no key hint at all, and `lockScreen()` has no corresponding `ScreenKind`
  // in this codebase to attach a branch to. This still implements the design SPEC's own explicit,
  // dated decision ("q quit is implemented ... at ... the too-small-terminal screen") for the
  // screen that spec's prose actually names — just noting the mismatched line citation, not
  // inventing a new affordance the design never asked for.
  if (context.screen === "enlarge") {
    if (key.sequence === "q") return { kind: "exit" };
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
