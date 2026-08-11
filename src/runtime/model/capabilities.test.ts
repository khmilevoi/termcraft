import { afterEach, describe, expect, test } from "bun:test";

import {
  colorDepthAtom,
  defineTweaks,
  hostModeAtom,
  isExport,
  isExportAtom,
  themeCapability,
  usePages,
  viewportSizeAtom,
} from "./capabilities";
import { DARK_DEFAULT, DEFAULT_THEME_ID, seedThemeCapability } from "./tokens";

afterEach(() => {
  hostModeAtom.set("preview");
  seedThemeCapability({ themeId: DEFAULT_THEME_ID, tokens: DARK_DEFAULT });
});

describe("runtime capabilities (§6)", () => {
  test("defineTweaks records the declaration unchanged (dormant MVP)", () => {
    const decl = { density: { kind: "select", options: ["compact", "cozy"] } };
    expect(defineTweaks(decl)).toBe(decl);
  });

  test("isExport reflects the host-scoped mode atom", () => {
    expect(isExport()).toBe(false);
    expect(isExportAtom()).toBe(false);
    hostModeAtom.set("export");
    expect(isExport()).toBe(true);
    expect(isExportAtom()).toBe(true);
  });

  test("themeCapability resolves the ACTIVE theme id + tokens, not a compiled default", () => {
    const seeded = themeCapability();
    expect(seeded.themeId).toBe(DEFAULT_THEME_ID);
    expect(seeded.tokens).toBe(DARK_DEFAULT);

    seedThemeCapability({
      themeId: "midnight",
      tokens: { ...DARK_DEFAULT, accent: "#4cc9f0", brandBlue: "#4cc9f0" },
    });
    const active = themeCapability();
    expect(active.themeId).toBe("midnight");
    expect(active.tokens.accent).toBe("#4cc9f0");
    expect(active.tokens.brandBlue).toBe("#4cc9f0");
  });
});

describe("navigation capability (§6, design §5.5)", () => {
  test("usePages().goTo is a callable, dormant no-op in MVP (M16)", () => {
    const pages = usePages();
    expect(typeof pages.goTo).toBe("function");
    // DORMANT: the host-protocol emission and shell tab switch land in phase 7 —
    // calling it now records/emits nothing observable, so the only current
    // contract is that it is callable and returns nothing.
    expect(pages.goTo("settings")).toBeUndefined();
  });
});

describe("viewport/terminal capability (§6, M17)", () => {
  test("viewportSizeAtom and colorDepthAtom expose fixed MVP defaults", () => {
    expect(viewportSizeAtom()).toEqual({ w: 80, h: 24 });
    expect(colorDepthAtom()).toBe(24);
  });
});
