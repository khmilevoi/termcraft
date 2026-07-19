/** @jsxImportSource @opentui/react */
import type { ThemeTokens } from "../types"
import { activeTokens } from "../model/tokens"

/** Props for the `Separator` rule. `id` is the mandatory stable id (§3.2). */
export interface SeparatorProps {
  /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
  readonly id: string
  /** Orientation of the rule; defaults to `horizontal`. */
  readonly direction?: "horizontal" | "vertical"
  /** A semantic token for the rule; defaults to `line` (the design's subtle-divider hue). */
  readonly color?: keyof ThemeTokens
}

/**
 * A one-cell themed rule (design-system §3.2). A `horizontal` separator is a
 * full-width, single-row band; a `vertical` one is a full-height, single-column
 * band. It defaults to the theme's `line` hue — the design's subtle interior
 * divider (`border` is reserved for actual box frames drawn by Panel) — and takes
 * an optional `color` token so a caller can pick `border` for an active-frame rule
 * or `accentHi` for a focused one. The mandatory `id` flows to the element.
 * (MVP simplification: the design draws glyph rules `─`/`│` with `├┤┬┴` weld tees;
 * this renders a color band — a known divergence pending the phase-7 UI pass.)
 */
export function Separator(props: SeparatorProps) {
  const tokens = activeTokens()
  const direction = props.direction ?? "horizontal"
  const fill = tokens[props.color ?? "line"]
  if (direction === "vertical") {
    return <box id={props.id} width={1} backgroundColor={fill} />
  }
  return <box id={props.id} height={1} backgroundColor={fill} />
}
