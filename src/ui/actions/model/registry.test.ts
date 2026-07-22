import { describe, expect, test } from "bun:test";

import type { CommandKindV1 } from "core/protocol";
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
      ["preview.tweaks", { kind: "inert" }],
      ["preview.interact", { kind: "inert" }],
      ["export.start", { kind: "command", command: "export.start" }],
      ["model.select", { kind: "inert" }],
      ["commit.page", { kind: "inert" }],
      ["commit.infra", { kind: "inert" }],
      ["commit.all", { kind: "inert" }],
      ["preview.controls", { kind: "inert" }],
    ]);
  });

  test("matches design's commandRegistry order and mapping", () => {
    expect(SLASH_COMMANDS.map((c) => c.cmd)).toEqual([
      "/new",
      "/chats",
      "/export",
      "/model",
      "/commit-page",
      "/commit-infra",
      "/commit-all",
    ]);
    expect(SLASH_COMMANDS.find((c) => c.cmd === "/chats")?.capability).toBeNull();
    expect(SLASH_COMMANDS.find((c) => c.cmd === "/export")?.capability).toBe("export.start");
  });
});

describe("slashRowState", () => {
  test("an available capability -> enabled, not dimmed, no hint", () => {
    const s = slashRowState(
      { cmd: "/export", desc: "", order: 3, capability: "export.start" },
      context([["export.start", available]]),
    );
    expect(s).toEqual({ visible: true, enabled: true, dimmed: false, hint: null });
  });

  test("an unavailable capability -> dimmed with the primary reason as hint", () => {
    const s = slashRowState(
      { cmd: "/export", desc: "", order: 3, capability: "export.start" },
      context([["export.start", noPages]]),
    );
    expect(s.enabled).toBe(false);
    expect(s.dimmed).toBe(true);
    expect(s.hint).toEqual({ code: "NO_PAGES" });
  });

  test("a deferred (Tier-C) commit row is always dimmed with CAPABILITY_UNAVAILABLE", () => {
    const s = slashRowState(
      { cmd: "/commit-page", desc: "", order: 5, capability: "commit.plan", dot: true },
      context([["commit.plan", deferred]]),
    );
    expect(s.enabled).toBe(false);
    expect(s.hint).toEqual({ code: "CAPABILITY_UNAVAILABLE" });
  });

  test("/model and every commit action stay visible but inert even if capability is available", () => {
    const model = slashRowState(
      { cmd: "/model", desc: "", order: 4, capability: "model.select" },
      context([["model.select", available]]),
    );
    const commit = slashRowState(
      { cmd: "/commit-page", desc: "", order: 5, capability: "commit.plan" },
      context([["commit.plan", available]]),
    );
    expect(model).toMatchObject({ visible: true, enabled: false, dimmed: true });
    expect(commit).toMatchObject({ visible: true, enabled: false, dimmed: true });
  });

  test("a missing capability is treated as unavailable", () => {
    const s = slashRowState(
      { cmd: "/export", desc: "", order: 3, capability: "export.start" },
      context(),
    );
    expect(s.enabled).toBe(false);
  });

  test("a null-capability row (/chats) is enabled when no turn runs", () => {
    const s = slashRowState({ cmd: "/chats", desc: "", order: 2, capability: null }, context());
    expect(s.enabled).toBe(true);
    expect(s.hint).toBeNull();
  });

  test("while a turn runs, every non-commit row dims — including /chats", () => {
    const running = context([["export.start", available]], { turnRunning: true });
    expect(
      slashRowState({ cmd: "/chats", desc: "", order: 2, capability: null }, running).enabled,
    ).toBe(false);
    expect(
      slashRowState({ cmd: "/export", desc: "", order: 3, capability: "export.start" }, running)
        .enabled,
    ).toBe(false);
    // A commit row is not turn-locked (its own deferred capability still dims it).
    const commit = slashRowState(
      { cmd: "/commit-page", desc: "", order: 5, capability: "commit.plan" },
      context([["commit.plan", deferred]], { turnRunning: true }),
    );
    expect(commit.hint).toEqual({ code: "CAPABILITY_UNAVAILABLE" });
  });
});

describe("filterSlashRows", () => {
  test('"/" shows all seven rows in order', () => {
    const rows = filterSlashRows("/", context());
    expect(rows).toHaveLength(7);
    expect(rows[0]?.command.cmd).toBe("/new");
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

  test("firstEnabledIndex finds the first non-disabled row", () => {
    const rows = filterSlashRows(
      "/",
      context([["chat.create", available]], { turnRunning: false }),
    );
    // /new (chat.create) is available; /chats is enabled too. First enabled is index 0 (/new).
    expect(firstEnabledIndex(rows)).toBe(0);
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
});
