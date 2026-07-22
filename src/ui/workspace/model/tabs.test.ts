import { describe, expect, test } from "bun:test";

import type { PageDescriptorV1 } from "core/protocol";
import { TEST_SHA } from "ui/testing";

import { deriveTabs, tabWidth, tabsOverflow } from "./tabs";

const ready = (slug: string, title: string): PageDescriptorV1 => ({
  status: "ready",
  pageSlug: slug,
  sourceHash: TEST_SHA,
  title,
  minSize: { w: 80, h: 24 },
  theme: "dark-default",
  kitApiVersion: 1,
});

const invalid = (slug: string): PageDescriptorV1 => ({
  status: "invalid",
  pageSlug: slug,
  sourceHash: TEST_SHA,
  error: { code: "GATE", safeMessage: "bad" },
});

describe("deriveTabs", () => {
  test("preserves descriptor order and marks the active page", () => {
    const tabs = deriveTabs([ready("main", "Main"), ready("settings", "Settings")], "main");
    expect(tabs.map((t) => t.pageSlug)).toEqual(["main", "settings"]);
    expect(tabs[0]?.active).toBe(true);
    expect(tabs[1]?.active).toBe(false);
  });

  test("a ready page uses its title; an invalid page falls back to the slug", () => {
    const tabs = deriveTabs([ready("main", "Main"), invalid("login")], "main");
    expect(tabs[0]?.title).toBe("Main");
    expect(tabs[1]?.title).toBe("login");
    expect(tabs[1]?.invalid).toBe(true);
  });

  test("the ghost slug marks a still-generating first page", () => {
    const tabs = deriveTabs([ready("main", "Main")], null, "main");
    expect(tabs[0]?.ghost).toBe(true);
  });
});

describe("tabWidth / tabsOverflow", () => {
  test("active tabs are wider than inactive (the ▸ glyph)", () => {
    expect(
      tabWidth({ pageSlug: "x", title: "Main", active: true, ghost: false, invalid: false }),
    ).toBe(8);
    expect(
      tabWidth({ pageSlug: "x", title: "Main", active: false, ghost: false, invalid: false }),
    ).toBe(7);
  });

  test("overflow is detected when the total exceeds the width", () => {
    const tabs = deriveTabs([ready("a", "Alpha"), ready("b", "Bravo"), ready("c", "Charlie")], "a");
    expect(tabsOverflow(tabs, 100)).toBe(false);
    expect(tabsOverflow(tabs, 10)).toBe(true);
  });
});
