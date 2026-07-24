import { SHELL_PALETTE, shellAttrs } from "ui/theme";

/** Props for the {@link ErrorPanel} preview-region error surface. */
export interface ErrorPanelProps {
  /** Stable id the host selects and answers geometry on. */
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** e.g. "could not render current design" — the leading "✗ " is added by the component. */
  readonly headline: string;
  /** e.g. 'pages/main/page.tsx — Gate: unknown widget "GpuPanel"'. */
  readonly cause: string;
  /** e.g. "fix it in a repair turn — the composer stays open". */
  readonly nextStep: string;
  /** Optional inset line, e.g. "⏎ Restore… a working commit"; the inset is omitted when absent/null. */
  readonly restoreHint?: string | null;
}

const BOLD = shellAttrs({ bold: true });

/**
 * The preview-region error panel (design `wsBrokenSource`,
 * `design/12-errors-edge-states.dc.html`). Shown in place of preview content when the
 * current design fails to render — a host crash, a broken canonical source, or a Gate
 * rejection all route through this same panel; the caller supplies the exact text for
 * each case (generalized over host-crash / broken-source / Gate-fail, per the design's
 * "the same panel pattern is what a host crash uses"). A centered three-line block names
 * the failure, its cause, and the next step; an optional titled amber inset offers a
 * one-line restore hint when a usable prior commit exists. The surrounding pane shell
 * (tabs/status bar/restore-badge status hint) is drawn by the caller.
 */
export function ErrorPanel(props: ErrorPanelProps) {
  return (
    <box
      id={props.id}
      width={props.width}
      height={props.height}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
    >
      {/* divergence: design centers this block at midY = dy+floor(dh/2)-2 via absolute
          placement (engine `wsBrokenSource`); flexbox centering on both axes is the
          closest faithful mapping in OpenTUI's box layout. The design's floating
          restore inset is top-right-anchored over the preview (dx+dw-38, dy+1) — here
          it renders stacked below the message block instead, since OpenTUI flexbox
          cannot overlay two siblings at independent positions within one column. */}
      <text id={`${props.id}-headline`} fg={SHELL_PALETTE.red} attributes={BOLD}>
        {`✗ ${props.headline}`}
      </text>
      <text id={`${props.id}-cause`} fg={SHELL_PALETTE.fg}>
        {props.cause}
      </text>
      <text id={`${props.id}-next-step`} fg={SHELL_PALETTE.faint}>
        {props.nextStep}
      </text>
      {props.restoreHint != null && (
        <box
          id={`${props.id}-restore`}
          border
          borderStyle="rounded"
          borderColor={SHELL_PALETTE.amber}
          title="restore (v1)"
          titleColor={SHELL_PALETTE.amberHi}
          backgroundColor={SHELL_PALETTE.bg}
          flexDirection="column"
          marginTop={1}
        >
          <text id={`${props.id}-restore-hint`} fg={SHELL_PALETTE.amberHi}>
            {props.restoreHint}
          </text>
        </box>
      )}
    </box>
  );
}
