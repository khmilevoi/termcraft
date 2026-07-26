import type { CommandKindV1, UnavailableReason } from "core/protocol";
import { primaryReason } from "core/protocol";
import type { CapabilityState } from "ui/mirror";

import type {
  ActionContext,
  ActionRowState,
  HotkeyAction,
  ScoredSlashRow,
  SlashCommand,
  UiActionEntry,
} from "../types";

/**
 * The slash-command registry, verbatim from design's `commandRegistry`
 * (`termcraft-engine.js:779-786`) — literal commands, descriptions, order, and commit dots —
 * PLUS the trailing `app.exit` row (order 8), which the design never drew; see that entry's
 * own comment for why it is added rather than invented silently.
 * `/chats` has `capability: null` because the row opens the chat-list popup (a UI-local
 * action); the actual switch is a separate `chat.switch` command issued from the popup.
 * `/commit-*` map to the deferred `commit.plan` (Tier-C) so they always render `unavailable`.
 */
export const UI_ACTIONS: readonly UiActionEntry[] = [
  {
    id: "chat.create",
    execution: { kind: "command", command: "chat.create" },
    slash: { cmd: "/new", desc: "start a new chat", order: 1, capability: "chat.create" },
  },
  {
    id: "chat.open-list",
    execution: { kind: "local", effect: "open-chats" },
    slash: { cmd: "/chats", desc: "switch or list chats", order: 2, capability: null },
  },
  {
    id: "preview.fullscreen",
    execution: { kind: "local", effect: "fullscreen" },
    hotkey: { id: "preview.fullscreen", key: "f2", label: "fullscreen", capability: null },
  },
  {
    id: "preview.tweaks",
    execution: { kind: "inert" },
    hotkey: {
      id: "preview.tweaks",
      key: "f3",
      label: "tweaks",
      capability: null,
      inert: true,
    },
  },
  {
    id: "preview.interact",
    execution: { kind: "inert" },
    hotkey: {
      id: "preview.interact",
      key: "f4",
      label: "interact",
      capability: null,
      inert: true,
    },
  },
  {
    id: "export.start",
    execution: { kind: "command", command: "export.start" },
    slash: {
      cmd: "/export",
      desc: "write the export package",
      order: 3,
      capability: "export.start",
    },
    hotkey: { id: "export.start", key: "ctrl+e", label: "export", capability: "export.start" },
  },
  {
    id: "model.select",
    execution: { kind: "inert" },
    slash: { cmd: "/model", desc: "agent · model · effort", order: 4, capability: "model.select" },
  },
  {
    id: "commit.page",
    execution: { kind: "inert" },
    slash: {
      cmd: "/commit-page",
      desc: "current page · 1 file",
      order: 5,
      capability: "commit.plan",
      dot: true,
    },
  },
  {
    id: "commit.infra",
    execution: { kind: "inert" },
    slash: {
      cmd: "/commit-infra",
      desc: "infrastructure · clean",
      order: 6,
      capability: "commit.plan",
      clean: true,
    },
  },
  {
    id: "commit.all",
    execution: { kind: "inert" },
    slash: {
      cmd: "/commit-all",
      desc: "entire project · 7 files",
      order: 7,
      capability: "commit.plan",
      dot: true,
    },
  },
  {
    id: "preview.controls",
    execution: { kind: "inert" },
    hotkey: {
      id: "preview.controls",
      key: "ctrl+p",
      label: "preview",
      capability: null,
      inert: true,
    },
  },
  // `/exit` EXTENDS design's own command registry (`design/termcraft-engine.js:779-786`
  // `commandRegistry()`): that list holds exactly the seven rows above and no `/exit` — the
  // design never drew a Workspace quit affordance at all, only `q quit` on Home's status bars
  // (`:145`, `:583`) and the too-small-terminal screen. This is a dated product decision
  // (phase-8 WP-10, 2026-07-25) filling that gap: `/exit` is a UI-local action (no Kernel
  // capability — quitting is not a Kernel command), reachable from both the Workspace composer
  // and the Home prompt per master spec §3.9's slash-menu permission, ordered after the seven
  // design rows rather than interleaved among them.
  {
    id: "app.exit",
    execution: { kind: "local", effect: "exit" },
    slash: { cmd: "/exit", desc: "quit termcraft", order: 8, capability: null },
  },
];

export const SLASH_COMMANDS: readonly SlashCommand[] = UI_ACTIONS.flatMap((entry) =>
  entry.slash ? [entry.slash] : [],
);

export const HOTKEYS: readonly HotkeyAction[] = UI_ACTIONS.flatMap((entry) =>
  entry.hotkey ? [entry.hotkey] : [],
);

const ACTION_BY_ID: ReadonlyMap<string, UiActionEntry> = new Map(
  UI_ACTIONS.map((entry) => [entry.id, entry]),
);
const ACTION_BY_SLASH: ReadonlyMap<string, UiActionEntry> = new Map(
  UI_ACTIONS.flatMap((entry) => (entry.slash ? [[entry.slash.cmd, entry] as const] : [])),
);

const HOTKEY_BY_KEY: ReadonlyMap<string, HotkeyAction> = new Map(HOTKEYS.map((h) => [h.key, h]));

/** Resolves a canonical (lowercase) key spelling to its hotkey action, or `null`. */
export function resolveHotkey(key: string): HotkeyAction | null {
  return HOTKEY_BY_KEY.get(key.toLowerCase()) ?? null;
}

/** Resolves a stable action id against the one registry. */
export function resolveUiAction(id: string): UiActionEntry | null {
  return ACTION_BY_ID.get(id) ?? null;
}

/** Resolves a slash row back to the registry entry that owns its execution. */
export function resolveSlashAction(command: SlashCommand): UiActionEntry | null {
  return ACTION_BY_SLASH.get(command.cmd) ?? null;
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
 * Computes one slash row's display state (design §3.10). A row is `visible: true` even while
 * not `available` — never hidden. Turn-lock: while a turn runs, every non-`/commit-*` row goes
 * `locked` (design `o.turn && !isCommit(c)`) — this also covers the `capability: null` `/chats`
 * row, whose `chat.switch` is turn-locked but which carries no capability of its own.
 */
export function slashRowState(command: SlashCommand, context: ActionContext): ActionRowState {
  const execution = ACTION_BY_SLASH.get(command.cmd)?.execution;
  if (execution?.kind === "inert") {
    return {
      visible: true,
      availability: "unavailable",
      hint: command.capability === null ? null : capabilityHint(context, command.capability),
    };
  }
  const isCommit = command.cmd.startsWith("/commit");
  const turnLocked = context.turnRunning && !isCommit;

  if (command.capability === null) {
    return { visible: true, availability: turnLocked ? "locked" : "available", hint: null };
  }

  if (turnLocked) {
    return {
      visible: true,
      availability: "locked",
      hint: capabilityHint(context, command.capability),
    };
  }

  const available = isCapabilityAvailable(context, command.capability);
  return {
    visible: true,
    availability: available ? "available" : "unavailable",
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
  return rows.findIndex((row) => row.state.availability === "available");
}
