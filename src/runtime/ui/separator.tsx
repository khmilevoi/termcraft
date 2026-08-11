import { activeTokens } from "../model/tokens";
import type { Color } from "../types";

/** Props for the `Separator` rule. `id` is the mandatory stable id (§3.2). */
export interface SeparatorProps {
  /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
  readonly id: string;
  /** Orientation of the rule; defaults to `horizontal`. */
  readonly direction?: "horizontal" | "vertical";
  /** The rule's hue; defaults to the theme's `line` (the design's subtle-divider hue). */
  readonly color?: Color;
}

/**
 * A one-cell themed rule (design-system §3.2). A `horizontal` separator is a
 * full-width, single-row band; a `vertical` one is a full-height, single-column
 * band. It defaults to the theme's `line` hue — the design's subtle interior
 * divider (`border` is reserved for actual box frames drawn by Panel) — and takes
 * an optional `color`, a `Color` a caller reads off `useTokens()`, so a caller can pick
 * `t.border` for an active-frame rule or `t.accentHi` for a focused one. The mandatory
 * `id` flows to the element.
 * (MVP simplification: the design draws glyph rules `─`/`│` with `├┤┬┴` weld tees;
 * this renders a color band — a known divergence pending the phase-7 UI pass.)
 */
export function Separator(props: SeparatorProps) {
  const direction = props.direction ?? "horizontal";
  const fill = props.color ?? activeTokens().line;
  // `alignSelf: "stretch"` is what makes the rule a RULE. Without it a parent that centres
  // its children (`Column align="center"` — what a generated page reaches for constantly)
  // shrinks the band to its content width, i.e. a single coloured cell. Stretch overrides the
  // parent's `alignItems` for this child only, which is exactly the design's intent: a rule
  // spans its container whatever the container does with everything else.
  if (direction === "vertical") {
    return <box id={props.id} width={1} alignSelf="stretch" backgroundColor={fill} />;
  }
  return <box id={props.id} height={1} alignSelf="stretch" backgroundColor={fill} />;
}
