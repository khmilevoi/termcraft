import type { BorderGlyphs, BorderSide, Color, Dimension } from "../types";

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

/** Public prop value → Yoga `alignSelf`. `start`/`end` gain the `flex-` prefix; the rest pass through. */
const ALIGN_SELF = {
  auto: "auto",
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
} as const;

/** Public prop value → Yoga `flexWrap`. Only `nowrap` is respelled (`no-wrap` upstream). */
const WRAP = {
  nowrap: "no-wrap",
  wrap: "wrap",
  "wrap-reverse": "wrap-reverse",
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
  /** Flex shrink factor — a 0 refuses to give way when the line is over-full. */
  readonly shrink?: number;
  /** Flex basis — the main-axis starting size before grow/shrink, or `auto` for content size. */
  readonly basis?: number | "auto";
  /** Whether an over-full row/column wraps onto further lines. */
  readonly wrap?: "nowrap" | "wrap" | "wrap-reverse";
  /** Cross-axis placement of THIS box, overriding its parent's `align` for it alone. */
  readonly alignSelf?: "auto" | "start" | "center" | "end" | "stretch" | "baseline";
  readonly width?: Dimension;
  readonly height?: Dimension;
  readonly minWidth?: Dimension;
  readonly maxWidth?: Dimension;
  readonly minHeight?: Dimension;
  readonly maxHeight?: Dimension;
  /**
   * Outer spacing on all four sides. DELIBERATE OMISSION: OpenTUI also offers per-side and
   * per-axis margins; spec §6.2 asks for the scalar form only, and exposing more is additive.
   */
  readonly margin?: Dimension;
  /**
   * `absolute` takes the box out of its parent's flex flow and places it by the offsets below.
   * DELIBERATE OMISSION: OpenTUI's third value, `static`, is Yoga's own default and §6.2 does not
   * ask for it.
   */
  readonly position?: "relative" | "absolute";
  readonly top?: Dimension;
  readonly right?: Dimension;
  readonly bottom?: Dimension;
  readonly left?: Dimension;
  /** Paint order among overlapping siblings; higher paints later. */
  readonly zIndex?: number;
  /**
   * What happens to content larger than the box. `scroll` currently clips exactly like `hidden`
   * on `Box`: `Renderable` installs a scissor rect for any value other than `visible` but gives
   * `Box` neither a scroll offset nor any affordance to move it — a scrollable container is
   * `ScrollBox`'s job (plan P7), not this one.
   */
  readonly overflow?: "visible" | "hidden" | "scroll";
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
      flexShrink={props.shrink}
      flexBasis={props.basis}
      flexWrap={props.wrap !== undefined ? WRAP[props.wrap] : undefined}
      alignSelf={props.alignSelf !== undefined ? ALIGN_SELF[props.alignSelf] : undefined}
      width={props.width}
      height={props.height}
      minWidth={props.minWidth}
      maxWidth={props.maxWidth}
      minHeight={props.minHeight}
      maxHeight={props.maxHeight}
      margin={props.margin}
      position={props.position}
      top={props.top}
      right={props.right}
      bottom={props.bottom}
      left={props.left}
      zIndex={props.zIndex}
      overflow={props.overflow}
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
