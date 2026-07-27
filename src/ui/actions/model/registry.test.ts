import { describe, expect, test } from "bun:test";

import type { CommandKindV1 } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";
import type { CapabilityState, ScreenKind } from "ui/mirror";

import type { ActionContext } from "../types";
import {
  HOTKEYS,
  SLASH_COMMANDS,
  UI_ACTIONS,
  filterSlashRows,
  firstEnabledIndex,
  resolveHotkey,
  slashRowState,
} from "./registry";

function context(
  capabilities: Iterable<readonly [CommandKindV1, CapabilityState]> = [],
  options: { turnRunning?: boolean; screen?: ScreenKind } = {},
): ActionContext {
  return {
    capabilities: new Map(capabilities),
    turnRunning: options.turnRunning ?? false,
    screen: options.screen ?? "workspace",
  };
}

const available: CapabilityState = { available: true };
const noPages: CapabilityState = { available: false, reasons: [{ code: "NO_PAGES" }] };
const deferred: CapabilityState = {
  available: false,
  reasons: [{ code: "CAPABILITY_UNAVAILABLE" }],
};
// The PUBLISHED shape of a §10.4 `TURN_LOCKED_KINDS` capability while a turn is running (finding
// §2.5, phase-8 Task 16) — `core/capabilities/model/turn-lock.ts`'s `turnLockedReason`. Unlike
// `context({...}, { turnRunning: true })` alone, `slashRowState` no longer reads the context-level
// `turnRunning` bit for a capability row at all — only a capability state whose own reason is
// `TURN_RUNNING` renders `locked`.
const turnRunning: CapabilityState = {
  available: false,
  reasons: [{ code: "TURN_RUNNING", turnId: uuidv7() }],
};

describe("SLASH_COMMANDS registry", () => {
  test("slash and hotkey views are derived from the one UI_ACTIONS table", () => {
    expect(SLASH_COMMANDS).toEqual(
      UI_ACTIONS.flatMap((entry) => (entry.slash ? [entry.slash] : [])),
    );
    expect(HOTKEYS).toEqual(UI_ACTIONS.flatMap((entry) => (entry.hotkey ? [entry.hotkey] : [])));
  });

  test("every action declares its exact local, command, or inert execution", () => {
    expect(UI_ACTIONS.map(({ id, execution }) => [id, execution])).toEqual([
      ["chat.create", { kind: "command", command: "chat.create" }],
      ["chat.open-list", { kind: "local", effect: "open-chats" }],
      ["preview.fullscreen", { kind: "local", effect: "fullscreen" }],
      ["preview.retry", { kind: "command", command: "preview.retry" }],
      ["preview.repair", { kind: "local", effect: "compose-repair" }],
      ["page.prev", { kind: "local", effect: "page-prev" }],
      ["page.next", { kind: "local", effect: "page-next" }],
      ["preview.tweaks", { kind: "inert" }],
      ["preview.interact", { kind: "inert" }],
      ["export.start", { kind: "command", command: "export.start" }],
      ["model.select", { kind: "inert" }],
      ["commit.page", { kind: "inert" }],
      ["commit.infra", { kind: "inert" }],
      ["commit.all", { kind: "inert" }],
      ["preview.controls", { kind: "inert" }],
      ["app.exit", { kind: "local", effect: "exit" }],
    ]);
  });

  test("matches design's commandRegistry order and mapping, plus the trailing /exit row", () => {
    expect(SLASH_COMMANDS.map((c) => c.cmd)).toEqual([
      "/new",
      "/chats",
      "/export",
      "/model",
      "/commit-page",
      "/commit-infra",
      "/commit-all",
      "/exit",
    ]);
    expect(SLASH_COMMANDS.find((c) => c.cmd === "/chats")?.capability).toBeNull();
    expect(SLASH_COMMANDS.find((c) => c.cmd === "/export")?.capability).toBe("export.start");
  });

  test("/exit is a UI-local action with no Kernel capability", () => {
    const entry = UI_ACTIONS.find((a) => a.id === "app.exit");

    expect(entry).toBeDefined();
    expect(entry?.execution).toEqual({ kind: "local", effect: "exit" });
    expect(entry?.slash).toEqual({
      cmd: "/exit",
      desc: "quit termcraft",
      order: 8,
      capability: null,
      screens: ["workspace", "home"],
    });
  });

  // §3.10, phase-8 Task 17: transcribed from design's own `commandRegistry` `home:true` flags
  // (`termcraft-engine.js:930,934`) — exactly `/model` and `/exit` are reachable from Home;
  // every other row is Workspace-only.
  test("screens: every row is workspace-only except /model and /exit, which also list home", () => {
    expect(SLASH_COMMANDS.map((c) => [c.cmd, c.screens])).toEqual([
      ["/new", ["workspace"]],
      ["/chats", ["workspace"]],
      ["/export", ["workspace"]],
      ["/model", ["workspace", "home"]],
      ["/commit-page", ["workspace"]],
      ["/commit-infra", ["workspace"]],
      ["/commit-all", ["workspace"]],
      ["/exit", ["workspace", "home"]],
    ]);
  });
});

