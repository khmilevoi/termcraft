import type { CommandKindV1, UnavailableReason } from "core/protocol";
import type { CapabilityState, ScreenKind } from "ui/mirror";

export type UiActionExecution =
  | {
      readonly kind: "local";
      readonly effect:
        | "fullscreen"
        | "open-chats"
        | "exit"
        | "compose-repair"
        | "page-prev"
        | "page-next"
        | "chat-scroll-up"
        | "chat-scroll-down"
        | "chat-follow-latest";
    }
  | {
      readonly kind: "command";
      // `preview.retry` is the one member whose payload is not `{}` — it names the session it
      // retries, which `intent.ts` reads from the mirror rather than inventing.
      readonly command: "chat.create" | "export.start" | "preview.retry";
    }
  | { readonly kind: "inert" };

/** One source row from which slash commands and hotkeys are projected. */
export interface UiActionEntry {
  readonly id: string;
  readonly execution: UiActionExecution;
  readonly slash?: SlashCommand;
  readonly hotkey?: HotkeyAction;
}

/**
 * The action table (phase-7 plan D5): one registry the keyboard resolver, the status-bar
 * hint row, and the slash menu are all views over. An action names the exact
 * `CommandKindV1` it dispatches (or `null` for a UI-local action — menu open/close, focus
 * move), so a row's enabled state derives from the mirrored capability plus local
 * applicability, and the Kernel re-validates every domain guard regardless.
 */

/** A slash-menu command (design `commandRegistry`, `termcraft-engine.js:779-786`). */
export interface SlashCommand {
  /** The literal command incl. leading slash, e.g. `"/new"`. */
  readonly cmd: string;
  /** The literal description shown after the command, e.g. `"start a new chat"`. */
  readonly desc: string;
  /** Fixed display order in the full menu (design order). */
  readonly order: number;
  /** The Kernel command this row dispatches, or `null` for a UI-local action (`/chats` opens a popup). */
  readonly capability: CommandKindV1 | null;
  /** Renders the commit-scope dot glyph (`●`) — design `dot:true`. */
  readonly dot?: boolean;
  /** `/commit-infra` is disabled whenever there is nothing to commit — design `clean:true`. */
  readonly clean?: boolean;
  /**
   * The screens this command is meaningful on (§3.10: "a command meaningless on the current
   * screen is hidden"). Transcribed from the design's own `commandRegistry` `home: true` flags
   * (`design/termcraft-engine.js:930` for `/model`, `:934` for `/exit`) — the only two of the
   * eight design rows marked reachable from the Home prompt; every other row is Workspace-only.
   */
  readonly screens: readonly ScreenKind[];
}

/** A hotkey-bound action (design §3.8 hotkey tiers). */
export interface HotkeyAction {
  /** Stable action id. */
  readonly id: string;
  /** Canonical key spelling, lowercase: `"f2"`, `"f3"`, `"ctrl+e"`, … */
  readonly key: string;
  /**
   * Extra key spellings that resolve to this same action, lowercase.
   *
   * Exists for one reason (2026-07-27, HANDOFF Finding 3): a chord like `ctrl+left` reaches the
   * app only if the terminal encodes the modifier into a CSI sequence, and not every terminal,
   * multiplexer or ConPTY path does. A C0 control byte (`ctrl+b` = 0x02) always arrives. Binding
   * both means the guaranteed key is canonical — it is what the label and any future hint would
   * name — while the intuitive chord keeps working wherever it is delivered.
   */
  readonly aliases?: readonly string[];
  /** Label used in the status-bar hint (design `hintKeys`). */
  readonly label: string;
  /** The Kernel command this key dispatches, or `null` for a UI-local key. */
  readonly capability: CommandKindV1 | null;
  /** MVP-inert: the key is shown/known but performs no action yet (F3 tweaks, F4 interact, Ctrl+P). */
  readonly inert?: boolean;
  /**
   * `false` for a key that is BOUND but must not appear in the status-bar hint row.
   *
   * The row is a transcription of the design's own drawn key rows (`Workspace.tsx`'s `hintKeys`,
   * design `hintKeys`/`wsStatus`), so a key the design never drew cannot be added to it without
   * diverging from every screen in `design/*.dc.html`. The page-step keys are the only such
   * entries today: they are a deliberate design extension (see their `UI_ACTIONS` rows), so they
   * work without claiming to be part of the drawn design.
   */
  readonly hint?: false;
}

/** The mirror-derived inputs a row's availability/hint computation needs. */
export interface ActionContext {
  readonly capabilities: ReadonlyMap<CommandKindV1, CapabilityState>;
  readonly turnRunning: boolean;
  readonly screen: ScreenKind;
}

/**
 * A row's three availability states (design `slashBox`, `design/termcraft-engine.js:948-949`:
 * "Locked rows keep readable dim text with an amber reason (temporary); unavailable rows go fully
 * faint (no amber)"):
 *   - `available` — enabled;
 *   - `locked` — locally available but kernel-locked for the duration of a turn. Readable dim with
 *     an amber reason: "it comes back on its own" (the design's own `_lk`);
 *   - `unavailable` — nothing here will change that. Fully faint, no amber (the design's `_un`).
 *
 * `enabled` + `dimmed` could not express this: both non-available states collapsed to
 * `dimmed: true`, which is why a turn-locked row and a permanently-inert one looked identical.
 */
export type ActionAvailability = "available" | "locked" | "unavailable";

/** The computed display state of one slash/action row. */
export interface ActionRowState {
  readonly visible: boolean;
  readonly availability: ActionAvailability;
  /** The reason to show in place of the description while not `available`, or `null`. */
  readonly hint: UnavailableReason | null;
}

/** A slash row plus its computed state, as the slash menu renders it. */
export interface ScoredSlashRow {
  readonly command: SlashCommand;
  readonly state: ActionRowState;
}
