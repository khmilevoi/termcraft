import { describe, expect, test } from "bun:test";

import { DARK_DEFAULT, DEFAULT_THEME_ID } from "runtime/model/tokens";

import { CORE_TOKEN_ROLES } from "../types";
import { decodeDesignSystemManifest } from "./manifest";
import { renderDesignSystemManifest } from "./scaffold";
import { SEED_THEME_ID, SEED_TOKENS, createSeedManifest } from "./seed";

describe("the seed palette (design-systems §4.6, §9)", () => {
  // D3's drift guard, stronger than a key comparison: the seventeen VALUES must be byte-identical
  // to the compiled seed, which is itself 1:1 with `design/termcraft-engine.js`'s `pal`.
  test("SEED_TOKENS equals runtime's DARK_DEFAULT exactly", () => {
    expect(SEED_TOKENS).toEqual({ ...DARK_DEFAULT });
  });

  test("SEED_THEME_ID equals runtime's DEFAULT_THEME_ID", () => {
    expect(SEED_THEME_ID).toBe(DEFAULT_THEME_ID);
  });

  test("the seed declares every core role and nothing else", () => {
    expect(Object.keys(SEED_TOKENS).sort()).toEqual([...CORE_TOKEN_ROLES].sort());
  });

  test("every seed value is a lowercase #rrggbb", () => {
    for (const value of Object.values(SEED_TOKENS)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("createSeedManifest", () => {
  test("the rendered seed manifest decodes through the real decoder", () => {
    const manifest = createSeedManifest({ kitApiVersion: 1 });
    const decoded = decodeDesignSystemManifest(renderDesignSystemManifest(manifest));
    expect(decoded).not.toBeInstanceOf(Error);
    if (decoded instanceof Error) return;
    expect(decoded).toEqual(manifest);
  });

  test("the seed's defaultTheme names its one declared theme", () => {
    const manifest = createSeedManifest({ kitApiVersion: 1 });
    expect(manifest.defaultTheme).toBe(SEED_THEME_ID);
    expect(Object.keys(manifest.themes)).toEqual([SEED_THEME_ID]);
  });

  test("the seed declares no components", () => {
    expect(createSeedManifest({ kitApiVersion: 1 }).components).toEqual([]);
  });

  test("the kitApiVersion is the caller's, never a literal", () => {
    expect(createSeedManifest({ kitApiVersion: 7 }).kitApiVersion).toBe(7);
  });
});
