import type { CommandKindV1, UnavailableReason } from "core/protocol";
import type { CapabilityState, ScreenKind } from "ui/mirror";

export type UiActionExecution =
  | { readonly kind: "local"; readonly effect: "fullscreen" | "open-chats" }
  | { readonly kind: "command"; readonly command: "chat.create" | "export.start" }
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
}

/** A hotkey-bound action (design §3.8 hotkey tiers). */
export interface HotkeyAction {
  /** Stable action id. */
  readonly id: string;
  /** Canonical key spelling, lowercase: `"f2"`, `"f3"`, `"ctrl+e"`, … */
  readonly key: string;
  /** Label used in the status-bar hint (design `hintKeys`). */
  readonly label: string;
  /** The Kernel command this key dispatches, or `null` for a UI-local key. */
  readonly capability: CommandKindV1 | null;
  /** MVP-inert: the key is shown/known but performs no action yet (F3 tweaks, F4 interact, Ctrl+P). */
  readonly inert?: boolean;
}

/** The mirror-derived inputs a row's enabled/hint computation needs. */
export interface ActionContext {
  readonly capabilities: ReadonlyMap<CommandKindV1, CapabilityState>;
  readonly turnRunning: boolean;
  readonly screen: ScreenKind;
}

/** The computed display state of one slash/action row. */
export interface ActionRowState {
  readonly visible: boolean;
  readonly enabled: boolean;
  /** Dimmed = visible-but-disabled (design: disabled rows dim to `faint`, never hidden). */
  readonly dimmed: boolean;
  /** The primary unavailable reason to show as a hint, or `null` when enabled/locally disabled. */
  readonly hint: UnavailableReason | null;
}

/** A slash row plus its computed state, as the slash menu renders it. */
export interface ScoredSlashRow {
  readonly command: SlashCommand;
  readonly state: ActionRowState;
}
