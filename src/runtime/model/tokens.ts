import type { ThemeId, ThemeTokens } from "../types";

/**
 * The one theme id the COMPILED SEED carries. Deliberately NOT {@link ThemeId}, which spec §4.6
 * widened to `string` because a project's theme names live in its own manifest: a
 * `Record<ThemeId, …>` would become an index signature and, under this repository's
 * `noUncheckedIndexedAccess: true`, make {@link themeTokens} return `TokenMap | undefined` —
 * breaking three call sites outside this module for no gain. The seed registry is a closed,
 * one-member thing and says so in its own type.
 */
export type SeedThemeId = "dark-default";

/**
 * The `dark-default` palette (runtime-api §5.4). These are the design system's
 * REAL hues, taken 1:1 from `design/termcraft-engine.js`'s `pal` object (a warm
 * amber-on-near-black terminal theme) — not a placeholder. Every token is a
 * lowercase `#rrggbb` string, the true-color form OpenTUI accepts and the render
 * layer emits (Spike B). MVP ships this theme only; the design also defines a
 * `lightPal()` (bg #efe9dc, fg #33302a, amber #a8701a, …) that a `light-default`
 * theme will carry in v1.0.
 */
const DARK_DEFAULT: ThemeTokens = {
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
};

const THEMES: Record<SeedThemeId, ThemeTokens> = {
  "dark-default": DARK_DEFAULT,
};

/** Resolve a theme id to its token palette (§5.4). Closed to the declared `ThemeId`. */
export function themeTokens(id: SeedThemeId): ThemeTokens {
  return THEMES[id];
}

/** The default theme every MVP page renders against until a theme override lands. */
export const DEFAULT_THEME_ID: SeedThemeId = "dark-default";

/**
 * The active theme's tokens for a component to render against. MVP resolves the
 * single `dark-default` theme; this is the seam a theme context / preview-override
 * atom (§6) replaces later, so components never hard-code hues — they call this.
 */
export function activeTokens(): ThemeTokens {
  return themeTokens(DEFAULT_THEME_ID);
}
