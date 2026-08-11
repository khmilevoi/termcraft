import { afterEach, describe, expect, test } from "bun:test";

import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import type { Color, TokenMap } from "../types";
import { computed, reatomComponent } from "./reatom";
import { DARK_DEFAULT, DEFAULT_THEME_ID, seedThemeCapability, useTokens } from "./tokens";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  seedThemeCapability({ themeId: DEFAULT_THEME_ID, tokens: DARK_DEFAULT });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const lineText = (frame: { rows: { text: string }[][] }, row: number) =>
  (frame.rows[row] ?? []).map((run) => run.text).join("");

/** A project-declared theme: the core roles, one overridden hue, one name the binary never had. */
const MIDNIGHT: TokenMap = { ...DARK_DEFAULT, accent: "#4cc9f0", brandBlue: "#4cc9f0" };

/** The shape a project's own `design/system/tokens.ts` binds (spec §4.3). */
interface ProjectTokens extends TokenMap {
  readonly brandBlue: Color;
}

describe("useTokens (spec §4.6)", () => {
  test("returns the active theme's map, and its generic binds a project's own shape", () => {
    expect(useTokens<TokenMap>()).toBe(DARK_DEFAULT);
    seedThemeCapability({ themeId: "midnight", tokens: MIDNIGHT });
    // No cast at the CALL site — that is what the generic buys (§4.6).
    const t = useTokens<ProjectTokens>();
    expect(t.brandBlue).toBe("#4cc9f0");
    expect(t.accent).toBe("#4cc9f0");
  });

  test("the read is TRACKED, not a snapshot — a computed over it recomputes after a seed", () => {
    const probe = computed(() => useTokens().accent, "test.useTokens.accent");
    expect(probe()).toBe("#e6a23c");
    seedThemeCapability({ themeId: "midnight", tokens: MIDNIGHT });
    expect(probe()).toBe("#4cc9f0");
  });

  test("a page component re-renders when the theme is seeded (the §4.6 reactive read)", async () => {
    const Page = reatomComponent(() => <text>{`accent=${useTokens().accent}`}</text>, "test.Page");
    const handle = await createHeadlessRenderer({ w: 24, h: 1 });
    open = handle;
    handle.mount(<Page />);
    await handle.render();
    expect(lineText(handle.capture(), 0)).toContain("accent=#e6a23c");

    seedThemeCapability({ themeId: "midnight", tokens: MIDNIGHT });
    await tick();
    await handle.render();
    expect(lineText(handle.capture(), 0)).toContain("accent=#4cc9f0");
  });
});
