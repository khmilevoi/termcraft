import { wrap } from "../model/reatom";
import { activeTokens } from "../model/tokens";
import type { Color } from "../types";
import { registerRenderableTags } from "./renderable-tags";

/**
 * Props for the themed `Slider`. `id` is the mandatory stable id (§3.2); `orientation` is
 * REQUIRED by the underlying renderable's constructor (spec §6.1's spike), and `value` is
 * required because a slider's rendered state must come from props rather than from the
 * renderable's own mutable `_value` (spec §6.3).
 */
export interface SliderProps {
  /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
  readonly id: string;
  readonly orientation: "horizontal" | "vertical";
  /** The current value, clamped by the renderable into `min`..`max`. */
  readonly value: number;
  /** Range floor; defaults to 0. */
  readonly min?: number;
  /** Range ceiling; defaults to 100. */
  readonly max?: number;
  /** The unfilled track hue. Read one off `useTokens()` (spec §4.5). Defaults to `border`. */
  readonly trackColor?: Color;
  /** The thumb hue. Read one off `useTokens()` (spec §4.5). Defaults to `accent`. */
  readonly fillColor?: Color;
  /** Track length in cells for a horizontal slider. */
  readonly width?: number;
  /** Track length in cells for a vertical slider. */
  readonly height?: number;
  /** Invoked with the new value when the slider is dragged; inert in the static render. */
  readonly onChange?: (value: number) => void;
}

/**
 * A draggable value track (spec §6.1). Renders the OpenTUI `SliderRenderable` — a renderable
 * with no intrinsic tag, registered by {@link registerRenderableTags} — as a solid track filled
 * with `trackColor` and a `█`/`▌`/`▐` thumb drawn in `fillColor` at half-cell precision.
 *
 * DESIGN GAP, FLAGGED RATHER THAN GUESSED (CLAUDE.md): the design system has NO standalone
 * slider. Its nearest covered element is the gauge (`design/termcraft-engine.js`'s gauge draw,
 * implemented in `./gauge.tsx`), which fills in `accent` over a track in `border`; those two
 * roles are reused here as the closest faithful mapping, not invented.
 *
 * The thumb's SIZE follows OpenTUI's own proportional rule (its `viewPortSize` defaults to 10% of
 * the range). No prop is exposed for it: naming that number in termcraft's vocabulary would mean
 * inventing a semantic the design does not have.
 *
 * DIVERGENCE, MEASURED: `SliderRenderable` captures `onChange` in its CONSTRUCTOR
 * (`_onChange = options.onChange`) and exposes no setter for it, so a handler whose identity
 * changes after mount keeps invoking the first one. The wrapper cannot fix that without reaching
 * the instance through a `ref`, which §6 forbids exposing; it is recorded here instead. The
 * interactive path is inert in the current static render either way.
 */
export function Slider(props: SliderProps) {
  registerRenderableTags();
  const tokens = activeTokens();
  const onChange = props.onChange;
  return (
    <slider
      id={props.id}
      orientation={props.orientation}
      value={props.value}
      min={props.min ?? 0}
      max={props.max ?? 100}
      width={props.width}
      height={props.height}
      backgroundColor={props.trackColor ?? tokens.border}
      foregroundColor={props.fillColor ?? tokens.accent}
      onChange={onChange === undefined ? undefined : wrap(onChange)}
    />
  );
}
