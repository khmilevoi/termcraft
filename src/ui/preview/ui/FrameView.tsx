import type { PreviewFrameV1 } from "core/ports";

import { colorV1ToInput } from "../model/color";

export interface FrameViewProps {
  readonly id: string;
  /** The latest displayed preview frame (host-supervision §5.3). */
  readonly frame: PreviewFrameV1;
  /** Called by OpenTUI after this exact frame has painted. */
  readonly onRendered?: () => void;
}

/** Leaves OpenTUI's synchronous draw-only traversal before acknowledging reactive state. */
export function deferFrameRendered(onRendered: () => void): void {
  queueMicrotask(onRendered);
}

/**
 * Composites one preview frame's styled rows into OpenTUI text (design §3.2 preview region;
 * host-supervision §5.3 `StyledRunV1` rows). Each row is a flex row of `<text>` runs carrying
 * the run's fg/bg (via {@link colorV1ToInput}) and its attribute bitmask verbatim — the mask
 * is already the protocol's 6-bit encoding OpenTUI's `attributes` prop expects (bold 1, dim 2,
 * italic 4, underline 8, inverse 16, strikethrough 32).
 *
 * This is the raw frame content only; pin badges, selection corners, and the hover label are
 * overlaid by the preview shell (absolute-positioned) above this view.
 */
export function FrameView(props: FrameViewProps) {
  const onRendered = props.onRendered;
  return (
    <box
      id={props.id}
      flexDirection="column"
      renderAfter={onRendered === undefined ? undefined : () => deferFrameRendered(onRendered)}
    >
      {props.frame.rows.map((row, y) => (
        <box key={`row-${y}`} id={`${props.id}-row-${y}`} flexDirection="row">
          {row.map((run, x) => (
            <text
              key={`cell-${x}`}
              id={`${props.id}-r${y}c${x}`}
              fg={colorV1ToInput(run.fg)}
              bg={colorV1ToInput(run.bg)}
              attributes={run.attrs}
            >
              {run.text}
            </text>
          ))}
        </box>
      ))}
    </box>
  );
}
