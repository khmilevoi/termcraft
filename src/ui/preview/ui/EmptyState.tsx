import { SHELL_PALETTE } from "ui/theme";

/** Props for the {@link EmptyState} zero-pages preview placeholder. */
export interface EmptyStateProps {
  /** Stable id the host selects and answers geometry on. */
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

/**
 * The zero-pages empty preview (design `wsEmpty`, `design/20-empty-state.dc.html`).
 * Shown in the preview region when the current project has no pages — first
 * generation failed after retries, or every page was removed. A single centered
 * line names the state and prompts the next action; no chrome of its own beyond
 * the message, since the surrounding pane shell (tabs/status bar) is drawn by
 * the caller.
 */
export function EmptyState(props: EmptyStateProps) {
  return (
    <box
      id={props.id}
      width={props.width}
      height={props.height}
      alignItems="center"
      justifyContent="center"
    >
      {/* divergence: design vertically centers at dy+floor(dh/2) via absolute
          placement (engine `ctr` + `Math.floor(s.dh/2)`); flexbox centering on
          both axes is the closest faithful mapping in OpenTUI's box layout. */}
      <text id={`${props.id}-message`} fg={SHELL_PALETTE.faint}>
        No pages yet — describe what to build
      </text>
    </box>
  );
}
