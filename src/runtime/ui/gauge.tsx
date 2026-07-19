/** @jsxImportSource @opentui/react */
import { Text } from "./text"

/** Props for the themed `Gauge` component. `id` is the mandatory stable id (§3.2). */
export interface GaugeProps {
  readonly id: string
  /** Fill fraction; clamped to 0..1 (NaN treated as 0). */
  readonly value: number
  /** Optional trailing label (e.g. a percent readout). */
  readonly label?: string
  /** Bar length in cells; defaults to 10. */
  readonly width?: number
}

const FILLED_GLYPH = "█"
const EMPTY_GLYPH = "░"
const DEFAULT_WIDTH = 10

/** Clamp a fraction into 0..1, mapping NaN to 0 so the bar always renders. */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * A horizontal fill bar (design-system §3.2). Rounds `clamp01(value) * width` to
 * a filled-cell count, drawing `█` in `accent` for the filled span and `░` in
 * `foregroundMuted` for the remainder, with an optional trailing label `Text`.
 * Composes a `row` box so the two spans read as one contiguous bar.
 */
export function Gauge(props: GaugeProps) {
  const width = props.width ?? DEFAULT_WIDTH
  const filled = Math.round(clamp01(props.value) * width)
  const empty = width - filled
  return (
    <box id={props.id} flexDirection="row">
      {filled > 0 ? (
        <Text id={`${props.id}-filled`} color="accent">
          {FILLED_GLYPH.repeat(filled)}
        </Text>
      ) : null}
      {empty > 0 ? (
        <Text id={`${props.id}-empty`} color="foregroundMuted">
          {EMPTY_GLYPH.repeat(empty)}
        </Text>
      ) : null}
      {props.label !== undefined ? (
        <Text id={`${props.id}-label`} color="foreground">
          {` ${props.label}`}
        </Text>
      ) : null}
    </box>
  )
}
