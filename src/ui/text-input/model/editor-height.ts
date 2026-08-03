/**
 * The editor's vertical budget: how tall the composer / Home prompt may grow, and how many
 * visual rows a given string occupies inside a given width.
 *
 * APPROVED DESIGN DIVERGENCE (spec §3 — recorded, not assumed). `design/termcraft-engine.js`
 * draws the composer as a fixed four-row block anchored at `frameH - 4` (`drawChat` `:222`,
 * `workspace` `:570`) with the input on exactly ONE row (`composerTop + 2`, `:256`, `:594`), and
 * none of the 27 `design/*.dc.html` frames shows a multi-row, grown, or scrolled input. The
 * divergence: the editor takes one row while the text fits one row, grows downward to
 * {@link editorMaxRows}, and scrolls internally past it. The ceiling is a PROPORTION rather than
 * a bare constant because at `MIN_FRAME` (80×24) a fixed six rows would squeeze the scrollback to
 * nothing while `agentStatusMaxRows` sat on its floor of 3. At one row every derived value
 * reduces to today's numbers exactly, so the single-row case stays pixel-identical to the design.
 */

/** The largest number of rows the editor may occupy in a frame `frameH` rows tall. */
export function editorMaxRows(frameH: number): number {
  return Math.min(6, Math.max(1, Math.floor(frameH / 4)));
}

/**
 * Display width in terminal cells.
 *
 * `Bun.stringWidth`, not `String.length`: a CJK or emoji line is twice as wide as its code-unit
 * count and would desynchronise this counter from the native layout. `@opentui/core` has its own
 * `stringWidth` but does not export it — it is declared in `platform/runtime.d.ts` while the
 * package index re-exports only `resolveBundledFilePath` from that file, and `package.json`'s
 * `exports` map has no wildcard, so a deep import cannot reach it either. Bun's built-in is the
 * same measurement and is already this project's only ambient type set (`tsconfig.json`'s
 * `"types": ["bun"]`).
 */
function cellWidth(value: string): number {
  return Bun.stringWidth(value);
}

/**
 * One logical line's tokens: maximal runs of non-space characters, and each space on its own.
 *
 * A space is its own token because that is what the native layout does with one carried past a
 * wrap — `"aaaa bbbb"` at width 4 measures THREE rows, not two, because the space that no longer
 * fits after `aaaa` occupies the first cell of the next row rather than being swallowed.
 */
function tokenize(line: string): readonly string[] {
  return line.match(/ |[^ ]+/g) ?? [];
}

/** Visual rows for ONE logical line, stopping as soon as `budget` rows have been reached. */
function wrapRows(line: string, width: number, budget: number): number {
  if (line === "") return 1;
  let rows = 1;
  let used = 0;
  for (const token of tokenize(line)) {
    if (rows >= budget) return rows;
    const tokenWidth = cellWidth(token);
    if (used + tokenWidth <= width) {
      used += tokenWidth;
      continue;
    }
    if (tokenWidth <= width) {
      rows += 1;
      used = tokenWidth;
      continue;
    }
    // Wider than the whole viewport: the native layout moves it to a fresh row first and only
    // then breaks it by display width (measured: `"ab cdefghijklmnopqr"` at width 10 is 3 rows,
    // not the 2 a continue-filling model would give).
    if (used > 0) {
      rows += 1;
      used = 0;
    }
    for (const char of token) {
      if (rows >= budget) return rows;
      const charWidth = cellWidth(char);
      if (used + charWidth > width) {
        rows += 1;
        used = 0;
      }
      used += charWidth;
    }
  }
  return rows;
}

/**
 * How many visual rows `text` occupies in a `width`-cell editor: `\n` splits, then each logical
 * line wraps at word boundaries with a character break for a word wider than the viewport.
 *
 * `maxRows` is an EARLY EXIT, not a clamp. The result is `min(true count, maxRows + 1)`, which
 * every caller that clamps to `maxRows` cannot tell apart from the untruncated count — so the
 * cost of counting stops depending on text length, which is what keeps a megabyte paste (§9.4)
 * from being rescanned every frame to produce a number that was going to be clamped to 6 anyway.
 */
export function wrappedLineCount(
  text: string,
  width: number,
  maxRows: number = Number.MAX_SAFE_INTEGER,
): number {
  const limit = Math.max(1, maxRows) + 1;
  const safeWidth = Math.max(1, width);
  let rows = 0;
  for (const line of text.split("\n")) {
    rows += wrapRows(line, safeWidth, limit - rows);
    if (rows >= limit) return limit;
  }
  return rows;
}

/** The row count the editor actually renders at: its wrapped height, clamped to the ceiling. */
export function editorRowCount(input: {
  readonly text: string;
  readonly width: number;
  readonly frameH: number;
}): number {
  const ceiling = editorMaxRows(input.frameH);
  return Math.min(ceiling, wrappedLineCount(input.text, input.width, ceiling));
}