describe("slashRowState", () => {
  test("an available capability -> available, no hint", () => {
    const s = slashRowState(
      { cmd: "/export", desc: "", order: 3, capability: "export.start", screens: ["workspace"] },
      context([["export.start", available]]),
    );
    expect(s).toEqual({ visible: true, availability: "available", hint: null });
  });

  test("an unavailable capability -> unavailable with the primary reason as hint", () => {
    const s = slashRowState(
      { cmd: "/export", desc: "", order: 3, capability: "export.start", screens: ["workspace"] },
      context([["export.start", noPages]]),
    );
    expect(s.availability).toBe("unavailable");
    expect(s.hint).toEqual({ code: "NO_PAGES" });
  });

  test("a deferred (Tier-C) commit row is always unavailable with CAPABILITY_UNAVAILABLE", () => {
    const s = slashRowState(
      {
        cmd: "/commit-page",
        desc: "",
        order: 5,
        capability: "commit.plan",
        dot: true,
        screens: ["workspace"],
      },
      context([["commit.plan", deferred]]),
    );
    expect(s.availability).toBe("unavailable");
    expect(s.hint).toEqual({ code: "CAPABILITY_UNAVAILABLE" });
  });

  test("/model and every commit action stay visible but inert even if capability is available", () => {
    const model = slashRowState(
      {
        cmd: "/model",
        desc: "",
        order: 4,
        capability: "model.select",
        screens: ["workspace", "home"],
      },
      context([["model.select", available]]),
    );
    const commit = slashRowState(
      {
        cmd: "/commit-page",
        desc: "",
        order: 5,
        capability: "commit.plan",
        screens: ["workspace"],
      },
      context([["commit.plan", available]]),
    );
    expect(model).toMatchObject({ visible: true, availability: "unavailable" });
    expect(commit).toMatchObject({ visible: true, availability: "unavailable" });
  });

  test("a missing capability is treated as unavailable", () => {
    const s = slashRowState(
      { cmd: "/export", desc: "", order: 3, capability: "export.start", screens: ["workspace"] },
      context(),
    );
    expect(s.availability).toBe("unavailable");
  });

  // `/chats`'s own `command.capability` is `null` (the row opens a UI-local popup), but its
  // availability is NOT unconditional — it reads `chat.switch`'s published state (review round 1
  // fix; see `slashRowState`'s own doc comment for why).
  test("/chats reads its availability from chat.switch's published state, not its own null capability", () => {
    const s = slashRowState(
      { cmd: "/chats", desc: "", order: 2, capability: null, screens: ["workspace"] },
      context([["chat.switch", available]]),
    );
    expect(s.availability).toBe("available");
    expect(s.hint).toBeNull();
  });

  test("/chats is unavailable when chat.switch has not been published (the missing-capability convention)", () => {
    const s = slashRowState(
      { cmd: "/chats", desc: "", order: 2, capability: null, screens: ["workspace"] },
      context(),
    );
    expect(s.availability).toBe("unavailable");
  });

  // Design is unambiguous here: `commandRegistry` (design/termcraft-engine.js:928) gives
  // `/chats` the SAME `lock:'locked · turn running'` as `/new`, and `wsSlashTurn` (`:1004`)
  // draws it locked. REVIEW ROUND 1 (CRITICAL): a first pass had this test asserting `/chats`
  // stays available during a turn — reading `turn-lock.ts:25-26`'s "local slash-command mode...
  // no Kernel command at all" as covering this row, when that line is about the `/` INPUT MODE,
  // not `/chats` itself. `chat.switch` (the command `/chats` exists to reach) IS one of §10.4's
  // `TURN_LOCKED_KINDS`, so this row locks on that capability's own published state.
  test("/chats locks during a turn — it reads chat.switch's published TURN_RUNNING state, matching design", () => {
    const running = context([["chat.switch", turnRunning]], { turnRunning: true });
    expect(
      slashRowState(
        { cmd: "/chats", desc: "", order: 2, capability: null, screens: ["workspace"] },
        running,
      ).availability,
    ).toBe("locked");
  });

  test("/export locks on its own published TURN_RUNNING state, and a commit row is not turn-locked at all", () => {
    const running = context([["export.start", turnRunning]], { turnRunning: true });
    const exportRow = slashRowState(
      { cmd: "/export", desc: "", order: 3, capability: "export.start", screens: ["workspace"] },
      running,
    );
    expect(exportRow.availability).toBe("locked");
    // A commit row is not turn-locked (its own deferred capability still marks it unavailable).
    const commit = slashRowState(
      {
        cmd: "/commit-page",
        desc: "",
        order: 5,
        capability: "commit.plan",
        screens: ["workspace"],
      },
      context([["commit.plan", deferred]], { turnRunning: true }),
    );
    expect(commit.availability).toBe("unavailable");
    expect(commit.hint).toEqual({ code: "CAPABILITY_UNAVAILABLE" });
  });

  // finding §2.5 (phase-8 Task 16): `/exit` — the local action the finding names by name — stays
  // available while a turn runs. Unlike `/chats`, `/exit` really is turn-safe: design
  // (`design/termcraft-engine.js:934`) lists it with no `lock` at all, and it dispatches no
  // Kernel command whatsoever (`execution: {kind:"local", effect:"exit"}` — `requestExit()`, not
  // a `dispatcher.dispatch(...)` call). It is the one command a user with a stuck turn most wants
  // reachable.
  test("locks rows individually — /exit stays available while a turn runs", () => {
    const running = context([["chat.create", turnRunning]], { turnRunning: true });
    const exitRow = slashRowState(
      {
        cmd: "/exit",
        desc: "quit termcraft",
        order: 8,
        capability: null,
        screens: ["workspace", "home"],
      },
      running,
    );
    expect(exitRow.availability).toBe("available");
    const newRow = slashRowState(
      { cmd: "/new", desc: "", order: 1, capability: "chat.create", screens: ["workspace"] },
      running,
    );
    expect(newRow.availability).toBe("locked");
  });

  test("separates kernel-locked from unavailable (design slashBox :948-949)", () => {
    const running = context([["chat.create", turnRunning]], { turnRunning: true });
    const lockedNew = slashRowState(
      { cmd: "/new", desc: "", order: 1, capability: "chat.create", screens: ["workspace"] },
      running,
    );
    expect(lockedNew.availability).toBe("locked");

    const idleNoCap = context();
    const unavailableExport = slashRowState(
      { cmd: "/export", desc: "", order: 3, capability: "export.start", screens: ["workspace"] },
      idleNoCap,
    );
    expect(unavailableExport.availability).toBe("unavailable");

    const idle = context([["chat.create", available]], { turnRunning: false });
    const availableNew = slashRowState(
      { cmd: "/new", desc: "", order: 1, capability: "chat.create", screens: ["workspace"] },
      idle,
    );
    expect(availableNew.availability).toBe("available");
  });

  test("unavailable outranks locked when both apply (design slashRows :943-945: `_un` checked before `_lk`)", () => {
    // The first turn in a fresh project: no pages yet, so export.start is unavailable for its
    // own reason (NO_PAGES) *and* the turn is running. The row must report the real, permanent
    // reason — not "locked", which would misleadingly promise it comes back once the turn ends.
    const s = slashRowState(
      { cmd: "/export", desc: "", order: 3, capability: "export.start", screens: ["workspace"] },
      context([["export.start", noPages]], { turnRunning: true }),
    );
    expect(s.availability).toBe("unavailable");
    expect(s.hint).toEqual({ code: "NO_PAGES" });
  });
});

