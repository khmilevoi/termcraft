/**
 * `ui/actions` — the single action table (phase-7 plan D5). The slash-command registry, the
 * hotkey registry, and the capability-driven enabled/hint computation the status bar and
 * slash menu both read.
 */
export type {
  ActionContext,
  ActionRowState,
  HotkeyAction,
  ScoredSlashRow,
  SlashCommand,
} from "./types";
export {
  HOTKEYS,
  SLASH_COMMANDS,
  capabilityHint,
  capabilityState,
  filterSlashRows,
  firstEnabledIndex,
  isCapabilityAvailable,
  resolveHotkey,
  slashRowState,
} from "./model/registry";
export { reasonLabel } from "./model/reasons";
