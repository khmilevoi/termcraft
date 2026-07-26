import { reatomComponent } from "@reatom/react";

import { shellAttrs } from "ui/theme";

import { elapsedTick, formatElapsed } from "../model/elapsed";
import { currentSpinnerFrame } from "../model/frames";
import type { SpinnerProps } from "../types";

/**
 * The one animated spinner every surface should use — a `reatomComponent` so that a tick
 * re-renders THIS line and nothing else. Rendering it inside a larger component (rather than
 * threading a glyph down as a prop) is what keeps an 80ms tick from repainting a whole panel.
 *
 * Colour and weight come from the caller, so each surface keeps its own design-sourced values
 * instead of inheriting an invented default from here.
 */
export const Spinner = reatomComponent<SpinnerProps>((props) => {
  // Read CONDITIONALLY: with no `startedAt` there is no elapsed segment, so this component never
  // registers a dependency on the 1 s ticker and never repaints for it.
  //
  // `Math.max(elapsedTick(), Date.now())`, not a bare read: `elapsedTick`'s own connect hook is
  // enqueued as an async effect (`@reatom/core`'s `_enqueue(..., "effect")`), not run
  // synchronously on connect — so the very first render of a freshly-mounted (or remounted)
  // Spinner can observe `elapsedTick`'s stale/default value before that effect has fired. Without
  // the `Math.max`, that first frame would compute a negative `elapsedTick() - startedAt` and
  // `formatElapsed` would clamp it to a wrong `0s`. Taking the real `Date.now()` instead whenever
  // it is newer keeps that first frame correct; once the ticker starts advancing for real it is
  // always >= any later `Date.now()` read, so the `Math.max` becomes a no-op (review round 1,
  // Minor).
  const suffix =
    props.startedAt == null
      ? ""
      : ` · ${formatElapsed(Math.max(elapsedTick(), Date.now()) - props.startedAt)}`;
  return (
    <text id={props.id} fg={props.fg} attributes={shellAttrs({ bold: props.bold ?? false })}>
      {`${currentSpinnerFrame()} ${props.label}${suffix}`}
    </text>
  );
}, "ui.Spinner");
