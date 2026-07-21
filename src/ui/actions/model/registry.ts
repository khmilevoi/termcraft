import type { CommandKindV1, UnavailableReason } from "core/protocol";
import { primaryReason } from "core/protocol";
import type { CapabilityState } from "ui/mirror";

import type {
  ActionContext,
  ActionRowState,
  HotkeyAction,
  ScoredSlashRow,
  SlashCommand,
} from "../types";

/**
 * The slash-command registry, verbatim from design's `commandRegistry`
 * (`termcraft-engine.js:779-786`) — literal commands, descriptions, order, and commit dots.
 * `/chats` has `capability: null` because the row opens the chat-list popup (a UI-local
 * action); the actual switch is a separate `chat.switch` command issued from the popup.
 * `/commit-*` map to the deferred `commit.plan` (Tier-C) so they always render dimmed.
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { cmd: "/new", desc: "start a new chat", order: 1, capability: "chat.create" },
  { cmd: "/chats", desc: "switch or list chats", order: 2, capability: null },
  { cmd: "/export", desc: "write the export package", order: 3, capability: "export.start" },
  { cmd: "/model", desc: "agent · model · effort", order: 4, capability: "model.select" },
  {
    cmd: "/commit-page",
    desc: "current page · 1 file",
    order: 5,
    capability: "commit.plan",
    dot: true,
  },
  {
    cmd: "/commit-infra",
    desc: "infrastructure · clean",
    order: 6,
    capability: "commit.plan",
    clean: true,
  },
  {
    cmd: "/commit-all",
    desc: "entire project · 7 files",
    order: 7,
    capability: "commit.plan",
    dot: true,
  },
];

/**
 * The global/single-char hotkeys (design §3.8). F3/F4/Ctrl+P are MVP-inert (Tweaks and
 * interactive input are out of scope; the keys are still known so the shell does not treat
 * them as text). `ctrl+e` (export) and `/` are deliberately excluded from the status-bar
 * hint row by the renderer — see `ui/status-bar` — matching design's `hintKeys` filter.
 */
export const HOTKEYS: readonly HotkeyAction[] = [
  { id: "preview.fullscreen", key: "f2", label: "fullscreen", capability: null },
  { id: "preview.tweaks", key: "f3", label: "tweaks", capability: null, inert: true },
  { id: "preview.interact", key: "f4", label: "interact", capability: null, inert: true },
  { id: "export.start", key: "ctrl+e", label: "export", capability: "export.start" },
  { id: "preview.controls", key: "ctrl+p", label: "preview", capability: null, inert: true },
];

const HOTKEY_BY_KEY: ReadonlyMap<string, HotkeyAction> = new Map(HOTKEYS.map((h) => [h.key, h]));

/** Resolves a canonical (lowercase) key spelling to its hotkey action, or `null`. */
export function resolveHotkey(key: string): HotkeyAction | null {
  return HOTKEY_BY_KEY.get(key.toLowerCase()) ?? null;
}

/** The published capability state for a command kind, or `undefined` if the Kernel has not published one. */
export function capabilityState(
  context: ActionContext,
  id: CommandKindV1,
): CapabilityState | undefined {
  return context.capabilities.get(id);
}

/** True when a command's capability is published AND available. A missing capability is treated as unavailable. */
export function isCapabilityAvailable(context: ActionContext, id: CommandKindV1): boolean {
  return context.capabilities.get(id)?.available === true;
}

/** The primary unavailable reason for a command kind, or `null` when available/unpublished. */
export function capabilityHint(
  context: ActionContext,
  id: CommandKindV1,
): UnavailableReason | null {
  const state = context.capabilities.get(id);
  if (state === undefined || state.available === true) return null;
  return primaryReason(state.reasons);
}

/**
 * Computes one slash row's display state (design §3.10). A row is dimmed-not-hidden when
 * disabled. Turn-lock: while a turn runs, every non-`/commit-*` row dims (design
 * `o.turn && !isCommit(c)`) — this also covers the `capability: null` `/chats` row, whose
 * `chat.switch` is turn-locked but which carries no capability of its own.
 */
export function slashRowState(command: SlashCommand, context: ActionContext): ActionRowState {
  const isCommit = command.cmd.startsWith("/commit");
  const turnLocked = context.turnRunning && !isCommit;

  if (command.capability === null) {
    const enabled = !turnLocked;
    return { visible: true, enabled, dimmed: !enabled, hint: null };
  }

  const available = isCapabilityAvailable(context, command.capability) && !turnLocked;
  return {
    visible: true,
    enabled: available,
    dimmed: !available,
    hint: capabilityHint(context, command.capability),
  };
}

/**
 * Filters and scores the slash menu for the typed prefix (design `slashMenu`): `"/"` shows
 * every command; a longer prefix keeps commands that start with it. Rows stay in fixed
 * design order.
 */
export function filterSlashRows(typed: string, context: ActionContext): readonly ScoredSlashRow[] {
  const rows =
    typed === "/" ? SLASH_COMMANDS : SLASH_COMMANDS.filter((c) => c.cmd.startsWith(typed));
  return [...rows]
    .sort((a, b) => a.order - b.order)
    .map((command) => ({ command, state: slashRowState(command, context) }));
}

/** The index of the first enabled row (design: selection lands on the first non-disabled row), or -1. */
export function firstEnabledIndex(rows: readonly ScoredSlashRow[]): number {
  return rows.findIndex((row) => row.state.enabled);
}
