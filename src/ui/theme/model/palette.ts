import { TextAttributes } from "@opentui/core";

import type { ShellPalette, ShellTextStyle } from "../types";

/**
 * The dark app-shell palette — design's `pal` object, `design/termcraft-engine.js:6-13`,
 * transcribed verbatim. Every hex is lowercase `#rrggbb`, the repo's colour convention
 * (`host/render/model/color.ts` emits lowercase). The shell renders exclusively in this
 * palette (design §; the light palette below is recorded, not used by the shell).
 */
export const SHELL_PALETTE: ShellPalette = {
  bg: "#14110d",
  fg: "#d7d0c2",
  dim: "#8f877a",
  faint: "#5b544a",
  border: "#403a2f",
  line: "#2c2820",
  amber: "#e6a23c",
  amberHi: "#f6c163",
  amberDim: "#8a6d33",
  sel: "#392c11",
  selFg: "#f6c163",
  green: "#8fb96b",
  red: "#dd7b60",
  redDim: "#4d2a20",
  statusBg: "#231d12",
};

/**
 * The light app-shell palette — design's `lightPal()`, `design/termcraft-engine.js:464-465`.
 * Recorded for completeness; the shell chrome never renders in it today (no design source
 * shows the shell in light mode — chrome-map GAP 6). Kept so a future light-shell pass has
 * the exact hues rather than re-deriving them.
 */
export const LIGHT_SHELL_PALETTE: ShellPalette = {
  bg: "#efe9dc",
  fg: "#33302a",
  dim: "#6f6858",
  faint: "#a49b86",
  border: "#c3bba8",
  line: "#d6cfbe",
  amber: "#a8701a",
  amberHi: "#8a5c12",
  amberDim: "#b79a63",
  sel: "#e2d6b8",
  selFg: "#5a4415",
  green: "#5f7d3e",
  red: "#b5482f",
  redDim: "#e7cfc4",
  statusBg: "#d6cfbe",
};

/**
 * Builds the OpenTUI `<text attributes>` bitmask from a shell text style. Mirrors
 * `runtime/ui/text.tsx`'s bold/dim handling and extends it with the blink/italic/
 * underline/inverse the design chrome and flows use (blinking cursor, selection inverse).
 * `TextAttributes` masks: BOLD 1, DIM 2, ITALIC 4, UNDERLINE 8, BLINK 16, INVERSE 32.
 */
export function shellAttrs(style: ShellTextStyle): number {
  let mask = 0;
  if (style.bold === true) mask |= TextAttributes.BOLD;
  if (style.dim === true) mask |= TextAttributes.DIM;
  if (style.italic === true) mask |= TextAttributes.ITALIC;
  if (style.underline === true) mask |= TextAttributes.UNDERLINE;
  if (style.blink === true) mask |= TextAttributes.BLINK;
  if (style.inverse === true) mask |= TextAttributes.INVERSE;
  return mask;
}
