/**
 * Palette theme id bound at page level via `meta.theme` (§5.4). MVP ships
 * `dark-default` only; `light-default` arrives in v1.0.
 */
export type ThemeId = "dark-default";

/** A terminal-cell size (columns × rows). */
export interface Size {
  readonly w: number;
  readonly h: number;
}

/**
 * The themed token palette a page renders against (runtime-api §5.4). Token NAMES
 * are the stable contract the design-system components bind to; the concrete hues
 * belong to the resolved `ThemeId`. Every value is a lowercase `#rrggbb` string.
 *
 * The 17 roles map 1:1 onto the design system's real `termcraft-engine.js` palette
 * (a warm amber-on-near-black terminal theme). `warning` has no dedicated engine
 * hue — amber-highlight is the caution shade — and `statusBg`/`surface` share a hue
 * in dark but stay distinct roles so a future theme can diverge them.
 */
export interface ThemeTokens {
  /** Global terminal background (engine `bg`); also the knocked-out fg on solid amber chips. */
  readonly background: string;
  /** Elevated fill — status bar, lifted card/input bodies (engine `statusBg`). */
  readonly surface: string;
  /** Primary body text (engine `fg`). */
  readonly foreground: string;
  /** Secondary/dim text — labels, metadata, sub-panel titles (engine `dim`). */
  readonly foregroundMuted: string;
  /** Faintest text — placeholders, disabled/ghost rows, hints, column headers (engine `faint`). */
  readonly foregroundFaint: string;
  /** Active structural frame — panel borders, pane dividers, gauge track (engine `border`). */
  readonly border: string;
  /** Subtle/inactive chrome — interior dividers, dimmed frames, quiet-chip bg (engine `line`). */
  readonly line: string;
  /** Primary accent — prompt/cursor, titles, active tab, ▸ marker, gauge fill (engine `amber`). */
  readonly accent: string;
  /** Bright emphasis — popup/active titles, selected values, hover borders, warning emphasis (engine `amberHi`). */
  readonly accentHi: string;
  /** Dimmed amber — generating-state borders, low-emphasis warning (engine `amberDim`). */
  readonly accentDim: string;
  /** Selected-row background — the back-fill behind the current list/table/pin row (engine `sel`). */
  readonly selection: string;
  /** Selected-row text — text/columns on the highlighted row (engine `selFg`). */
  readonly selectionFg: string;
  /** Success/live — ● live, ✓ resolved, sparkline bars (engine `green`). */
  readonly success: string;
  /** Warning/caution — ⚠ hints, ctx-threshold (engine `amberHi`; no dedicated warning hue). */
  readonly warning: string;
  /** Error text/border — ✗ failures, invalid input, error modal (engine `red`). */
  readonly danger: string;
  /** Error-band background — the strip behind a red error message (engine `redDim`). */
  readonly dangerDim: string;
  /** Status-bar background — bottom row + segment fills (engine `statusBg`). */
  readonly statusBg: string;
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
  readonly kitApiVersion: number;
  /** Tab label and the page's display name. */
  readonly title: string;
  /** Smallest export size and the status-bar warning threshold. */
  readonly minSize: Size;
  /** Token palette (§5.4). */
  readonly theme: ThemeId;
}
