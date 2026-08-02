import { SHELL_PALETTE, shellAttrs } from "ui/theme";

/** Props for the {@link OpeningState} project-opening preview placeholder. */
export interface OpeningStateProps {
  /** Stable id the host selects and answers geometry on. */
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

const BOLD = shellAttrs({ bold: true });

/**
 * The preview region while the project is still opening (design `wsOpening`,
 * `design/30-workspace-first-launch.dc.html`'s `ws-open-checking-120`). Shown when
 * `mirror.project().projectId` is null — the Workspace has mounted and is waiting for the
 * Kernel's ready sequence to publish descriptors.
 *
 * DISTINCT FROM `EmptyState` AND FROM THE GENERATING BLOCK, on purpose — §30's own prose:
 * §20's `No pages yet` is a FINISHED project that genuinely has none, and §14's
 * `⠹ generating first page…` is a running, cancellable turn. Neither is true here.
 *
 * NOTHING SPINS. A spinner is turn vocabulary (§14); this state has no cancel and nothing
 * measurable, so drawing one would borrow a promise it cannot keep. Two static lines, the first
 * amber and bold, the second faint.
 */
export function OpeningState(props: OpeningStateProps) {
  return (
    <box
      id={props.id}
      width={props.width}
      height={props.height}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
    >
      {/* divergence: design centres at `dy+floor(dh/2)-1` and `+1` via absolute placement
          (engine `ctr`); flexbox centring on both axes with a blank row between is the closest
          faithful mapping in OpenTUI's box layout — the same note `EmptyState.tsx` carries. */}
      <text id={`${props.id}-headline`} fg={SHELL_PALETTE.amber} attributes={BOLD}>
        opening project…
      </text>
      <text id={`${props.id}-spacer`}> </text>
      <text id={`${props.id}-detail`} fg={SHELL_PALETTE.faint}>
        {"reading .termcraft — preview arrives when it's ready"}
      </text>
    </box>
  );
}
