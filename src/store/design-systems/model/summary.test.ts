import { describe, expect, test } from "bun:test";

import { validManifestObject } from "entities/design-system/model/manifest.fixture";

import { DesignSystemPackageInvalidError } from "./errors";
import { readDesignSystemSummary } from "./summary";

const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

/** A manifest `decodeDesignSystemManifest` actually accepts — `readDesignSystemSummary` now
 *  decodes through that same decoder, so a fixture the old private schema tolerated but the
 *  decoder rejects (e.g. a theme missing core roles) would fail every "still summarizes" test for
 *  reasons unrelated to what it is testing. `validManifestObject` is the one shared valid manifest
 *  (see its own doc) — used here instead of a second, hand-rolled one. */
const MANIFEST = validManifestObject();
const DEFAULT_THEME = (MANIFEST.themes as Record<string, { label: string; tokens: Record<string, string> }>)
  .dark;

const read = (value: unknown) => readDesignSystemSummary(utf8(JSON.stringify(value)), "m.json");

describe("readDesignSystemSummary — what the picker needs (design §8.1)", () => {
  test("reads identity, version, kit API version and the default theme name", () => {
    const summary = read(MANIFEST);
    if (summary instanceof Error) throw summary;
    expect(summary.id).toBe("midnight");
    expect(summary.name).toBe("Midnight");
    expect(summary.version).toBe("1.2.0");
    expect(summary.kitApiVersion).toBe(1);
    expect(summary.defaultTheme).toBe("dark");
  });

  test("projects the DEFAULT theme's tokens as an ordered list, in declaration order", () => {
    const summary = read(MANIFEST);
    if (summary instanceof Error) throw summary;
    // Built from the fixture's own token map rather than a second hand-typed literal — this still
    // catches a summary that reorders or drops tokens, since `Object.entries` here preserves the
    // manifest's declaration order independently of whatever `readDesignSystemSummary` did.
    expect(summary.defaultThemeTokens).toEqual(
      Object.entries(DEFAULT_THEME.tokens).map(([name, value]) => ({ name, value })),
    );
  });

  test("reads only the component NAMES — never their modules or exports", () => {
    const summary = read(MANIFEST);
    if (summary instanceof Error) throw summary;
    expect(summary.componentNames).toEqual(["Button", "PageShell"]);
  });

  test("a manifest with no components is a system with no components, not a failure", () => {
    const summary = read({ ...MANIFEST, components: [] });
    if (summary instanceof Error) throw summary;
    expect(summary.componentNames).toEqual([]);
  });
});

describe("readDesignSystemSummary — what decodeDesignSystemManifest still leaves to the Gate", () => {
  test("an unsupported kitApiVersion still summarizes — kit-support is checked by gate/model/design-system.ts, not the decoder", () => {
    expect(read({ ...MANIFEST, kitApiVersion: 99 })).not.toBeInstanceOf(Error);
  });
});

describe("readDesignSystemSummary — now rejected because the shared decoder enforces §7 (P2 owns it)", () => {
  test("a theme missing a core role no longer summarizes — §4.1 core-role presence is now checked here too", () => {
    const summary = read({
      ...MANIFEST,
      themes: { dark: { label: "d", tokens: { accent: DEFAULT_THEME.tokens.accent } } },
    });
    expect(summary).toBeInstanceOf(DesignSystemPackageInvalidError);
  });

  test("a non-hex token value no longer summarizes — §4.1's colour-format check is now enforced here too", () => {
    const summary = read({
      ...MANIFEST,
      themes: { dark: { ...DEFAULT_THEME, tokens: { ...DEFAULT_THEME.tokens, accent: "rebeccapurple" } } },
    });
    expect(summary).toBeInstanceOf(DesignSystemPackageInvalidError);
  });

  test("a second theme with mismatched tokens is now rejected outright — §4.2 parity is checked across every theme, not only the default one", () => {
    const summary = read({
      ...MANIFEST,
      themes: {
        dark: DEFAULT_THEME,
        light: { label: "l", tokens: { onlyHere: "#ffffff" } },
      },
    });
    expect(summary).toBeInstanceOf(DesignSystemPackageInvalidError);
  });
});

describe("readDesignSystemSummary — rejections", () => {
  test("rejects unparseable JSON", () => {
    expect(readDesignSystemSummary(utf8("{ not json"), "m.json")).toBeInstanceOf(
      DesignSystemPackageInvalidError,
    );
  });

  test("rejects a manifest missing a field the picker needs", () => {
    for (const field of [
      "schemaVersion",
      "id",
      "name",
      "version",
      "kitApiVersion",
      "defaultTheme",
      "themes",
    ]) {
      const partial: Record<string, unknown> = { ...MANIFEST };
      delete partial[field];
      expect(read(partial)).toBeInstanceOf(DesignSystemPackageInvalidError);
    }
  });

  test("rejects a defaultTheme that names no declared theme — there is no row to draw", () => {
    expect(read({ ...MANIFEST, defaultTheme: "midday" })).toBeInstanceOf(
      DesignSystemPackageInvalidError,
    );
  });

  test("rejects an array-index-like token name, which JavaScript would reorder", () => {
    expect(
      read({ ...MANIFEST, themes: { dark: { label: "d", tokens: { "0": "#000000" } } } }),
    ).toBeInstanceOf(DesignSystemPackageInvalidError);
  });
});
