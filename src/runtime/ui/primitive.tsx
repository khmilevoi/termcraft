import type { BorderGlyphs, BorderSide, Color } from "../types";

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
 * `Color` values — a page reads them off its own `useTokens()` (spec §4.5); the mandatory
 * `id` flows through for host geometry and shell select/pin.
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
  /**
   * The frame: `true` for all four sides, `false`/omitted for none, or exactly the sides to
   * draw (spec §6.2).
   */
  readonly border?: boolean | readonly BorderSide[];
  /**
   * Which glyph table the frame is drawn from. OMITTED ON PURPOSE BY DEFAULT: `Box` is the
   * un-opinionated escape hatch (runtime-api §3.2), so with no `borderStyle` OpenTUI's own
   * `single` applies. The DESIGN's default frame is rounded
   * (`design/termcraft-engine.js:47` — `const r = o.rounded !== false`) and is pinned where it
   * belongs, on `Panel`, the design-conformant frame.
   */
  readonly borderStyle?: "single" | "double" | "rounded" | "heavy";
  /** A complete custom glyph set, replacing whatever `borderStyle` would have selected. */
  readonly borderChars?: BorderGlyphs;
  /** The border hue (only meaningful with `border`). Read one off `useTokens()` (spec §4.5). */
  readonly borderColor?: Color;
  /** Caption drawn into the TOP border row. */
  readonly title?: string;
  /** Where the top caption sits along its row; OpenTUI's own default is `left`. */
  readonly titleAlign?: "left" | "center" | "right";
  /** The caption hue. Read one off `useTokens()` (spec §4.5). */
  readonly titleColor?: Color;
  /** Caption drawn into the BOTTOM border row. */
  readonly bottomTitle?: string;
  /** Where the bottom caption sits along its row; OpenTUI's own default is `left`. */
  readonly bottomTitleAlign?: "left" | "center" | "right";
  /** The fill hue. Read one off `useTokens()` (spec §4.5). */
  readonly background?: Color;
}

/**
 * `border` as the intrinsic wants it. The array is COPIED rather than forwarded: termcraft's own
 * prop is `readonly BorderSide[]` (an authored page must not be handed a mutable alias of its own
 * literal), and the intrinsic's `BorderSides[]` is mutable — a `readonly` array is not assignable
 * to it.
 */
function borderOption(
  border: boolean | readonly BorderSide[] | undefined,
): boolean | BorderSide[] | undefined {
  if (border === undefined || typeof border === "boolean") return border;
  return [...border];
}

/** The low-level box escape hatch (§3.2). Renders one OpenTUI `<box>` from `Color`-typed props. */
export function Box(props: BoxProps) {
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
      border={borderOption(props.border)}
      borderStyle={props.borderStyle}
      customBorderChars={props.borderChars}
      borderColor={props.borderColor}
      title={props.title}
      titleAlignment={props.titleAlign}
      titleColor={props.titleColor}
      bottomTitle={props.bottomTitle}
      bottomTitleAlignment={props.bottomTitleAlign}
      backgroundColor={props.background}
    >
      {props.children}
    </box>
  );
}
