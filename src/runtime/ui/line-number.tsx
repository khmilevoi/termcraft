import { activeTokens } from "../model/tokens";
import type { Color } from "../types";

/** Props for the themed `LineNumber` gutter. `id` is the mandatory stable id (§3.2). */
export interface LineNumberProps {
  /** Stable id the host selects and answers geometry on. Mandatory on every catalog component. */
  readonly id: string;
  /**
   * The content whose lines are numbered — EXACTLY ONE text-like child (`Text` today; `Input`,
   * and later `Textarea`/`Code`, qualify too). A second child is silently dropped and a child
   * that is not text-like leaves the gutter unbuilt, so nothing renders at all. See the
   * component's own note.
   */
  readonly children?: unknown;
  /** The gutter digits' hue; defaults to the theme's `foregroundFaint`. */
  readonly color?: Color;
  /** The gutter's fill; defaults to the theme's `background` (the design paints no gutter fill). */
  readonly background?: Color;
  /** The number the first line carries; defaults to `1`. */
  readonly startAt?: number;
  /**
   * Minimum gutter width in cells, so a growing file does not shift the content sideways.
   * Defaults to `3`. The vendor also applies this as the outer box's own minimum width, which is
   * harmless here since the gutter is already at least that wide.
   */
  readonly minWidth?: number;
  /**
   * Cells of space between the digits and the content. Defaults to `1`. The vendor option this
   * maps to (`paddingRight`) is ALSO a base layout prop, so it double-applies: it inserts the gap
   * on the left of the content AND pads the same number of cells onto the component's own right
   * edge, costing that much content width there too. There is no prop that separates the two
   * effects; a large `gap` narrows the content column on both sides.
   */
  readonly gap?: number;
}

/**
 * A themed line-number gutter around one text-like child (design-system §6.1, the "Documents and
 * code" group). Renders an OpenTUI `<line-number>` whose numbering target is wired from the child
 * itself — the underlying `target` is a renderer object and is deliberately never a prop (spec
 * §6). The mandatory `id` flows to the element so the host can answer geometry queries and the
 * shell can select/pin it.
 *
 * ONE CHILD, AND IT MUST BE TEXT-LIKE. The renderable adopts the FIRST child that reports line
 * information (`Text`, `Input`, and later `Textarea`/`Code`) as its numbering target; every later
 * child is refused and never appears. A child that reports no line information — a `Row`, a
 * `Panel`, a `Box` — leaves the gutter unbuilt and the whole component draws nothing. Neither
 * case throws; both are covered by tests beside this file.
 *
 * `Diff` can NOT be a child: it carries no line information of its own (it composes its own
 * internal gutters). Use `Diff`'s `showLineNumbers` instead.
 *
 * COLOURS. `color` defaults to `foregroundFaint` — the role the design gives placeholders, ghost
 * rows and column headers, which is the weight a gutter reads at; the design draws no gutter of
 * its own, so this is the closest faithful mapping rather than a quoted value. `background`
 * defaults to the theme's `background`: the design paints no gutter fill, and passing the value
 * explicitly is what stops `@opentui/core`'s own `#888888` default from reaching the frame.
 */
export function LineNumber(props: LineNumberProps) {
  const tokens = activeTokens();
  return (
    <line-number
      id={props.id}
      fg={props.color ?? tokens.foregroundFaint}
      bg={props.background ?? tokens.background}
      // The vendor counts from `lineNumberOffset + 1`; a page author means "this excerpt starts
      // at line N", so the ergonomic prop is `startAt` and the offset is derived. Same shape as
      // `Row`'s align/justify vocabulary over Yoga's.
      lineNumberOffset={props.startAt === undefined ? undefined : props.startAt - 1}
      minWidth={props.minWidth}
      paddingRight={props.gap}
    >
      {props.children}
    </line-number>
  );
}
