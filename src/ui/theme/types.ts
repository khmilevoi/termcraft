/**
 * The app-shell palette vocabulary (design `pal`, `design/termcraft-engine.js:6-13`).
 *
 * These are the shell's OWN tokens — distinct from `runtime`'s page-facing theme
 * tokens (`runtime/model/tokens.ts`), which colour user-authored design pages. `ui`
 * may not import `runtime` (module DAG, `code-structure.md` item 10), so the shell
 * carries the design `pal`/`lightPal` hexes here verbatim. The shell chrome always
 * renders in the dark palette; the light values are recorded for completeness only
 * (no design source shows the shell itself in light mode — GAP in the chrome map).
 */

/** One shell-palette token name — the exact keys of design's `pal` object. */
export type ShellToken =
  | "bg"
  | "fg"
  | "dim"
  | "faint"
  | "border"
  | "line"
  | "amber"
  | "amberHi"
  | "amberDim"
  | "sel"
  | "selFg"
  | "green"
  | "red"
  | "redDim"
  | "statusBg";

/** A full palette: every {@link ShellToken} mapped to a lowercase `#rrggbb` hex. */
export type ShellPalette = Readonly<Record<ShellToken, `#${string}`>>;

/** The text attributes a shell run can carry (subset of OpenTUI's `TextAttributes`). */
export interface ShellTextStyle {
  readonly bold?: boolean;
  readonly dim?: boolean;
  /** The blinking prompt cursor (`design/14-first-generation.dc.html` `tcblink`). */
  readonly blink?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly inverse?: boolean;
}
