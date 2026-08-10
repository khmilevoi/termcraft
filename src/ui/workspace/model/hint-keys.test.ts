import { describe, expect, test } from "bun:test";

import type { TurnMirror } from "ui/mirror";

import { hintKeys } from "./hint-keys";

const IDLE: TurnMirror = { phase: "idle" };
const LIVE_CHAT = { following: true, atStart: false, olderPageFailed: false } as const;
const stateOf = (keys: readonly (readonly [string, string, (true | "dis")?])[], glyph: string) =>
  keys.find((entry) => entry[0] === glyph)?.[2];

describe("hintKeys — the row does not reflow, only its states change (§8)", () => {
  test("chat-scoped hints render dis while the zone is the preview", () => {
    const preview = hintKeys(IDLE, false, null, LIVE_CHAT, "preview");
    expect(stateOf(preview, "PgUp")).toBe("dis");
    expect(stateOf(preview, "PgDn")).toBe("dis");
  });

  test("the same hints are live while the zone is the chat", () => {
    const chat = hintKeys(IDLE, false, null, LIVE_CHAT, "chat");
    expect(stateOf(chat, "PgUp")).toBeUndefined();
    expect(stateOf(chat, "PgDn")).toBeUndefined();
  });

  // The rejected alternative was "a hint row that changes with focus". The SET of keys must be
  // identical in both zones — same entries, same order — with only their state differing.
  test("the set of keys and their order are identical in both zones", () => {
    const chat = hintKeys(IDLE, false, null, LIVE_CHAT, "chat");
    const preview = hintKeys(IDLE, false, null, LIVE_CHAT, "preview");
    expect(preview.map((entry) => [entry[0], entry[1]])).toEqual(
      chat.map((entry) => [entry[0], entry[1]]),
    );
  });

  test("global hints are never dimmed by the zone", () => {
    const preview = hintKeys(IDLE, false, null, LIVE_CHAT, "preview");
    expect(stateOf(preview, "F2")).toBeUndefined();
    expect(stateOf(preview, "^E")).toBeUndefined();
  });

  test("inert keys keep their own dis in both zones", () => {
    for (const zone of ["chat", "preview"] as const) {
      expect(stateOf(hintKeys(IDLE, false, null, LIVE_CHAT, zone), "F3")).toBe("dis");
      expect(stateOf(hintKeys(IDLE, false, null, LIVE_CHAT, zone), "F4")).toBe("dis");
    }
  });

  test("the page steps never enter the row — the design draws no page key", () => {
    for (const zone of ["chat", "preview"] as const) {
      const row = hintKeys(IDLE, false, null, LIVE_CHAT, zone);
      expect(row.map((entry) => entry[0])).not.toContain("Ctrl+LEFT");
      expect(row.map((entry) => entry[0])).not.toContain("Ctrl+B");
    }
  });

  test("fullscreen still returns the single windowed hint", () => {
    expect(hintKeys(IDLE, true, null, LIVE_CHAT, "preview")).toEqual([["F2", "windowed"]]);
  });

  test("a running turn scrolled away keeps the scroll trio, dis'd by zone like any other", () => {
    const scrolled = { following: false, atStart: false, olderPageFailed: false } as const;
    const running: TurnMirror = {
      phase: "running",
      turnId: "0198f000-0000-7000-8000-000000000000",
      attempt: 1,
      deadline: null,
      timeline: [],
      startedAt: 0,
      finalText: null,
      errorText: null,
      usage: null,
      gateRetries: [],
    };
    const row = hintKeys(running, false, null, scrolled, "preview");
    expect(stateOf(row, "PgUp")).toBe("dis");
    // `Ctrl+D`, not `^D`: `hotkeyGlyph` special-cases only `ctrl+e`, and
    // `Workspace.test.tsx:783` already pins that the status row spells this one out.
    expect(stateOf(row, "Ctrl+D")).toBe("dis");
    expect(row.map((entry) => entry[0])).toContain("esc");
  });
});
