import { afterEach, describe, expect, test } from "bun:test";

import type { ThemeTokens, TokenMap } from "../types";
import {
  activeTokens,
  DARK_DEFAULT,
  DEFAULT_THEME_ID,
  seedThemeCapability,
  themeIdAtom,
  themeTokens,
  themeTokensAtom,
} from "./tokens";

const HEX = /^#[0-9a-f]{6}$/;

/** The seventeen mandatory core roles (spec §4.1). */
const CORE_ROLES: (keyof ThemeTokens)[] = [
  "background",
  "surface",
  "foreground",
  "foregroundMuted",
  "foregroundFaint",
  "border",
  "line",
  "accent",
  "accentHi",
  "accentDim",
  "selection",
  "selectionFg",
  "success",
  "warning",
  "danger",
  "dangerDim",
  "statusBg",
];

/** A project-shaped theme: the core roles plus a name the binary has never heard of. */
const MIDNIGHT: TokenMap = {
  ...DARK_DEFAULT,
  background: "#0b0f14",
  accent: "#4cc9f0",
  brandBlue: "#4cc9f0",
};

// The atoms are HOST INPUTS with process-wide lifetime; restore the seed after every test so
// ordering never leaks a theme from one case into the next.
afterEach(() => {
  seedThemeCapability({ themeId: DEFAULT_THEME_ID, tokens: DARK_DEFAULT });
});

describe("the compiled seed (spec §4.6 — the scaffold's seed, no longer the palette source)", () => {
  test("DARK_DEFAULT carries every core role as a lowercase #rrggbb value", () => {
    for (const role of CORE_ROLES) expect(DARK_DEFAULT[role]).toMatch(HEX);
  });

  test("the seed accessor resolves the one compiled theme", () => {
    expect(DEFAULT_THEME_ID).toBe("dark-default");
    expect(themeTokens("dark-default")).toBe(DARK_DEFAULT);
    expect(themeTokens(DEFAULT_THEME_ID)).toBe(DARK_DEFAULT);
  });
});

describe("the theme host-input atoms (spec §4.6)", () => {
  test("they default to the seed, so a page renders coherently before the mount seeds", () => {
    expect(themeIdAtom()).toBe(DEFAULT_THEME_ID);
    expect(themeTokensAtom()).toBe(DARK_DEFAULT);
    expect(activeTokens()).toBe(DARK_DEFAULT);
  });

  test("seedThemeCapability moves both atoms in one named transition", () => {
    seedThemeCapability({ themeId: "midnight", tokens: MIDNIGHT });
    expect(themeIdAtom()).toBe("midnight");
    expect(themeTokensAtom()).toBe(MIDNIGHT);
    expect(activeTokens().accent).toBe("#4cc9f0");
  });

  test("a project-declared token beyond the core is readable after a seed", () => {
    seedThemeCapability({ themeId: "midnight", tokens: MIDNIGHT });
    expect(activeTokens().brandBlue).toBe("#4cc9f0");
  });
});
