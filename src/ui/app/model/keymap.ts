import { resolveHotkey } from "ui/actions";
import type { AgentHealth } from "ui/agent-health";
import { homeSubmitAllowed } from "ui/home";
import type { ScreenKind } from "ui/mirror";
import type { DesignSystemPromptKind } from "ui/popups";
import { effectiveZone } from "ui/workspace";
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
  /**
   * Read so a MODIFIED Enter is never claimed as a submit: `Shift+Enter` and `Alt+Enter` are the
   * editor's newline chords (§4.4), and claiming them here would make the composer un-breakable
   * on every terminal.
   */
  readonly shift: boolean;
  readonly meta: boolean;
  readonly sequence: string;
}

/** The screen/focus/overlay context a key is resolved against. */
export interface KeyContext {
  readonly screen: ScreenKind;
  readonly focus: FocusTarget;
  /**
   * Whether the preview is fullscreen (`ui.local.fullscreen`, the F2 toggle).
   *
   * Read for exactly two decisions, both in §4: the effective zone is forced to `preview` while it
   * is true (the chat pane is not rendered, so no key may act on it), and `Tab` becomes an
   * unclaimed no-op (there is no second pane to reach). It is NOT a third focus state — the stored
   * `focus` is untouched by F2, so leaving fullscreen restores whatever zone the user was in.
   */
  readonly fullscreen: boolean;
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
  readonly agentHealth: AgentHealth;
  /**
   * Home's own prompt text (M15). Only read on `screen === "home"`, for two purposes now:
   * guarding `blocked`'s literal `q`-quits key (fix round 2, Minor finding; escape route
   * CORRECTED fix round 3, both below), and — phase-8 Task 17, §3.10 — gating the `/`-opens-
   * the-slash-menu check the same branch also carries, the Home prompt's exact analogue of
   * `composerValue.length === 0` gating the chat zone's own `/`-open check below. Reusing this
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
   * §2.5, phase-8 Task 16): this used to also gate the chat-zone inline-key branch below (`zone
   * === "chat" && context.screen === "workspace"`, then still a local `composerActive` const),
   * freezing the whole composer — no character, no backspace, no `/` — for the entire duration
   * of a turn. Master §3.2 only refuses *sending*: "Typing the next message while a turn runs
   * is allowed, but sending is disabled." `resolveKey` no longer reads this field at all; the
   * real hazard it used to guard against (a second `turn.start` the Kernel rejects, discarding
   * the draft) is closed at its actual source instead — `applyIntent`'s `composer-submit` no-ops
   * while a turn runs rather than dispatching. The field stays on `KeyContext` because
   * `App.tsx`'s `onKey` still records it in every `trace("ui.onKey", ...)` call, which is
   * genuinely useful context for diagnosing a key resolution captured during a running turn.
   */
  readonly turnRunning: boolean;
  /**
   * Whether a project is actually open (`ProjectMirror.projectId !== null`). FALSE in the
   * Workspace's opening state (spec 2026-08-02), where the composer is deliberately live and
   * typeable but ⏎ is refused — the Kernel would reject a `turn.start` before the project is
   * ready anyway, and refusing here is what lets the key row draw `⏎ send` in its `dis` state so
   * the refusal is visible BEFORE the key is pressed. The same shape `projectOpening` already
   * gives Home's own Enter; a separate field because that one reads
   * `ProjectMirror.opening`, which is still false between UI mount and command admission.
   */
  readonly projectOpen: boolean;
  /**
   * The design-system overlay's own sub-state (P10 task 13, `UiLocalState.designSystemPrompt`):
   * `null` while the picker itself is showing, `"install"`/`"publish"` while its breakage-preview
   * / publish-confirm dialog covers it. Read for exactly one decision: `p` publishes only from the
   * picker (§8.5's row action), never from a confirmation already asking about something else —
   * the same "only reachable from the surface it belongs to" discipline `overlay` itself enforces.
   */
  readonly designSystemPrompt: DesignSystemPromptKind | null;
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
  | {
      /**
       * The ONE surviving editing intent (§6.1/§6.4). While `agentHealth.kind === "blocked"` the
       * Home prompt is blurred and receives no keys, so backspace cannot reach the editor — and
       * backspace is the only thing that can empty a prompt whose `q` quit is gated on emptiness.
       */
      readonly kind: "home-backspace";
    }
  | { readonly kind: "home-submit" }
  | { readonly kind: "home-recheck" }
  | { readonly kind: "composer-submit" }
  | { readonly kind: "action-execute"; readonly actionId: string }
  | { readonly kind: "slash-open" }
  | { readonly kind: "slash-move"; readonly delta: -1 | 1 }
  | { readonly kind: "slash-submit" }
  | { readonly kind: "chat-move"; readonly delta: -1 | 1 }
  | { readonly kind: "chat-switch" }
  | { readonly kind: "pin-save" }
  | { readonly kind: "trust-accept" }
  | { readonly kind: "trust-decline" }
  | { readonly kind: "overlay-dismiss" }
  | { readonly kind: "export-dismiss" }
  | { readonly kind: "design-system-move"; readonly delta: -1 | 1 }
  | { readonly kind: "design-system-activate" }
  | { readonly kind: "design-system-publish" }
  | { readonly kind: "esc" }
  | { readonly kind: "tab" }
  | { readonly kind: "exit" }
  | { readonly kind: "none" };

/** Every name a terminal reports for the Enter key, main row or numpad. */
const RETURN_NAMES: ReadonlySet<string> = new Set(["return", "enter", "kpenter"]);

/**
 * An UNMODIFIED Enter — the only one the App claims.
 *
 * `Shift+Enter`, `Alt+Enter` and `Ctrl+J` are the editor's three newline routes (§4.4), so they
 * must fall through. `Ctrl+J` needs no check here at all: it parses as `linefeed`, a different
 * name entirely.
 */
function isSubmitKey(key: KeyLike): boolean {
  return RETURN_NAMES.has(key.name) && !key.shift && !key.meta && !key.ctrl;
}

/**
 * THE CLAIM RULE (§6.4), and the reason there is no second list of "keys the App owns" — a second
 * list would drift from the first.
 *
 * > The App calls `preventDefault()` if and only if `resolveKey` returned an intent other than
 * > `none`.
 *
 * This holds because seven of the eight editing intent kinds have left {@link KeyIntent}. What
 * remains in the union is, by definition, what the App governs: `Esc`, `Tab`, the F-keys, the
 * registry hotkeys, an unmodified `Enter`, `/` on an empty primary input, and the arrows while
 * the slash menu is open. Everything else resolves to `none` and reaches the focused editor.
 *
 * A welcome consequence: with the menu open, `↑`/`↓` drive the row selection while `←`/`→`,
 * `Ctrl+←`/`Ctrl+→` and `Ctrl+W` reach the editor, so the filter is editable with the same full
 * set as ordinary text — which it was not before.
 */
export function isClaimedKey(intent: KeyIntent): boolean {
  return intent.kind !== "none";
}

function hotkeyName(key: KeyLike): string {
  if (key.ctrl) return `ctrl+${key.name.toLowerCase()}`;
  return key.name.toLowerCase();
}

/** Resolves one key event into a UI intent, given the current screen/focus/overlay context. */
export function resolveKey(key: KeyLike, context: KeyContext): KeyIntent {
  if (context.screen === "trust-prompt") {
    if (isSubmitKey(key)) return { kind: "trust-accept" };
    if (key.name === "escape") return { kind: "trust-decline" };
    return { kind: "none" };
  }

  // The export popup (M14, design/13-export-feedback.dc.html wsExport) is modal. `context.overlay`
  // only ever reads "export" here when `resolveActiveOverlay` found no stored overlay ahead of it
  // (App.tsx), so this branch and every stored-overlay branch below are mutually exclusive by
  // construction — not by two independently ordered checks.
  if (context.overlay === "export") {
    if (key.name === "escape" || isSubmitKey(key)) return { kind: "export-dismiss" };
    return { kind: "none" };
  }

  if (context.screen === "read-only" && context.overlay === "slash-menu") {
    if (key.name === "escape") return { kind: "overlay-dismiss" };
    return { kind: "none" };
  }

  if (context.overlay === "slash-menu") {
    if (key.name === "escape") return { kind: "overlay-dismiss" };
    if (isSubmitKey(key)) return { kind: "slash-submit" };
    if (key.name === "up" && !key.ctrl) return { kind: "slash-move", delta: -1 };
    if (key.name === "down" && !key.ctrl) return { kind: "slash-move", delta: 1 };
    // Everything else — printables, Backspace, ←/→, Ctrl+←/→, Ctrl+W — reaches the editor, which
    // IS the filter's buffer. The closing rule moved to `mirrorPrimaryInput` (§7.3).
    return { kind: "none" };
  }

  if (context.overlay === "chat-list") {
    if (key.name === "escape") return { kind: "overlay-dismiss" };
    if (isSubmitKey(key)) return { kind: "chat-switch" };
    if (key.name === "up") return { kind: "chat-move", delta: -1 };
    if (key.name === "down") return { kind: "chat-move", delta: 1 };
    return { kind: "none" };
  }

  if (context.overlay === "pin-input") {
    if (key.name === "escape") return { kind: "overlay-dismiss" };
    // On a read-only screen the pin editor is never focused, so nothing reaches it either way —
    // this keeps the refusal explicit at the key layer as well.
    if (context.screen === "read-only") return { kind: "none" };
    if (isSubmitKey(key)) return { kind: "pin-save" };
    return { kind: "none" };
  }

  if (context.overlay === "design-system") {
    if (key.name === "escape") return { kind: "overlay-dismiss" };
    if (key.name === "up") return { kind: "design-system-move", delta: -1 };
    if (key.name === "down") return { kind: "design-system-move", delta: 1 };
    if (isSubmitKey(key)) return { kind: "design-system-activate" };
    // §8.5's own row action, and ONLY from the picker itself — a confirmation dialog already
    // covering the screen (`designSystemPrompt !== null`) asks about something else entirely, so
    // `p` must not be read as "publish" while it is up (KeyContext.designSystemPrompt's own doc).
    if (key.sequence === "p" && context.designSystemPrompt === null) {
      return { kind: "design-system-publish" };
    }
    return { kind: "none" };
  }

  if (context.overlay !== null) {
    if (key.name === "escape") return { kind: "overlay-dismiss" };
    return { kind: "none" };
  }

  // Global keys resolve through the one action registry regardless of focus — F-keys, `Ctrl+E`,
  // `Ctrl+P`: everything that cannot collide with typing. Asked for `global` explicitly, so a
  // zone-scoped row can never be reached from here (see `resolveHotkey`'s own doc comment).
  if (key.name === "escape") return { kind: "esc" };
  const pressed = hotkeyName(key);
  const global = resolveHotkey(pressed, "global");
  if (global?.inert === true) return { kind: "none" };
  if (global !== null) return { kind: "action-execute", actionId: global.id };

  if (context.screen === "home") {
    // The missing-CLI panel has no prompt input at all, so every key but the two the design's
    // own status bar names is inert there (design `homeErr()` `:727` — CORRECTED fix round 1,
    // Finding 2, was miscited `:583`, a chat-colour branch inside `chatSeq()` unrelated to Home —
    // `this.statusBar(b,h-1,[...],[['r','re-check'],['q','quit']]);`).
    if (context.agentHealth.kind === "missing") {
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
    if (context.agentHealth.kind === "blocked") {
      if (key.sequence === "r") return { kind: "home-recheck" };
      if (key.sequence === "q" && context.homePrompt.length === 0) return { kind: "exit" };
      // The escape route the `q` guard needs (fix round 3). The prompt is blurred here, so this
      // intent is the ONLY thing that can shrink it toward empty — see `TextEditorHandle
      // .deleteCharBackward`'s own doc comment for the other half of the arrangement.
      if (key.name === "backspace") return { kind: "home-backspace" };
      return { kind: "none" };
    }
    // `checking`/`advisory`/`ready` keep a live prompt — design draws a blinking cursor for all
    // three (`:145-146`, `:173`) — so Enter is the only thing ever refused here (finding §2.7),
    // gated purely by `homeSubmitAllowed`. No bare `r`/`q` binding for any of them: both would
    // steal a character from live typing, the exact bug just fixed for `blocked` above.
    if (isSubmitKey(key)) {
      if (context.projectOpening) return { kind: "none" };
      return homeSubmitAllowed(context.agentHealth) ? { kind: "home-submit" } : { kind: "none" };
    }
    // §3.10: `/` as the first character of an empty primary input opens the slash menu — the Home
    // prompt is a primary input, exactly like the Workspace composer (the chat zone's own `/`
    // check below). The overlay branch above is checked BEFORE the screen branches, so an
    // already-open menu is served by the same code and needs nothing further here. Only reachable
    // from this point in the function at all when `missing`/`blocked` already returned above —
    // §3.10's "the menu is only reachable when the prompt is live" (Task 15's health gate) falls
    // out of that ordering for free, not from a second check on `context.agentHealth` here.
    if (key.sequence === "/" && context.homePrompt.length === 0) return { kind: "slash-open" };
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

  // Tab cycles focus in the workspace. A NO-OP WHILE FULLSCREEN (§4): the chat pane is not
  // rendered, so there is no second pane to reach. Returning `none` rather than swallowing the key
  // is deliberate — the App calls `preventDefault()` iff the intent is not `none`, so this falls
  // through like any unclaimed key instead of silently toggling a zone the user cannot see.
  if (key.name === "tab" && context.overlay === null) {
    return context.fullscreen ? { kind: "none" } : { kind: "tab" };
  }

  // ZONE-SCOPED KEYS (§4). Strictness is the load-bearing part: a key whose scope is not the
  // effective zone resolves to `null` here and is NOT looked up a second time in any other scope.
  // No fallback, automatic or declared — a key that means one thing in the chat and another in the
  // preview must be silent in the zone it does not belong to, or the editor loses it again.
  const zone = effectiveZone(context.focus, context.fullscreen);
  const zoned = resolveHotkey(pressed, zone);
  if (zoned?.inert === true) return { kind: "none" };
  if (zoned !== null) return { kind: "action-execute", actionId: zoned.id };

  // The chat zone's two inline keys (§5). They are not registry rows and carry no scope: they are
  // resolved here exactly as they always were, now behind the zone rather than behind a
  // `focus === "chat"` flag. §3.2: typing the next message WHILE a turn runs is allowed — only
  // sending is refused, which `applyIntent`'s `composer-submit` handles at its real source.
  // `context.overlay === null` is not re-checked here: every non-null overlay returned from its
  // own branch far above, so reaching this line already proves it.
  if (zone === "chat" && context.screen === "workspace") {
    if (key.sequence === "/" && context.composerValue.length === 0) return { kind: "slash-open" };
    // Refused, not merely rejected downstream — see `KeyContext.projectOpen`.
    if (isSubmitKey(key)) {
      return context.projectOpen ? { kind: "composer-submit" } : { kind: "none" };
    }
  }

  return { kind: "none" };
}
