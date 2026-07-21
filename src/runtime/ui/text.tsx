import { TextAttributes } from "@opentui/core";

import { activeTokens } from "../model/tokens";
import type { ThemeTokens } from "../types";

/** Props for the themed `Text` component. `id` is the mandatory stable id (§3.2). */
export interface TextProps {
  /** Stable id selection and pins key on (§3.2). Mandatory on every catalog component. */
  readonly id: string;
  readonly children?: string | number;
  /** A semantic theme token name; defaults to `foreground`. Pages never pass raw hues. */
  readonly color?: keyof ThemeTokens;
  readonly bold?: boolean;
  readonly dim?: boolean;
}

/**
 * Themed inline text (design-system, runtime-api §3.2). Renders a single OpenTUI
 * `<text>` with a token-resolved foreground and an attribute mask; the mandatory
 * `id` flows to the element so the host can answer geometry queries (checkHit/
 * rectOf) and the shell can select/pin it. Colors are semantic token names, never
 * raw hues, so a theme swap re-colors every page without editing sources.
 */
export function Text(props: TextProps) {
  const tokens = activeTokens();
  const fg = tokens[props.color ?? "foreground"];
  let attributes = 0;
  if (props.bold === true) attributes |= TextAttributes.BOLD;
  if (props.dim === true) attributes |= TextAttributes.DIM;
  return (
    <text id={props.id} fg={fg} attributes={attributes}>
      {props.children}
    </text>
  );
}
