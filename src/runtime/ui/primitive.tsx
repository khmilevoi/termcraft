import { activeTokens } from "../model/tokens";
import type { ThemeTokens } from "../types";

const ALIGN = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
} as const;
const JUSTIFY = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
} as const;

/**
 * The low-level `Box` primitive — the facade-owned rendering escape hatch
 * (runtime-api §3.2). It exposes the raw flexbox + border/background surface a
 * bespoke widget needs (a superset of the semantic `Row`/`Column`) WITHOUT letting
 * an authored page import an `@opentui/*` path or bind to its release. Colors are
 * semantic theme-token names, never raw hues; the mandatory `id` flows through for
 * host geometry and shell select/pin.
 */
export interface BoxProps {
  /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
  readonly id: string;
  readonly children?: unknown;
  readonly direction?: "row" | "column";
  readonly align?: keyof typeof ALIGN;
  readonly justify?: keyof typeof JUSTIFY;
  readonly gap?: number;
  readonly padding?: number;
  /** Flex grow factor — a 0 keeps the box at content size; ≥1 lets it expand. */
  readonly grow?: number;
  readonly width?: number;
  readonly height?: number;
  readonly border?: boolean;
  /** A semantic token for the border hue (only meaningful with `border`). */
  readonly borderColor?: keyof ThemeTokens;
  /** A semantic token for the fill hue. */
  readonly background?: keyof ThemeTokens;
}

/** The low-level box escape hatch (§3.2). Renders one OpenTUI `<box>` from token-resolved props. */
export function Box(props: BoxProps) {
  const tokens = activeTokens();
  return (
    <box
      id={props.id}
      flexDirection={props.direction ?? "column"}
      alignItems={props.align !== undefined ? ALIGN[props.align] : undefined}
      justifyContent={props.justify !== undefined ? JUSTIFY[props.justify] : undefined}
      gap={props.gap}
      padding={props.padding}
      flexGrow={props.grow}
      width={props.width}
      height={props.height}
      border={props.border}
      borderColor={props.borderColor !== undefined ? tokens[props.borderColor] : undefined}
      backgroundColor={props.background !== undefined ? tokens[props.background] : undefined}
    >
      {props.children}
    </box>
  );
}
