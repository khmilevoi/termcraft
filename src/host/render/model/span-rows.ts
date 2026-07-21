import type { CapturedLine } from "@opentui/core";

import type { StyledRun } from "../../protocol";
import { attributesToMask } from "./attributes";
import { rgbaToColor } from "./color";

/**
 * Map OpenTUI capture rows to protocol styled rows. Runs are preserved 1:1 (the
 * protocol carries runs, not per-cell records); every span's display widths in a
 * row already tile to the frame width, so no per-cell expansion is needed here.
 */
export function styledRowsFromSpanLines(lines: CapturedLine[]): StyledRun[][] {
  return lines.map((line) =>
    line.spans.map((span) => ({
      text: span.text,
      fg: rgbaToColor(span.fg),
      bg: rgbaToColor(span.bg),
      attrs: attributesToMask(span.attributes),
    })),
  );
}
