import { describe, expect, test } from "bun:test";

import { DesignSystemPackageInvalidError } from "./errors";
import { readDesignSystemSummary } from "./summary";

const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

/** The §3.2 sample manifest, trimmed to what a summary reads plus one field it must ignore. */
const MANIFEST = {
  schemaVersion: 1,
  id: "midnight",
  name: "Midnight",
  version: "1.2.0",
  kitApiVersion: 1,
  defaultTheme: "dark",
  themes: {
    dark: {
      label: "Midnight Dark",
      tokens: {
        background: "#0b0f14",
        surface: "#131a24",
        accent: "#4cc9f0",
        brandBlue: "#4cc9f0",
      },
    },
  },
  components: [
    { name: "Button", module: "components/Button.tsx", export: "Button" },
    { name: "PageShell", module: "components/PageShell.tsx", export: "PageShell" },
  ],
};

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
    expect(summary.defaultThemeTokens).toEqual([
      { name: "background", value: "#0b0f14" },
      { name: "surface", value: "#131a24" },
      { name: "accent", value: "#4cc9f0" },
      { name: "brandBlue", value: "#4cc9f0" },
    ]);
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

describe("readDesignSystemSummary — what it deliberately does NOT judge (P2 owns §7)", () => {
  test("a theme missing core roles still summarizes — parity and core roles are Gate fatals", () => {
    const summary = read({
      ...MANIFEST,
      themes: { dark: { label: "d", tokens: { accent: "#4cc9f0" } } },
    });
    expect(summary).not.toBeInstanceOf(Error);
  });

  test("a non-hex token value still summarizes — the value shape is a Gate fatal", () => {
    const summary = read({
      ...MANIFEST,
      themes: { dark: { label: "d", tokens: { accent: "rebeccapurple" } } },
    });
    if (summary instanceof Error) throw summary;
    expect(summary.defaultThemeTokens).toEqual([{ name: "accent", value: "rebeccapurple" }]);
  });

  test("an unsupported kitApiVersion still summarizes — support is a Gate fatal", () => {
    expect(read({ ...MANIFEST, kitApiVersion: 99 })).not.toBeInstanceOf(Error);
  });

  test("a second theme is ignored rather than compared — cross-theme parity is a Gate fatal", () => {
    const summary = read({
      ...MANIFEST,
      themes: {
        dark: MANIFEST.themes.dark,
        light: { label: "l", tokens: { onlyHere: "#ffffff" } },
      },
    });
    if (summary instanceof Error) throw summary;
    expect(summary.defaultThemeTokens.map((token) => token.name)).not.toContain("onlyHere");
  });
});

describe("readDesignSystemSummary — rejections", () => {
  test("rejects unparseable JSON", () => {
    expect(readDesignSystemSummary(utf8("{ not json"), "m.json")).toBeInstanceOf(
      DesignSystemPackageInvalidError,
    );
  });

  test("rejects a manifest missing a field the picker needs", () => {
    for (const field of ["id", "name", "version", "kitApiVersion", "defaultTheme", "themes"]) {
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
