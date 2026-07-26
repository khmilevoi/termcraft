/**
 * `ui/actions` — the single action table (phase-7 plan D5). The slash-command registry, the
 * hotkey registry, and the capability-driven enabled/hint computation the status bar and
 * slash menu both read.
 */
export type {
  ActionAvailability,
  ActionContext,
  ActionRowState,
  HotkeyAction,
  ScoredSlashRow,
  SlashCommand,
  UiActionEntry,
  UiActionExecution,
} from "./types";
export {
  HOTKEYS,
  SLASH_COMMANDS,
  UI_ACTIONS,
  capabilityHint,
  capabilityState,
  filterSlashRows,
  firstEnabledIndex,
  isCapabilityAvailable,
  resolveHotkey,
  resolveSlashAction,
  resolveUiAction,
  slashRowState,
} from "./model/registry";
export { reasonLabel } from "./model/reasons";
