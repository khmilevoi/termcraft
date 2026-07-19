import type { ThemeId, ThemeTokens } from "../types"

/**
 * The `dark-default` palette (runtime-api §5.4). MVP ships this theme only;
 * `light-default` arrives in v1.0. Every token is a lowercase `#rrggbb` string,
 * the true-color form OpenTUI accepts and the render layer emits (Spike B). The
 * exact hues are refined against the design system in the phase-7 UI pass; the
 * token NAMES are the stable contract components bind to, not the hues.
 */
const DARK_DEFAULT: ThemeTokens = {
  background: "#0d1117",
  surface: "#161b22",
  surfaceMuted: "#21262d",
  foreground: "#e6edf3",
  foregroundMuted: "#8b949e",
  border: "#30363d",
  accent: "#58a6ff",
  success: "#3fb950",
  warning: "#d29922",
  danger: "#f85149",
}

const THEMES: Record<ThemeId, ThemeTokens> = {
  "dark-default": DARK_DEFAULT,
}

/** Resolve a theme id to its token palette (§5.4). Closed to the declared `ThemeId`. */
export function themeTokens(id: ThemeId): ThemeTokens {
  return THEMES[id]
}

/** The default theme every MVP page renders against until a theme override lands. */
export const DEFAULT_THEME_ID: ThemeId = "dark-default"
