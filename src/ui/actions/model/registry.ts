import type { CommandKindV1, UnavailableReason } from "core/protocol";
import { primaryReason } from "core/protocol";
import type { CapabilityState } from "ui/mirror";

import type {
  ActionContext,
  ActionRowState,
  HotkeyAction,
  HotkeyScope,
  ScoredSlashRow,
  SlashCommand,
  UiActionEntry,
} from "../types";

/**
 * The slash-command registry, verbatim from design's `commandRegistry`
 * (`termcraft-engine.js:926-934` — CORRECTED, phase-8 Task 17: was miscited `:779-786`, a stale
 * line range from before later design sections were inserted above it) — literal commands,
 * descriptions, order, commit dots, and the `home:true`/no-`lock` `/exit` row (`:934`). All
 * eight rows below come straight from design's own list, in its own order — CORRECTED, phase-8
 * Task 17 review fix round 1: an earlier version of this comment claimed `/exit` was added
 * "PLUS" a design registry that "never drew" it; design as it stands today already draws all
 * eight, `/exit` included, so that claim was simply false, not merely stale. What design does
 * NOT specify for any row — it is a static mockup with no concept of "execution" — is HOW each
 * row is carried out; `app.exit`'s own comment below covers that mapping for `/exit`.
 * `/chats` has `capability: null` because the row opens the chat-list popup (a UI-local
 * action); the actual switch is a separate `chat.switch` command issued from the popup.
 * `/commit-*` map to the deferred `commit.plan` (Tier-C) so they always render `unavailable`.
 */
