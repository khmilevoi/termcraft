import { SHELL_PALETTE, shellAttrs } from "ui/theme";

/** A terminal size (columns × rows). */
export interface EnlargePlaceholderSize {
  readonly w: number;
  readonly h: number;
}

/** Props for the {@link EnlargePlaceholder} full-terminal takeover. */
export interface EnlargePlaceholderProps {
  /** Stable id the host selects and answers geometry on. */
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** The terminal's current size. */
  readonly now: EnlargePlaceholderSize;
  /** The app's minimum required size. */
  readonly need: EnlargePlaceholderSize;
}

const BOLD = shellAttrs({ bold: true });

/**
 * The below-minimum-terminal takeover (design `termSmall()`, `design/12-errors-edge-
 * states.dc.html`, chrome-map "SURFACE: Enlarge-window / below-minimum placeholder").
 * Distinct from the status-bar size warning (§8.2) — this fires when the terminal
 * itself is smaller than the app's own minimum frame, so there is no chrome to warn
 * inside: no boxes, no chat/preview split, no status bar, just four centered lines.
 *
 * Design vertically centers the four lines around `cyc = floor(h/2)` at rows
 * `cyc-2, cyc, cyc+2, cyc+3` — a 1-blank-row gap, another 1-blank-row gap, then an
 * adjacent line. A column flexbox can't place absolute rows, so the closest faithful
 * mapping reproduces that exact rhythm with two 1-row spacers between the first three
 * lines and no spacer before the last (divergence: engine-absolute rows -> flex order
 * + spacers, not literal row numbers).
 */
export function EnlargePlaceholder(props: EnlargePlaceholderProps) {
  return (
    <box
      id={props.id}
      width={props.width}
      height={props.height}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      backgroundColor={SHELL_PALETTE.bg}
    >
      <text id={`${props.id}-title`} fg={SHELL_PALETTE.amber} attributes={BOLD}>
        {"⚠ terminal too small"}
      </text>
      <box id={`${props.id}-gap-1`} height={1} />
      <text id={`${props.id}-message`} fg={SHELL_PALETTE.fg}>
        {"enlarge the window to keep designing"}
      </text>
      <box id={`${props.id}-gap-2`} height={1} />
      <text id={`${props.id}-now`} fg={SHELL_PALETTE.red} attributes={BOLD}>
        {`now  ${props.now.w}×${props.now.h}`}
      </text>
      <text id={`${props.id}-need`} fg={SHELL_PALETTE.faint}>
        {`need ${props.need.w}×${props.need.h}`}
      </text>
    </box>
  );
}
