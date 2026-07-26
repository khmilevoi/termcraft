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

/**
 * One right-aligned key hint. The third element is the design's own `k[2]`
 * (`design/termcraft-engine.js:66-74`):
 *   - absent — the ordinary key: amber glyph on the status background, bold, dim label;
 *   - `true` — ACTIVE: the glyph inverts to `bg`-on-`amber`;
 *   - `"dis"` — DISABLED: glyph and label both drop to `faint`, and the glyph loses bold.
 *
 * `"dis"` is required by Home while the health probe is in flight (`⏎ create`, design `:161`) and
 * by the composer for the whole of a turn (`⏎ send`, `:276`/`:1006`) — a shared primitive, not a
 * per-screen tweak. CORRECTED alongside it: this component previously read `true` as "inert/faint",
 * the opposite of the design's own `active` branch. MVP-inert hotkeys (F3/F4/Ctrl+P) map to `"dis"`
 * instead, which is the treatment they were already getting — so no rendering moves.
 */
export type StatusBarHintKey = readonly [glyph: string, label: string, state?: true | "dis"];

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
