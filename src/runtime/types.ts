/**
 * Palette theme id bound at page level via `meta.theme` (§5.4). MVP ships
 * `dark-default` only; `light-default` arrives in v1.0.
 */
export type ThemeId = "dark-default"

/** A terminal-cell size (columns × rows). */
export interface Size {
  readonly w: number
  readonly h: number
}

/**
 * The themed token palette a page renders against (runtime-api §5.4). Token NAMES
 * are the stable contract the design-system components bind to; the concrete hues
 * belong to the resolved `ThemeId`. Every value is a lowercase `#rrggbb` string.
 */
export interface ThemeTokens {
  readonly background: string
  readonly surface: string
  readonly surfaceMuted: string
  readonly foreground: string
  readonly foregroundMuted: string
  readonly border: string
  readonly accent: string
  readonly success: string
  readonly warning: string
  readonly danger: string
}

/**
 * A page's static metadata (§5.1). Authored through `definePage`; the Gate
 * reads this shape from the call's object literal without executing the page.
 * This type is deliberately independent of termcraft's internal `PageMeta`
 * (`entities/page`) so the runtime facade stays a leaf that leaks no internal
 * module identity into authored pages (runtime-api §3.3).
 */
export interface PageMeta {
  /** Positive integer runtime-API compatibility identity (§7.1). */
  readonly kitApiVersion: number
  /** Tab label and the page's display name. */
  readonly title: string
  /** Smallest export size and the status-bar warning threshold. */
  readonly minSize: Size
  /** Token palette (§5.4). */
  readonly theme: ThemeId
}
