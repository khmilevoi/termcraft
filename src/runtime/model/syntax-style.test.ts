import { describe, expect, test } from "bun:test";

import { activeSyntaxStyle, buildSyntaxStyle, syntaxScopeStyles } from "./syntax-style";
import { DARK_DEFAULT, DEFAULT_THEME_ID, seedThemeCapability } from "./tokens";

/**
 * The mapping this asserts is plan P8's Decision D1 — a FLAGGED design gap, resolved from the
 * design's own emphasis hierarchy because the design system covers no code display at all.
 * If this table ever changes, D1's justification column is what has to change with it.
 */
describe("the theme → syntax-scope mapping (plan P8 D1)", () => {
  const t = DARK_DEFAULT;
  const styles = syntaxScopeStyles(t);

  test("the neutral ramp carries content, structure and asides", () => {
    expect(styles["default"]?.fg).toBe(t.foreground);
    expect(styles["variable"]?.fg).toBe(t.foreground);
    expect(styles["property"]?.fg).toBe(t.foreground);
    expect(styles["embedded"]?.fg).toBe(t.foreground);
    expect(styles["operator"]?.fg).toBe(t.foregroundMuted);
    expect(styles["label"]?.fg).toBe(t.foregroundMuted);
    expect(styles["module"]?.fg).toBe(t.foregroundMuted);
    expect(styles["attribute"]?.fg).toBe(t.foregroundMuted);
    expect(styles["punctuation"]?.fg).toBe(t.foregroundFaint);
    expect(styles["comment"]?.fg).toBe(t.foregroundFaint);
    expect(styles["conceal"]?.fg).toBe(t.foregroundFaint);
  });

  test("the accent family carries emphasis, and literals are muted accent — never green", () => {
    expect(styles["keyword"]?.fg).toBe(t.accent);
    expect(styles["function"]?.fg).toBe(t.accentHi);
    expect(styles["constructor"]?.fg).toBe(t.accentHi);
    expect(styles["type"]?.fg).toBe(t.accentHi);
    for (const literal of ["string", "number", "boolean", "constant", "character"]) {
      expect(styles[literal]?.fg).toBe(t.accentDim);
    }
    // The design reserves green for "healthy/complete" and red for failure. A string is
    // neither. This assertion is the guard against the mainstream-editor reflex.
    expect(styles["string"]?.fg).not.toBe(t.success);
  });

  test("every markdown heading LEVEL is registered, because fallback goes to the first segment", () => {
    // `SyntaxStyle.getStyleId` splits on "." and takes segment [0], so `markup.heading.1`
    // would resolve to `markup` — not to `markup.heading`. Registering the levels is the only
    // way a heading renders as a title.
    for (const scope of [
      "markup.heading",
      "markup.heading.1",
      "markup.heading.2",
      "markup.heading.3",
      "markup.heading.4",
      "markup.heading.5",
      "markup.heading.6",
    ]) {
      expect(styles[scope]?.fg).toBe(t.accent);
      expect(styles[scope]?.bold).toBe(true);
    }
  });

  test("markup inline scopes follow the design's bold-not-hue emphasis, and italic diverges", () => {
    expect(styles["markup"]?.fg).toBe(t.foreground);
    expect(styles["markup.strong"]).toEqual({ fg: t.foreground, bold: true });
    // DIVERGENCE (documented in the module): the design's cell model has bold and blink and no
    // italic, so italic is outside its vocabulary; the secondary tier is the faithful reading.
    expect(styles["markup.italic"]?.fg).toBe(t.foregroundMuted);
    expect(styles["markup.italic"]?.italic).toBeUndefined();
    expect(styles["markup.strikethrough"]?.fg).toBe(t.foregroundFaint);
    expect(styles["markup.raw"]?.fg).toBe(t.accentDim);
    expect(styles["markup.raw.block"]?.fg).toBe(t.accentDim);
    expect(styles["markup.link"]?.fg).toBe(t.accent);
    expect(styles["markup.link.label"]?.fg).toBe(t.accent);
    expect(styles["markup.link.url"]?.fg).toBe(t.foregroundMuted);
    expect(styles["markup.quote"]?.fg).toBe(t.foregroundMuted);
    expect(styles["markup.list"]?.fg).toBe(t.foregroundMuted);
    expect(styles["markup.list.unchecked"]?.fg).toBe(t.foregroundMuted);
    // The ONE status hue: the engine's green ✓ means "done" everywhere it appears.
    expect(styles["markup.list.checked"]?.fg).toBe(t.success);
  });

  test("spell markers are deliberately unregistered so they fall through to default", () => {
    expect(styles["spell"]).toBeUndefined();
    expect(styles["nospell"]).toBeUndefined();
    expect(styles["none"]).toBeUndefined();
  });

  test("no hue is invented — every registered fg is one of the active theme's own values", () => {
    const declared = new Set<string>(Object.values(t));
    for (const [scope, style] of Object.entries(styles)) {
      expect({ scope, fg: style.fg }).toEqual({ scope, fg: style.fg });
      // `StyleDefinitionInput.fg` is typed `ColorInput` (`string | RGBA`) by @opentui/core, but
      // this module (`syntaxScopeStyles`) only ever assigns a theme `Color` string to it — the
      // cast reflects that runtime invariant, not a widening of what this test checks.
      if (style.fg !== undefined) expect(declared.has(style.fg as string)).toBe(true);
    }
  });

  test("the mapping follows the ACTIVE theme, not the compiled seed", () => {
    // #4cc9f0 is a synthetic test fixture, not a design colour — the same value
    // `tokens.reactivity.test.tsx` already uses for its MIDNIGHT theme.
    const midnight = { ...DARK_DEFAULT, accent: "#4cc9f0" } as const;
    expect(syntaxScopeStyles(midnight)["keyword"]?.fg).toBe("#4cc9f0");
  });
});

describe("the SyntaxStyle handle", () => {
  test("buildSyntaxStyle registers every scope in the table", () => {
    const built = buildSyntaxStyle(DARK_DEFAULT);
    if (built instanceof Error) throw built;
    const registered = new Set(built.getRegisteredNames());
    for (const scope of Object.keys(syntaxScopeStyles(DARK_DEFAULT))) {
      expect(registered.has(scope)).toBe(true);
    }
    built.destroy();
  });

  test("activeSyntaxStyle is memoised per theme and rebuilt when the theme changes", () => {
    seedThemeCapability({ themeId: DEFAULT_THEME_ID, tokens: DARK_DEFAULT });
    const first = activeSyntaxStyle();
    expect(activeSyntaxStyle()).toBe(first);

    seedThemeCapability({ themeId: "midnight", tokens: { ...DARK_DEFAULT, accent: "#4cc9f0" } });
    expect(activeSyntaxStyle()).not.toBe(first);

    seedThemeCapability({ themeId: DEFAULT_THEME_ID, tokens: DARK_DEFAULT });
  });
});
