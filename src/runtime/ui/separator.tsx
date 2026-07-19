/** @jsxImportSource @opentui/react */
import { activeTokens } from "../model/tokens"

/** Props for the `Separator` rule. `id` is the mandatory stable id (§3.2). */
export interface SeparatorProps {
  /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
  readonly id: string
  /** Orientation of the rule; defaults to `horizontal`. */
  readonly direction?: "horizontal" | "vertical"
}

/**
 * A one-cell themed rule (design-system §3.2). A `horizontal` separator is a
 * full-width, single-row band filled with the theme's `border` hue; a `vertical`
 * one is a full-height, single-column band. The fill color is a semantic token
 * so a theme swap re-colors it; the mandatory `id` flows to the element for host
 * geometry.
 */
export function Separator(props: SeparatorProps) {
  const tokens = activeTokens()
  const direction = props.direction ?? "horizontal"
  if (direction === "vertical") {
    return <box id={props.id} width={1} backgroundColor={tokens.border} />
  }
  return <box id={props.id} height={1} backgroundColor={tokens.border} />
}