describe("filterSlashRows", () => {
  test('"/" shows all eight rows in order (the seven design rows plus /exit)', () => {
    const rows = filterSlashRows("/", context());
    expect(rows).toHaveLength(8);
    expect(rows[0]?.command.cmd).toBe("/new");
    expect(rows.at(-1)?.command.cmd).toBe("/exit");
  });

  test('a longer prefix keeps only matching commands ("/ch" -> /chats)', () => {
    const rows = filterSlashRows("/ch", context());
    expect(rows.map((r) => r.command.cmd)).toEqual(["/chats"]);
  });

  test('"/commit" keeps the three commit rows', () => {
    const rows = filterSlashRows("/commit", context([["commit.plan", deferred]]));
    expect(rows.map((r) => r.command.cmd)).toEqual([
      "/commit-page",
      "/commit-infra",
      "/commit-all",
    ]);
  });

  test("firstEnabledIndex finds the first available row", () => {
    const rows = filterSlashRows(
      "/",
      context([["chat.create", available]], { turnRunning: false }),
    );
    // /new (chat.create) is available and is index 0, so it wins regardless of any other row's
    // state — this fixture does not publish chat.switch, so /chats itself reads unavailable here.
    expect(firstEnabledIndex(rows)).toBe(0);
  });
});

// §3.10, phase-8 Task 17 (finding §2.4): Home's applicable set is small — design's own
// `commandRegistry` marks exactly `/model` and `/exit` `home:true` (`termcraft-engine.js:930,
// 934`), and `slashRows`' `o.scope==='home'` filter (`:941`) hides everything else, matching
// §3.10's "a command meaningless on the current screen is hidden."
describe("filterSlashRows — Home scope (§3.10, phase-8 Task 17)", () => {
  test("shows only the commands meaningful on Home, in design order", () => {
    const rows = filterSlashRows("/", context([], { screen: "home" }));
    expect(rows.map((r) => r.command.cmd)).toEqual(["/model", "/exit"]);
    expect(rows[0]?.state.availability).toBe("unavailable"); // /model is v1.0
    expect(rows[1]?.state.availability).toBe("available"); // /exit is the working row
  });

  // CORRECTED (design discrepancy found while implementing this task, verified at the source):
  // the brief's own citation for this case is design `home('slash-none')`, whose comment reads
  // "no row matches" for `typed='/mo'` (`termcraft-engine.js:137`) — but `/model` genuinely
  // STARTS WITH "/mo" ("/model".indexOf("/mo") === 0), so the design engine's own `slashRows()`
  // (`:939-941`, prefix filter then home-scope filter) actually returns ONE row (`/model`) for
  // that input, contradicting its own "no match" label. This is a bug in the design's demo data,
  // not a reason to weaken the real rule (§3.10: "when a filter matches nothing, the menu does
  // not open"), which this asserts with a prefix that genuinely matches nothing Home-scoped:
  // `/co` matches the `/commit-*` family on the FULL registry, but none of those are home:true,
  // so it demonstrates the screen filter doing exactly the work §3.10 describes.
  test("does not open when nothing Home-scoped matches — / stays literal text (design home('slash-none'))", () => {
    const rows = filterSlashRows("/co", context([], { screen: "home" }));
    expect(rows).toEqual([]);
  });

  test("a Workspace-only command never appears on Home even with a matching prefix", () => {
    const rows = filterSlashRows("/e", context([], { screen: "home" }));
    // "/e" matches /export (Workspace-only) and /exit (both screens) on the full registry —
    // Home keeps only /exit.
    expect(rows.map((r) => r.command.cmd)).toEqual(["/exit"]);
  });

  test("Home's /model reports CAPABILITY_UNAVAILABLE regardless of any published capability, unlike Workspace", () => {
    const homeRow = slashRowState(
      {
        cmd: "/model",
        desc: "",
        order: 4,
        capability: "model.select",
        screens: ["workspace", "home"],
      },
      context([["model.select", available]], { screen: "home" }),
    );
    expect(homeRow).toEqual({
      visible: true,
      availability: "unavailable",
      hint: { code: "CAPABILITY_UNAVAILABLE" },
    });
    // Workspace is untouched: it reads the plain inert-row path, which for this fixture (no
    // published reason for `model.select`, since only "available" was published above under a
    // key this context lookup will still find) is unavailable with no hint — the Home-only
    // branch never fires there.
    const workspaceRow = slashRowState(
      {
        cmd: "/model",
        desc: "",
        order: 4,
        capability: "model.select",
        screens: ["workspace", "home"],
      },
      context([["model.select", available]], { screen: "workspace" }),
    );
    expect(workspaceRow).toEqual({ visible: true, availability: "unavailable", hint: null });
  });
});

describe("resolveHotkey", () => {
  test("resolves canonical keys case-insensitively", () => {
    expect(resolveHotkey("F2")?.id).toBe("preview.fullscreen");
    expect(resolveHotkey("ctrl+e")?.capability).toBe("export.start");
  });

  test("F3/F4/Ctrl+P are inert", () => {
    expect(resolveHotkey("f3")?.inert).toBe(true);
    expect(resolveHotkey("f4")?.inert).toBe(true);
    expect(resolveHotkey("ctrl+p")?.inert).toBe(true);
  });

  test("an unknown key resolves to null", () => {
    expect(resolveHotkey("x")).toBeNull();
  });

  test("page stepping resolves from both its canonical key and its arrow alias", () => {
    expect(resolveHotkey("ctrl+b")?.id).toBe("page.prev");
    expect(resolveHotkey("ctrl+n")?.id).toBe("page.next");
    expect(resolveHotkey("ctrl+left")?.id).toBe("page.prev");
    expect(resolveHotkey("ctrl+right")?.id).toBe("page.next");
  });
});
