/** @jsxImportSource @opentui/react */
import { activeTokens } from "../model/tokens"

/** Props for the `Panel` bordered container. `id` is the mandatory stable id (§3.2). */
export interface PanelProps {
  /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
  readonly id: string
  /** Optional caption drawn into the top border. */
  readonly title?: string
  readonly children?: unknown
  /** Uniform inner padding inside the border. */
  readonly padding?: number
}

/**
 * A titled, bordered column container (design-system §3.2). Draws a single-line
 * border in the theme's `border` hue with an optional `title` in the
 * `foreground` hue, then stacks its children vertically inside. Colors are
 * resolved from semantic tokens so a theme swap re-colors every panel without
 * touching sources; the mandatory `id` flows to the element for host geometry.
 */
export function Panel(props: PanelProps) {
  const tokens = activeTokens()
  return (
    <box
      id={props.id}
      border
      borderColor={tokens.border}
      title={props.title}
      titleColor={tokens.foreground}
      flexDirection="column"
      padding={props.padding}
    >
      {props.children}
    </box>
  )
}
