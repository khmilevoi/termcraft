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
  const suffix =
    props.startedAt == null ? "" : ` · ${formatElapsed(elapsedTick() - props.startedAt)}`;
  return (
    <text id={props.id} fg={props.fg} attributes={shellAttrs({ bold: props.bold ?? false })}>
      {`${currentSpinnerFrame()} ${props.label}${suffix}`}
    </text>
  );
}, "ui.Spinner");
