import { activeTokens } from "../model/tokens";
import type { Color } from "../types";
import { Text } from "./text";

/** Props for the themed `Sparkline` component. `id` is the mandatory stable id (§3.2). */
export interface SparklineProps {
  readonly id: string;
  /** The series to plot; an empty series renders empty. */
  readonly values: readonly number[];
  /** The glyph hue; defaults to the theme's `success` (the design's sparkline green). */
  readonly color?: Color;
}

/** The eight block glyphs, ascending from lowest (`▁`) to highest (`█`). */
const GLYPHS = "▁▂▃▄▅▆▇█";
const MIN_GLYPH = "▁";

/**
 * Map one value to a block glyph, scaling it across `[min, max]`. An all-equal
 * series (zero span) maps every value to the mid glyph rather than dividing by
 * zero.
 */
function glyphFor(value: number, min: number, max: number): string {
  const span = max - min;
  const ratio = span === 0 ? 0.5 : (value - min) / span;
  const index = Math.round(ratio * (GLYPHS.length - 1));
  return GLYPHS[index] ?? MIN_GLYPH;
}

/**
 * A single-line block-glyph trend (design-system §3.2). Scales each value between
 * the series min and max onto `▁…█` and renders the glyph string as one themed
 * `Text` in `color` (default `success` — the design renders sparklines in the
 * live/throughput green). An empty series renders an empty anchor — it never throws.
 */
export function Sparkline(props: SparklineProps) {
  const color = props.color ?? activeTokens().success;
  const values = props.values;
  if (values.length === 0) {
    return (
      <Text id={props.id} color={color}>
        {""}
      </Text>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const line = values.map((value) => glyphFor(value, min, max)).join("");
  return (
    <Text id={props.id} color={color}>
      {line}
    </Text>
  );
}
