import type { ShellToken } from "ui/theme";

/**
 * `status-bar`'s own shared types — the props contract for the bottom status bar
 * (design `statusBar`/`wsStatus`/`hintKeys`, `design/termcraft-engine.js`, and
 * `design/02-workspace-idle.dc.html`). Feature-local; `index.ts` re-exports these
 * for callers outside this module.
 */

/** The leading mode chip (` STATIC `, ` GENERATING `, ` FOCUS: CHAT `, …). */
export interface StatusBarModeChip {
  readonly text: string;
  readonly fg: ShellToken;
  readonly bg: ShellToken;
}

/** A plain left-cluster segment (the page/version segment). */
export interface StatusBarSegment {
  readonly text: string;
  readonly fg: ShellToken;
  readonly bold?: boolean;
}

/** The preview-size segment; `min` (when present) drives the below-minimum error style. */
export interface StatusBarSize {
  readonly w: number;
  readonly h: number;
  readonly min?: { readonly w: number; readonly h: number } | null;
}

/** The optional free-text hint badge (e.g. `preview error — composer enabled`). */
export interface StatusBarHintBadge {
  readonly text: string;
  readonly fg: ShellToken;
  readonly bg: ShellToken;
}

/** One right-aligned key hint: inert entries remain visible but use the faint treatment. */
export type StatusBarHintKey = readonly [glyph: string, label: string, inert?: boolean];

/** Props for the {@link StatusBar} component. `id` is the mandatory stable id (§3.2). */
export interface StatusBarProps {
  /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
  readonly id: string;
  /** The status bar's total cell width — drives the `ctx%` visibility gate and hint-key trimming. */
  readonly width: number;
  readonly mode: StatusBarModeChip;
  readonly page?: StatusBarSegment | null;
  readonly size?: StatusBarSize | null;
  readonly ctx?: number | null;
  /** Forces the `ctx%` segment visible under 100 cols and switches it to the caution hue. */
  readonly ctxCaution?: boolean;
  readonly hint?: StatusBarHintBadge | null;
  readonly hintKeys?: readonly StatusBarHintKey[];
}
