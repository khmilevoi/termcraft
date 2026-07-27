/**
 * How many terminal rows a chat line actually occupies once the renderer wraps it.
 *
 * DELIBERATELY NOT `wrapText` (`./turn-timeline.ts`). That function transcribes the DESIGN's own
 * `wrapLines` (`design/termcraft-engine.js:298-301`) and is correct for `AgentStatusBlock`, which
 * pre-wraps its text itself and paints one row per resulting string. `ChatRecord` does the
 * opposite: it hands each line to OpenTUI as ONE `<text wrapMode="word">` and lets the renderer
 * wrap it. The two rules are not the same, so a budget built on `wrapText` under-counts and the
 * scrollback overflows its panel — which is exactly the defect this module exists to prevent.
 *
 * THE RENDERER'S RULE, derived by measuring `ChatRecord` through the real headless renderer
 * (`./text-rows.test.ts` pins the model; `../ui/ChatRecord.test.tsx` pins it against actual
 * rendered output, so a future OpenTUI change fails loudly instead of silently drifting): the
 * wrap is greedy per word, and every word except the final one of the line also reserves the
 * single column of the space that follows it. That is why `"alpha beta"` — exactly 10 columns —
 * still breaks at width 10 when more words follow, but `"epsilon zeta"` — exactly 12 columns —
 * does not break at width 12 when it ends the line.
 *
 * A word wider than the whole width is hard-split across `ceil(len / width)` rows, and the next
 * word is then conservatively placed on a fresh row. The renderer actually continues packing
 * character-wise into the split word's last row; counting a row too many for that rare case
 * (long URLs, long identifiers) costs one row of live-block budget, whereas counting one too few
 * reintroduces the overflow.
 */
import type { MarkdownLine } from "./markdown-lite";

/**
 * The rows a whole parsed markdown-lite body occupies at `width` — one `<text>` per line, each
 * wrapping on its own (`ChatRecord`). The single measure both the scrollback's own tail
 * selection and the workspace's row budget read, so the two can never disagree about how tall a
 * record is.
 */
export function markdownLineRows(lines: readonly MarkdownLine[], width: number): number {
  return lines.reduce(
    (rows, line) => rows + renderedRowCount(line.spans.map((span) => span.text).join(""), width),
    0,
  );
}

export function renderedRowCount(text: string, width: number): number {
  // `width <= 0` is not a real layout, and it must never become an infinite split loop —
  // the same hole `wrapText` documents and closes on its own side.
  if (width <= 0) return 1;

  const words = text.split(" ");
  let rows = 1;
  let used = 0;

  words.forEach((word, index) => {
    const isFinal = index === words.length - 1;
    // The word plus the space that will follow it, unless it ends the line.
    const cost = word.length + (isFinal ? 0 : 1);

    if (word.length > width) {
      if (used > 0) rows += 1;
      rows += Math.ceil(word.length / width) - 1;
      used = width; // force the next word onto a fresh row (see this module's own doc)
      return;
    }
    if (used === 0) {
      used = cost;
      return;
    }
    if (used + cost <= width) {
      used += cost;
      return;
    }
    rows += 1;
    used = cost;
  });

  return rows;
}
