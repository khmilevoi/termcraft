import { reatomComponent } from "@reatom/react";

import { shellAttrs } from "ui/theme";

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
export const Spinner = reatomComponent<SpinnerProps>(
  (props) => (
    <text id={props.id} fg={props.fg} attributes={shellAttrs({ bold: props.bold ?? false })}>
      {`${currentSpinnerFrame()} ${props.label}`}
    </text>
  ),
  "ui.Spinner",
);