export const UI_ACTIONS: readonly UiActionEntry[] = [
  {
    id: "chat.create",
    execution: { kind: "command", command: "chat.create" },
    slash: {
      cmd: "/new",
      desc: "start a new chat",
      order: 1,
      capability: "chat.create",
      screens: ["workspace"],
    },
  },
  {
    id: "chat.open-list",
    execution: { kind: "local", effect: "open-chats" },
    slash: {
      cmd: "/chats",
      desc: "switch or list chats",
      order: 2,
      capability: null,
      screens: ["workspace"],
    },
  },
  {
    id: "preview.fullscreen",
    execution: { kind: "local", effect: "fullscreen" },
    hotkey: {
      id: "preview.fullscreen",
      key: "f2",
      scope: "global",
      label: "fullscreen",
      capability: null,
    },
  },
  {
    // THE MISSING PRODUCER (defect fix, 2026-07-26). `Workspace.tsx`'s circuit-open ErrorPanel
    // has always told the user to "press retry to try again", and the Kernel has always declared
    // the `preview.retry` command — but NOTHING in `src/ui` ever dispatched it, so the sentence
    // named an action that could not be taken.
    //
    // DIVERGENCE — CLOSED (design iteration 8, 2026-07-27). This note used to record a live
    // gap: the design specified the affordance in prose but named no key, having no circuit-open
    // screen at all, so `f5` was chosen in code because it continued the pane's own key
    // vocabulary (`f2` fullscreen, `f3` tweaks, `f4` interact) at the next free slot. The design
    // now HAS that screen — `termcraft-engine.js`'s `wsHostCrash` draws `F5 retry preview` and
    // `F6 repair…` — and it names `f5` for exactly this. The reasoning was right and the key is
    // now design-named; this is history, not an open divergence.
    id: "preview.retry",
    execution: { kind: "command", command: "preview.retry" },
    hotkey: {
      id: "preview.retry",
      key: "f5",
      scope: "global",
      label: "retry",
      capability: "preview.retry",
    },
  },
  {
    // The design's second route out of a halted preview (`termcraft-engine.js`'s `wsHostCrash`:
    // `F6 repair… · write the failure into the composer · nothing is sent — you press ⏎`).
    //
    // `kind: "local"` and `capability: null` because nothing is dispatched: the effect writes
    // the composer and moves focus, and the user sends it themselves. Whether it acts at all is
    // decided in `intent.ts` against the failure's own class — a spawn failure gets no repair
    // offer, because no edit to the page could fix it (spec §3.2.1).
    id: "preview.repair",
    execution: { kind: "local", effect: "compose-repair" },
    hotkey: {
      id: "preview.repair",
      key: "f6",
      scope: "global",
      label: "repair",
      capability: null,
    },
  },
  {
    // PAGE SWITCHING FROM THE KEYBOARD — A DELIBERATE DESIGN EXTENSION (2026-07-27, maintainer
    // decision "мышь и клава"). The design switches pages by MOUSE only: `drawTabs`
    // (`design/termcraft-engine.js:469`) draws the strip, `design/18-tab-management.dc.html`
    // covers its context menu, and §3.8's two hotkey tiers name no page key at all — so unlike
    // `f5`/`f6` below, this key is NOT design-named and is recorded here as an extension rather
    // than presented as design.
    //
    // WHY `ctrl+left`/`ctrl+right` CANONICAL AND `ctrl+b`/`ctrl+n` ALIASED (RE-SPELLED 2026-08-10,
    // focus-scoped-hotkeys §5.1 — this pair has now been spelled three ways, so the history is
    // kept rather than rewritten):
    //   - the arrows were the ORIGINAL binding, and were dropped on 2026-08-03 because
    //     `resolveHotkey` ran ahead of every input branch, so Ctrl+Left switched pages from inside
    //     a text field, shadowing OpenTUI's own `word-backward`/`word-forward`;
    //   - scopes remove that collision at the root: this row is `preview`, so in the chat zone the
    //     chord is not looked up here at all and reaches the editor unchanged. The arrows are the
    //     intuitive spelling and can now be afforded;
    //   - the ALIASES ARE MANDATORY, not decorative. A ctrl+arrow reaches the app only when the
    //     terminal encodes the modifier into a CSI sequence (`\x1b[1;5C`); the maintainer's own
    //     terminal delivers a bare `\x1b[C` with the modifier dropped. `ctrl+b`/`ctrl+n` are C0
    //     control bytes (0x02 / 0x0E) — one byte, no encoding to get wrong — so the guaranteed
    //     spelling stays bound wherever the chord is not delivered. This is exactly what
    //     `HotkeyAction.aliases` was introduced for;
    //   - neither spelling can be typed into the composer: `printableChar` rejects every code
    //     below 0x20, and a CSI sequence fails on length alone.
    // NOT hinted in the status bar: `hintKeys` renders the design's own key rows verbatim, and the
    // design draws no page-step key anywhere — both entries keep `hint: false`.
    id: "page.prev",
    execution: { kind: "local", effect: "page-prev" },
    hotkey: {
      id: "page.prev",
      key: "ctrl+left",
      aliases: ["ctrl+b"],
      label: "prev page",
      capability: null,
      scope: "preview",
      hint: false,
    },
  },
  {
    id: "page.next",
    execution: { kind: "local", effect: "page-next" },
    hotkey: {
      id: "page.next",
      key: "ctrl+right",
      aliases: ["ctrl+n"],
      label: "next page",
      capability: null,
      scope: "preview",
      hint: false,
    },
  },
  {
    // SCROLLING THE CHAT STREAM FROM THE KEYBOARD (chat-scroll spec §5.5). Like
    // `page.prev`/`page.next` above, this is a DESIGN EXTENSION and is recorded as one:
    // §3.8's two hotkey tiers name no chat key at all, and the design's own
    // `▲ N earlier messages` indicator (`design/termcraft-engine.js:569`) leads nowhere.
    // Design iteration 10 decides only whether these keys are DRAWN in the status-bar key
    // row; the binding itself is this project's.
    //
    // HINTED, UNLIKE `page.prev`/`page.next` ABOVE (chat-scroll spec §11 answer 7): every one
    // of the design's seven `wsStatus(...)` calls lists `PgUp`/`PgDn` in its key row
    // (`design/28-chat-scroll.dc.html:46`, e.g. `design/termcraft-engine.js:1541`), so —
    // unlike the page-step keys above, which the design never draws at all — these two are
    // NOT excluded from `hintKeys()` (`ui/workspace/ui/Workspace.tsx`).
    //
    // DIVERGENCE (closest faithful mapping, CLAUDE.md "design is a source of truth"): the
    // design's own status row shows ONE combined hint, `PgUp/PgDn` paired with the single
    // label `scroll` (`design/termcraft-engine.js:1541` etc.,
    // `wsStatus(...,keys:[['PgUp/PgDn','scroll'],...])`). `Workspace.tsx`'s `hintKeys()` and
    // this file's own `HotkeyAction` shape have no mechanism to merge two registry entries
    // into one combined glyph/label tuple — every other hint in this file is one glyph, one
    // label, 1:1 with one action, and building a merge mechanism for this single pair is out
    // of scope for the task that dropped `hint: false` below (chat-scroll spec, Task 12). So
    // the status bar renders TWO separate entries, `PgUp scroll up` and `PgDn scroll down`
    // (this registry's own glyph/label pair below — `Workspace.tsx`'s `hotkeyGlyph` renders
    // `pageup`/`pagedown` as `PgUp`/`PgDn`, review finding I5), rather than the design's one
    // `PgUp/PgDn scroll`.
    //
    // WHY `chat` SCOPE, NOT GLOBAL (CORRECTED 2026-08-10, focus-scoped-hotkeys §5.2): the original
    // reasoning here was "it must be GLOBAL tier, because the composer owns focus by default and a
    // bare letter would be swallowed as text". Read closely, that argues for the SPELLING, not for
    // the tier — and the spelling still holds: `PgUp`/`PgDn` arrive as multi-character CSI
    // sequences that `printableChar` rejects on length, and `ctrl+u` is a C0 byte below 0x20.
    // Scoping to `chat` reintroduces none of that hazard: the keys still cannot be typed, and the
    // chat zone is where they already did their work. In the preview zone they now go inert, which
    // is the intended change.
    //
    // NO `ctrl+d` ALIAS HERE (review finding I3, fix round 1) — an earlier version of this row
    // gave `chat.scroll-down` the same C0-byte alias treatment as `chat.scroll-up`'s `ctrl+u`,
    // reading only the encoding argument above and missing that the design already assigns `^D`
    // a DIFFERENT meaning: `design/termcraft-engine.js:1525` (`o.following===false` branch) and
    // both `wsScrollMid`/`wsScrollLive`'s own key rows (`:1557`,`:1605`) bind it to "follow
    // latest", not "page down". `chat.follow-latest` below is the real `^D`; this entry keeps
    // only its PgDn glyph.
    id: "chat.scroll-up",
    execution: { kind: "local", effect: "chat-scroll-up" },
    hotkey: {
      id: "chat.scroll-up",
      key: "pageup",
      aliases: ["ctrl+u"],
      label: "scroll up",
      capability: null,
      scope: "chat",
    },
  },
  {
    id: "chat.scroll-down",
    execution: { kind: "local", effect: "chat-scroll-down" },
    hotkey: {
      id: "chat.scroll-down",
      key: "pagedown",
      label: "scroll down",
      capability: null,
      scope: "chat",
    },
  },
  {
    // FOLLOW LATEST (design iteration 10 answers 2/6, review finding I2/I3): `^D`,
    // `design/termcraft-engine.js:1525,1557,1602`. Scoped to `chat` (CORRECTED 2026-08-10,
    // focus-scoped-hotkeys §5.2 — it read "Bound GLOBAL tier and unconditionally resolvable"): the
    // viewport it jumps is the chat's own, so in the preview zone there is nothing for it to do.
    // `hintKeys` still decides when to DRAW it (only while `!following`, matching every mockup that
    // shows it) — the scope decides where it ACTS.
    id: "chat.follow-latest",
    execution: { kind: "local", effect: "chat-follow-latest" },
    hotkey: {
      id: "chat.follow-latest",
      key: "ctrl+d",
      label: "follow",
      capability: null,
      scope: "chat",
    },
  },
  {
    id: "preview.tweaks",
    execution: { kind: "inert" },
    hotkey: {
      id: "preview.tweaks",
      key: "f3",
      label: "tweaks",
      capability: null,
      scope: "global",
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
      scope: "global",
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
      screens: ["workspace"],
    },
    hotkey: {
      id: "export.start",
      key: "ctrl+e",
      label: "export",
      capability: "export.start",
      scope: "global",
    },
  },
  {
    id: "model.select",
    execution: { kind: "inert" },
    slash: {
      cmd: "/model",
      desc: "agent · model · effort",
      order: 4,
      capability: "model.select",
      // design `commandRegistry` (`termcraft-engine.js:930`): `/model` is the one v1.0 row
      // marked `home:true` — reachable (and rendered `unavailable`) from the Home prompt too.
      screens: ["workspace", "home"],
    },
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
      screens: ["workspace"],
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
      screens: ["workspace"],
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
      screens: ["workspace"],
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
      scope: "global",
      inert: true,
    },
  },
  // `/exit`'s SHAPE — cmd, desc, order-8 (trailing) position, `home:true`, no `lock` (turn-safe)
  // — comes straight from design's own `commandRegistry()` (`design/termcraft-engine.js:934`:
  // `{cmd:'/exit', desc:'quit termcraft', home:true}`). CORRECTED, phase-8 Task 17 review fix
  // round 1: an earlier version of this comment claimed this row EXTENDS design's registry
  // ("that list holds exactly the seven rows above and no `/exit` — the design never drew a
  // Workspace quit affordance at all") — false against the design file as it stands, which
  // already draws `/exit` as its own eighth row, field-for-field identical to this entry's own
  // `slash` object below. What design does NOT specify — it draws no "execution" for any row —
  // is that quitting dispatches no Kernel command at all: `/exit` is a UI-local action
  // (`capability: null`, `execution: {kind:"local", effect:"exit"}` calling `requestExit()`),
  // reachable from both the Workspace composer and the Home prompt per master spec §3.9's
  // slash-menu permission and design's own `home:true` flag.
  {
    id: "app.exit",
    execution: { kind: "local", effect: "exit" },
    slash: {
      cmd: "/exit",
      desc: "quit termcraft",
      order: 8,
      capability: null,
      // design `commandRegistry` (`termcraft-engine.js:934`): `/exit`'s own `home:true` flag —
      // the one Home-reachable row that can always execute, since (per this entry's own comment
      // above) it never reaches the Kernel at all, so there is nothing there to refuse it
      // (§3.10, phase-8 Task 17, finding §2.4).
      screens: ["workspace", "home"],
    },
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

/**
 * The one lookup key: a scope and a spelling, never one without the other. A space separates them
 * safely because no scope and no key spelling contains one — every spelling is a lowercase key
 * name, optionally `ctrl+`-prefixed (`hotkeyName` in `ui/app/model/keymap.ts` builds exactly that).
 */
function scopedKey(scope: HotkeyScope, key: string): string {
  return `${scope} ${key.toLowerCase()}`;
}

const HOTKEY_BY_SCOPED_KEY: ReadonlyMap<string, HotkeyAction> = new Map(
  HOTKEYS.flatMap((action) =>
    [action.key, ...(action.aliases ?? [])].map(
      (spelling) => [scopedKey(action.scope, spelling), action] as const,
    ),
  ),
);

/**
 * Resolves an EXACT `(key, scope)` pair to its hotkey action, or `null`.
 *
 * STRICT BY CONSTRUCTION (focus-scoped-hotkeys §4): asked for a zone, this never falls back to
 * `global`, and asked for `global` it never reaches into a zone. A caller that wants both asks
 * twice, in the order it wants them — which is exactly what `resolveKey` does, and why the
 * ordering lives there, visible, instead of hidden in a fallback chain here.
 */
export function resolveHotkey(key: string, scope: HotkeyScope): HotkeyAction | null {
  return HOTKEY_BY_SCOPED_KEY.get(scopedKey(scope, key)) ?? null;
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
  // design `slashRows` (`termcraft-engine.js:943`): on Home, `/model` reports its own reason
  // rather than a capability hint — it is v1.0, not turn-locked and not missing a capability.
  // DIVERGENCE (closest faithful mapping, CLAUDE.md "design is a source of truth"): the design's
  // OWN text here is the literal `'v1.0 — not in this build'`, but `UnavailableReason` carries no
  // message-text field at all (kernel-command-contract §11.1: "User-facing prose is presentation
  // data; callers branch on codes, never message text" — `core/protocol/model/unavailable-
  // reason.ts`'s `detailsFreeReason` gives `CAPABILITY_UNAVAILABLE` a `z.strictObject({code})`
  // with no `safeMessage`/`detail` property, so a literal carrying one does not even type-check).
  // There is no Kernel-vocabulary code for "this feature does not exist yet" beyond the generic
  // `CAPABILITY_UNAVAILABLE` every other deferred/v1.0 row already renders (the `/commit-*`
  // Tier-C rows, via `capabilityHint` below) — reusing that code and its existing "unavailable"
  // `reasonLabel` is the closest faithful mapping, not an invented message field.
  if (context.screen === "home" && command.cmd === "/model") {
    return { visible: true, availability: "unavailable", hint: { code: "CAPABILITY_UNAVAILABLE" } };
  }

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
 * Filters and scores the slash menu for the typed prefix and screen (design `slashMenu`/
 * `slashRows`'s `o.scope` filter, §3.10): `"/"` shows every command meaningful on the current
 * screen; a longer prefix keeps commands that start with it AND are meaningful there. Rows stay
 * in fixed design order.
 */
export function filterSlashRows(typed: string, context: ActionContext): readonly ScoredSlashRow[] {
  // The screen filter runs FIRST (§3.10), so "no row matches" and "the menu does not open at all"
  // are the same condition — `design/termcraft-engine.js`'s own `home('slash-none')` frame draws
  // exactly that: `/` stays literal text in the prompt and no box appears.
  const onScreen = SLASH_COMMANDS.filter((c) => c.screens.includes(context.screen));
  const rows = typed === "/" ? onScreen : onScreen.filter((c) => c.cmd.startsWith(typed));
  return [...rows]
    .sort((a, b) => a.order - b.order)
    .map((command) => ({ command, state: slashRowState(command, context) }));
}

/** The index of the first `available` row (design: selection lands on the first non-disabled row), or -1. */
export function firstEnabledIndex(rows: readonly ScoredSlashRow[]): number {
  return rows.findIndex((row) => row.state.availability === "available");
}
