import { describe, expect, test } from "bun:test";

import { SEED_THEME_ID, createSeedManifest } from "entities/design-system";

import { resolveActiveThemeId } from "./active-theme";

const manifest = { ...createSeedManifest({ kitApiVersion: 1 }), defaultTheme: "dark-default" };
const midnight = {
  ...manifest,
  defaultTheme: "midnight",
  themes: { midnight: { label: "Midnight", tokens: manifest.themes["dark-default"]!.tokens } },
};

describe("resolveActiveThemeId (design-systems §4.6)", () => {
  test("a page's own declared theme wins", () => {
    expect(resolveActiveThemeId({ metaTheme: "midnight", designSystem: midnight })).toBe(
      "midnight",
    );
  });

  test("an absent declaration falls to the manifest's defaultTheme", () => {
    expect(resolveActiveThemeId({ designSystem: midnight })).toBe("midnight");
  });

  test("no design system at all falls to the compiled seed id", () => {
    expect(resolveActiveThemeId({ designSystem: null })).toBe(SEED_THEME_ID);
  });

  test("a declared theme is honoured even with no design system — the Gate owns membership", () => {
    // This function resolves; it does not validate. A `meta.theme` naming an undeclared theme is
    // the Gate's fatal (§7), asserted against the manifest, not silently rewritten here.
    expect(resolveActiveThemeId({ metaTheme: "ghost", designSystem: null })).toBe("ghost");
  });

  test("the result is always a non-empty string — the DTO and the mount spec both require one", () => {
    expect(resolveActiveThemeId({ designSystem: null }).length).toBeGreaterThan(0);
  });
});
