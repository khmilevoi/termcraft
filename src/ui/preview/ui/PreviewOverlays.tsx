import type { PinDtoV1 } from "core/protocol";
import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import type { HoverGeometry, PendingPin } from "../model/interaction";
import type { Rect } from "../model/overlay";
import { SELECTION_GLYPHS, pinAnchor, selectionCorners } from "../model/overlay";

export interface PreviewOverlaysProps {
  readonly id: string;
  readonly frameRect: Rect;
  readonly pins: readonly PinDtoV1[];
  readonly pendingPin: PendingPin | null;
  readonly selectionRect: Rect | null;
  readonly hover: HoverGeometry | null;
}

const BOLD = shellAttrs({ bold: true });

/** Exact grid overlays from design §§07-08: inverse pin badges, corner ticks, hover label. */
export function PreviewOverlays(props: PreviewOverlaysProps) {
  const openPins = props.pins.filter((pin) => pin.status === "open");
  const badges = openPins.map((pin) => ({
    key: pin.pinId,
    point: pinAnchor(pin.fx, pin.fy, props.frameRect),
  }));
  if (props.pendingPin !== null) {
    badges.push({
      key: "pending",
      point: {
        x:
          props.frameRect.x +
          clamp(props.pendingPin.point.x, 0, Math.max(0, props.frameRect.width - 1)),
        y:
          props.frameRect.y +
          clamp(props.pendingPin.point.y, 0, Math.max(0, props.frameRect.height - 1)),
      },
    });
  }
  const corners = props.selectionRect === null ? null : selectionCorners(props.selectionRect);
  const cornerPoints =
    corners === null
      ? []
      : [corners.topLeft, corners.topRight, corners.bottomLeft, corners.bottomRight];
  const hoverLabel = props.hover === null ? null : ` ${props.hover.label} `;
  const hoverLeft =
    props.hover === null || hoverLabel === null
      ? 0
      : clamp(
          props.hover.rect.x + props.hover.rect.width - hoverLabel.length,
          props.frameRect.x,
          props.frameRect.x + props.frameRect.width - hoverLabel.length,
        );
  const hoverTop =
    props.hover === null
      ? 0
      : clamp(
          props.hover.rect.y - 1,
          props.frameRect.y,
          props.frameRect.y + props.frameRect.height - 1,
        );

  return (
    <box
      id={props.id}
      position="absolute"
      top={0}
      left={0}
      width={props.frameRect.x + props.frameRect.width}
      height={props.frameRect.y + props.frameRect.height}
    >
      {badges.map((badge, index) => (
        <text
          key={badge.key}
          id={`${props.id}-pin-${badge.key}`}
          position="absolute"
          left={badge.point.x}
          top={badge.point.y}
          fg={SHELL_PALETTE.bg}
          bg={SHELL_PALETTE.amber}
          attributes={BOLD}
        >
          {String(index + 1)}
        </text>
      ))}
      {cornerPoints.map((point, index) => (
        <text
          key={`corner-${index}`}
          id={`${props.id}-selection-${index}`}
          position="absolute"
          left={point.x}
          top={point.y}
          fg={SHELL_PALETTE.amber}
          attributes={BOLD}
        >
          {SELECTION_GLYPHS[index]}
        </text>
      ))}
      {props.hover !== null && hoverLabel !== null && (
        <text
          id={`${props.id}-hover`}
          position="absolute"
          left={hoverLeft}
          top={hoverTop}
          fg={SHELL_PALETTE.amberHi}
          bg={SHELL_PALETTE.line}
        >
          {hoverLabel}
        </text>
      )}
    </box>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.max(min, max), value));
}
