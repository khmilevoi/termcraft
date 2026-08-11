import { describe, expect, test } from "bun:test";

import { definePage } from "./model/define-page";
import type { Color, PageMeta, ThemeId, ThemeTokens, TokenMap } from "./types";

describe("the runtime colour model (spec §4.5, §4.6)", () => {
  test("Color accepts a #rrggbb literal and rejects a token name", () => {
    const hue: Color = "#e6a23c";
    // @ts-expect-error — a token NAME is no longer a colour (§4.5). This is the TS2322 the
    // migration diagnostic attaches its rewrite to (§7, §9); if it ever stops firing, every
    // existing page silently keeps compiling against a type that no longer means anything.
    const name: Color = "accent";
    expect(hue).toBe("#e6a23c");
    // Cast for the runtime check only: `name`'s declared type stays `Color` (the whole point of
    // the assertion above), but bun's `toBe<X = T>(expected: NoInfer<X>)` then requires the
    // expected literal to also satisfy `Color`, which `"accent"` by construction does not.
    expect(name as string).toBe("accent");
  });

  test("TokenMap carries the mandatory core roles as named, checked properties", () => {
    const tokens: TokenMap = {
      background: "#14110d",
      surface: "#231d12",
      foreground: "#d7d0c2",
      foregroundMuted: "#8f877a",
      foregroundFaint: "#5b544a",
      border: "#403a2f",
      line: "#2c2820",
      accent: "#e6a23c",
      accentHi: "#f6c163",
      accentDim: "#8a6d33",
      selection: "#392c11",
      selectionFg: "#f6c163",
      success: "#8fb96b",
      warning: "#f6c163",
      danger: "#dd7b60",
      dangerDim: "#4d2a20",
      statusBg: "#231d12",
      // A project-declared token beyond the core (§4.1) — the whole point of the index signature.
      brandBlue: "#4cc9f0",
    };
    // A named core role is a property, not an index access: `noUncheckedIndexedAccess` never
    // widens it to `| undefined`.
    const accent: Color = tokens.accent;
    expect(accent).toBe("#e6a23c");
    expect(tokens.brandBlue).toBe("#4cc9f0");

    // Every TokenMap is a ThemeTokens — the core contract the component defaults bind to.
    const core: ThemeTokens = tokens;
    expect(core.danger).toBe("#dd7b60");
  });

  test("ThemeId is an open string — the project's manifest owns the names now", () => {
    const id: ThemeId = "midnight";
    expect(id).toBe("midnight");
  });

  test("PageMeta.theme is optional; absent means the manifest's defaultTheme", () => {
    const withoutTheme: PageMeta = definePage({
      kitApiVersion: 1,
      title: "Dashboard",
      minSize: { w: 80, h: 24 },
    });
    expect(withoutTheme.theme).toBeUndefined();

    const pinned: PageMeta = definePage({
      kitApiVersion: 1,
      title: "Dashboard",
      minSize: { w: 80, h: 24 },
      theme: "midnight",
    });
    expect(pinned.theme).toBe("midnight");
  });
});
