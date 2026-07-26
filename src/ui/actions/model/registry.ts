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
 * Resolves a row's availability purely from ONE Kernel capability id's published state — the
 * single authority `slashRowState` reads for every row that has a real command behind it,
 * including `/chats` below, which is special-cased onto `chat.switch` even though its OWN
 * `command.capability` is `null`.
 */
function capabilityRowState(context: ActionContext, id: CommandKindV1): ActionRowState {
  const state = capabilityState(context, id);
  if (state?.available === true) return { visible: true, availability: "available", hint: null };

  const hint = capabilityHint(context, id);
  const locked = hint !== null && hint.code === "TURN_RUNNING";
  return { visible: true, availability: locked ? "locked" : "unavailable", hint };
}

/**
 * Computes one slash row's display state (design §3.10). A row is `visible: true` even while
 * not `available` — never hidden.
 *
 * CORRECTED (finding §2.5, phase-8 Task 16): this used to compute its own `turnLocked = context.
 * turnRunning && !isCommit` bit and apply it as a SECOND, independent lock authority on top of
 * the Kernel's own per-command capability state — which dimmed `/chats` AND `/exit` for the
 * whole duration of a turn even though neither carries a Kernel capability of its OWN. `/exit`
 * really is turn-safe (design `commandRegistry`, `design/termcraft-engine.js:934`, no `lock` at
 * all) and is exactly what someone wants reachable when a turn is stuck — dimming it was the bug
 * this task fixes. `/chats` is NOT turn-safe: design's own registry (`:928`) gives it the
 * IDENTICAL `lock:'locked · turn running'` as `/new`, and `wsSlashTurn` (`:1004`) draws it
 * locked — its `command.capability` reads `null` only because the ROW itself dispatches no
 * Kernel command (it opens a popup), but the action it exists for, switching chats, dispatches
 * `chat.switch` from that popup (`intent.ts`'s `chat-switch` case), one of §10.4's
 * `TURN_LOCKED_KINDS` (`core/capabilities/model/turn-lock.ts:30`). REVIEW ROUND 1 FIX: a first
 * pass read `turn-lock.ts:25-26`'s "local slash-command mode ... no Kernel command at all" as
 * covering `/chats` too — that line is about the `/` INPUT MODE (typing a slash opens local
 * command mode), not this specific row, and `commandRegistry` thirteen lines from the line this
 * fix's citation leaned on says the opposite for `/chats` itself. There is now exactly ONE
 * authority, `capabilityRowState` above, applied per row:
 * - a `capability: null` row that is genuinely turn-safe (`/exit`) is always `available`;
 * - `/chats` reads `chat.switch`'s published state — the same authority that blocks `/new`;
 * - every other row reads its own `command.capability`'s published state. `context.turnRunning`
 *   is not read here at all.
 *
 * Priority: `unavailable` outranks `locked` (design `slashRows` `:943-945`'s `if _un … else if
 * _un … else if (o.turn && c.lock) _lk`) — a row whose capability is unavailable for its own
 * reason (e.g. `NO_PAGES`) reports that reason, never the misleading "it comes back on its own"
 * of `locked`. What this function actually guarantees: `locked` is reported iff the PRIMARY hint
 * (`capabilityHint`'s `primaryReason` selection) is exactly `TURN_RUNNING`; any other primary
 * reason reports `unavailable`. This is NOT structurally guaranteed to match design's priority in
 * every case — `core/capabilities/model/guards.ts`'s `collectReasons` (`:49-58`) can concatenate
 * `turnLockedReason(...)` alongside a family-specific reason into ONE `state.reasons` array, and
 * `UNAVAILABLE_REASON_PRIORITY_V1` ranks `TURN_RUNNING` (tier 3) ABOVE codes like `NO_PAGES`
 * (tier 7) — so if a guard ever published both for the same command, `primaryReason` would pick
 * `TURN_RUNNING` and this function would report `locked`, the opposite of design's stated
 * priority. Today this is latent, not reachable: no `core/capabilities` guard emits `NO_PAGES` at
 * all — its only emitter is `core/export/model/snapshot.ts:80`, a command EXECUTION result, never
 * a published capability reason.
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

  // `/chats`'s own `command.capability` is `null` (the row opens a UI-local popup — see
  // `UI_ACTIONS`'s own comment on this entry), but design locks it exactly like `/new`
  // (`design/termcraft-engine.js:928`, `wsSlashTurn:1004`) because the action it exists for,
  // `chat.switch`, is turn-locked. Read that capability directly, not `command.capability`.
  if (command.cmd === "/chats") return capabilityRowState(context, "chat.switch");

  // Every OTHER `capability: null` row is a genuinely turn-safe LOCAL action — `/exit` quits,
  // and design (`:934`) lists it with no `lock` at all, confirming there is really nothing here
  // for the Kernel to block. The old blanket `turnRunning && !isCommit` dimmed it too, which left
  // it unusable exactly when a stuck turn made someone want it (finding §2.5).
  if (command.capability === null) {
    return { visible: true, availability: "available", hint: null };
  }

  // Everything else reads its own PUBLISHED capability state (the same helper `/chats` uses
  // above), which already carries `TURN_RUNNING` per kind with its own hint text (§10.4's
  // `TURN_LOCKED_KINDS`) — one authority, not two.
  return capabilityRowState(context, command.capability);
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

/** The index of the first `available` row (design: selection lands on the first non-disabled row), or -1. */
export function firstEnabledIndex(rows: readonly ScoredSlashRow[]): number {
  return rows.findIndex((row) => row.state.availability === "available");
}
