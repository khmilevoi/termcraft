/**
 * A theme id declared by the project's own design system (spec §4.6). It was a closed
 * one-member union while a single `dark-default` palette was compiled into this binary; the
 * truth now lives in the project's `design/system/design-system.json`, and the GATE — not this
 * type — validates a concrete id against that manifest. Widening it here rather than enumerating
 * project names is the whole point: a closed union in the binary would make every project's
 * theme names part of the binary's identity.
 */
export type ThemeId = string;

/**
 * A concrete terminal colour: a lowercase `#rrggbb` string (spec §4.5).
 *
 * TEMPLATE-LITERAL RATHER THAN `string`, ON PURPOSE. A `string` alias would leave
 * `color="foregroundMuted"` compiling, and §4.5 replaces two ways of naming a colour with one:
 * the checked `t.accent` path. §9's migration depends on the old spelling being a fatal
 * `TS2322` that the Gate's warning can attach an exact rewrite to.
 *
 * DIVERGENCE, STATED RATHER THAN SILENTLY SUBSTITUTED: TypeScript cannot express "exactly six
 * lowercase hex digits", so this type checks the `#` prefix and nothing else. The full
 * `#rrggbb` form is enforced where the values ENTER the system — the design-system manifest's
 * Gate schema (§7) — not at every prop site.
 */
export type Color = `#${string}`;

/** A terminal-cell size (columns × rows). */
export interface Size {
  readonly w: number;
  readonly h: number;
}

/**
 * The themed token palette a page renders against (runtime-api §5.4). Token NAMES
 * are the stable contract the design-system components bind to; the concrete hues
 * belong to the resolved `ThemeId`. Every value is a {@link Color}. The NAMES are the
 * mandatory core roles every project theme must declare (spec §4.1) — the component
 * catalog's defaults bind to them; the VALUES are the project's, delivered through
 * {@link TokenMap} at mount.
 *
 * The 17 roles map 1:1 onto the design system's real `termcraft-engine.js` palette
 * (a warm amber-on-near-black terminal theme). `warning` has no dedicated engine
 * hue — amber-highlight is the caution shade — and `statusBg`/`surface` share a hue
 * in dark but stay distinct roles so a future theme can diverge them.
 */
export interface ThemeTokens {
  /** Global terminal background (engine `bg`); also the knocked-out fg on solid amber chips. */
  readonly background: Color;
  /** Elevated fill — status bar, lifted card/input bodies (engine `statusBg`). */
  readonly surface: Color;
  /** Primary body text (engine `fg`). */
  readonly foreground: Color;
  /** Secondary/dim text — labels, metadata, sub-panel titles (engine `dim`). */
  readonly foregroundMuted: Color;
  /** Faintest text — placeholders, disabled/ghost rows, hints, column headers (engine `faint`). */
  readonly foregroundFaint: Color;
  /** Active structural frame — panel borders, pane dividers, gauge track (engine `border`). */
  readonly border: Color;
  /** Subtle/inactive chrome — interior dividers, dimmed frames, quiet-chip bg (engine `line`). */
  readonly line: Color;
  /** Primary accent — prompt/cursor, titles, active tab, ▸ marker, gauge fill (engine `amber`). */
  readonly accent: Color;
  /** Bright emphasis — popup/active titles, selected values, hover borders, warning emphasis (engine `amberHi`). */
  readonly accentHi: Color;
  /** Dimmed amber — generating-state borders, low-emphasis warning (engine `amberDim`). */
  readonly accentDim: Color;
  /** Selected-row background — the back-fill behind the current list/table/pin row (engine `sel`). */
  readonly selection: Color;
  /** Selected-row text — text/columns on the highlighted row (engine `selFg`). */
  readonly selectionFg: Color;
  /** Success/live — ● live, ✓ resolved, sparkline bars (engine `green`). */
  readonly success: Color;
  /** Warning/caution — ⚠ hints, ctx-threshold (engine `amberHi`; no dedicated warning hue). */
  readonly warning: Color;
  /** Error text/border — ✗ failures, invalid input, error modal (engine `red`). */
  readonly danger: Color;
  /** Error-band background — the strip behind a red error message (engine `redDim`). */
  readonly dangerDim: Color;
  /** Status-bar background — bottom row + segment fills (engine `statusBg`). */
  readonly statusBg: Color;
}

// Implementation note: because that manifest-derived read is always a named field, this
// repository's `noUncheckedIndexedAccess` never widens it to `| undefined`. The seventeen core
// roles stay declared PROPERTIES here for the same reason: the catalog's own defaults
// (`activeTokens().border`, `.foreground`, …) must be checked reads, not index accesses.
/**
 * The active theme's whole token map (spec §4.1): the mandatory core roles above, plus any
 * number of token names the project declared. The index signature is what makes a
 * project-declared name expressible at all.
 *
 * A page never indexes this type by a computed string — it reads a named field off its own
 * manifest-derived `Tokens` type (§4.3), where every key is known.
 */
export interface TokenMap extends ThemeTokens {
  readonly [token: string]: Color;
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
  // KNOWN GAP until plan P4 lands: the Gate's own `src/gate/model/page-contract.ts` requires
  // `theme` FIRST (`MISSING_META_FIELD`) — a themeless page never reaches the host. The host
  // child's `pageMetaSchema` (`src/host/session/model/source-mount.ts`) requires it too, SECOND,
  // with `MALFORMED_PROTOCOL`. P4 relaxes both; nothing in the repository omits `theme` today.
  /**
   * The declared theme this page pins to (spec §4.6). OPTIONAL: absent means the project
   * manifest's `defaultTheme`, which is the ordinary case; present, it pins the page to one
   * declared theme. The Gate checks the name against the project's manifest.
   */
  readonly theme?: ThemeId;
}

/**
 * One side of a box frame (spec §6.2). `Box.border` takes `true` for all four, `false` for none,
 * or a list of exactly the sides to draw. termcraft declares this locally rather than re-exporting
 * `@opentui/core`'s `BorderSides`, so an OpenTUI upgrade changes the adapter and not one saved
 * page (§6).
 */
export type BorderSide = "top" | "right" | "bottom" | "left";

/**
 * A complete custom frame glyph set (spec §6.2). All eleven members are required: a partial set
 * would leave a frame drawn half in one alphabet and half in another, which reads as a rendering
 * bug rather than a choice. The four built-in tables `borderStyle` selects
 * (`single`/`double`/`rounded`/`heavy`) each supply exactly these eleven.
 */
export interface BorderGlyphs {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  /** The horizontal run along the top and bottom edges. */
  readonly horizontal: string;
  /** The vertical run along the left and right edges. */
  readonly vertical: string;
  /** T-junctions where an interior rule meets an edge. */
  readonly topT: string;
  readonly bottomT: string;
  readonly leftT: string;
  readonly rightT: string;
  /** The four-way junction where two interior rules cross. */
  readonly cross: string;
}
