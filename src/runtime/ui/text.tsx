import { TextAttributes } from "@opentui/core";

import { activeTokens } from "../model/tokens";
import type { Color } from "../types";

/** Props for the themed `Text` component. `id` is the mandatory stable id (§3.2). */
export interface TextProps {
  /** Stable id selection and pins key on (§3.2). Mandatory on every catalog component. */
  readonly id: string;
  readonly children?: string | number;
  /** The text hue; defaults to the theme's `foreground`. Read one off `useTokens()` (spec §4.5). */
  readonly color?: Color;
  readonly bold?: boolean;
  readonly dim?: boolean;
}

/**
 * Themed inline text (design-system, runtime-api §3.2). Renders a single OpenTUI
 * `<text>` with a token-resolved foreground and an attribute mask; the mandatory
 * `id` flows to the element so the host can answer geometry queries (checkHit/
 * rectOf) and the shell can select/pin it. The hue is a `Color` the caller supplies
 * — a page reads one off its own `useTokens()` (spec §4.5), so the project's design
 * system owns the palette and the catalog owns only the default.
 */
export function Text(props: TextProps) {
  const fg = props.color ?? activeTokens().foreground;
  let attributes = 0;
  if (props.bold === true) attributes |= TextAttributes.BOLD;
  if (props.dim === true) attributes |= TextAttributes.DIM;
  return (
    <text id={props.id} fg={fg} attributes={attributes}>
      {props.children}
    </text>
  );
}
