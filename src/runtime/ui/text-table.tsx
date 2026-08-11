import { bg, bold, fg, italic, underline } from "@opentui/core";
import type { TextChunk } from "@opentui/core";

import { activeTokens } from "../model/tokens";
import type { Color, TokenMap } from "../types";
import { registerRenderableTags } from "./renderable-tags";

/** One styled run inside a table cell. Colours are `Color` values read off `useTokens()`. */
export interface TextTableSpan {
  readonly text: string;
  /** Text hue; defaults to the table's `textColor`. */
  readonly color?: Color;
  /** Cell-run back-fill. */
  readonly background?: Color;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
}

/**
 * A single cell: a plain string, or a run list when parts of it need their own style.
 * The underlying renderable takes styled runs and nothing else (spec §6.1's spike); the plain
 * string form is termcraft's own convenience over that, converted here.
 */
export type TextTableCell = string | readonly TextTableSpan[];

/** Props for the themed `TextTable`. `id` is the mandatory stable id (§3.2). */
export interface TextTableProps {
  /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
  readonly id: string;
  /** Rows of cells, positional. A short row simply renders fewer columns. */
  readonly rows: readonly (readonly TextTableCell[])[];
  /** Draw a single-line grid. OFF by default — the design's tables are borderless. */
  readonly borders?: boolean;
  /** The grid hue when `borders` is set. Defaults to `border`. */
  readonly borderColor?: Color;
  /** The default cell text hue. Defaults to `foreground`. */
  readonly textColor?: Color;
  /** The table's back-fill. */
  readonly background?: Color;
  /** Cells between columns; defaults to 1, matching the design's table gutter. */
  readonly columnGap?: number;
  /** Wrapping inside a cell; defaults to `word`. */
  readonly wrap?: "none" | "char" | "word";
  /** Padding inside every cell. */
  readonly cellPadding?: number;
  readonly width?: number;
  readonly height?: number;
}

/**
 * Convert one span into the renderable's own chunk type through `@opentui/core`'s own chunk
 * builders — never a hand-constructed `{ __isChunk: true }` literal, which would be fabricating
 * a vendor internal. Non-exported on purpose: `TextChunk` must not reach the facade's surface
 * (spec §6).
 */
function toChunk(span: TextTableSpan, fallback: Color): TextChunk {
  const coloured = fg(span.color ?? fallback)(span.text);
  const filled = span.background === undefined ? coloured : bg(span.background)(coloured);
  const emboldened = span.bold === true ? bold(filled) : filled;
  const slanted = span.italic === true ? italic(emboldened) : emboldened;
  return span.underline === true ? underline(slanted) : slanted;
}

/** Normalize one cell — string or run list — into the renderable's chunk list. */
function toCell(cell: TextTableCell, fallback: Color): TextChunk[] {
  if (typeof cell === "string") return [toChunk({ text: cell }, fallback)];
  return cell.map((span) => toChunk(span, fallback));
}

/** The whole content matrix, as fresh mutable arrays the renderable owns. */
function toContent(
  rows: TextTableProps["rows"],
  tokens: TokenMap,
  textColor: Color | undefined,
): TextChunk[][][] {
  const fallback = textColor ?? tokens.foreground;
  return rows.map((row) => row.map((cell) => toCell(cell, fallback)));
}

/**
 * A grid of styled text cells (spec §6.1). Renders the OpenTUI `TextTableRenderable` — a
 * renderable with no intrinsic tag, registered by {@link registerRenderableTags} — which
 * measures its own column widths and wraps inside a cell, which is what it offers over the
 * hand-composed `./table.tsx`.
 *
 * BORDERS ARE OFF BY DEFAULT because the design's tables are borderless column layouts (the
 * shape `./table.tsx` implements from `design/termcraft-engine.js`). With `borders` set, the
 * style is `single` in the `border` token — the same frame vocabulary the design engine draws
 * every panel with.
 *
 * THE RENDERABLE'S OWN DEFAULTS ARE A HARDCODED `#FFFFFF` for both `borderColor` and `fg`, so
 * this wrapper always passes both from the active theme: no raw white can reach a frame.
 *
 * SELECTION IS DISABLED UNCONDITIONALLY (spec §6.3). `TextTableRenderable` defaults
 * `selectable: true` and keeps its own `_lastLocalSelection`, which is exactly the kind of
 * renderer-internal state an export snapshot must not depend on; row selection is `./table.tsx`'s
 * job, driven from props.
 */
export function TextTable(props: TextTableProps) {
  registerRenderableTags();
  const tokens = activeTokens();
  return (
    <text-table
      id={props.id}
      content={toContent(props.rows, tokens, props.textColor)}
      border={props.borders ?? false}
      showBorders={props.borders ?? false}
      borderStyle="single"
      borderColor={props.borderColor ?? tokens.border}
      fg={props.textColor ?? tokens.foreground}
      backgroundColor={props.background}
      columnGap={props.columnGap ?? 1}
      wrapMode={props.wrap ?? "word"}
      cellPadding={props.cellPadding}
      selectable={false}
      width={props.width}
      height={props.height}
    />
  );
}
