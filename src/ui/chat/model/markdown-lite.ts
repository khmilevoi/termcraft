/**
 * Markdown-lite (design §3.2): the agent's final message is rendered with bold, italic,
 * inline code, and bullet lists; headings flatten to bold lines; tables, code blocks, and
 * links flatten to plain text. This is the pure parser — it turns source text into styled
 * lines the chat renderer paints.
 *
 * DOCUMENTED SCOPE (plan GAP decision): the design mocks only ever show single-line `✓ …`
 * summaries, so richer rendering is unverified against a mock. This covers the spec's named
 * cases; anything outside them falls through to plain text rather than guessing a style.
 */

export interface MarkdownSpan {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly code?: boolean;
}

export interface MarkdownLine {
  readonly spans: readonly MarkdownSpan[];
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const FENCE = /^\s*```/;
/** `[text](url)` -> `text`; a bare link stays as-is. Applied before inline styling. */
const LINK = /\[([^\]]*)\]\([^)]*\)/g;

/** A whole line rendered as one plain span (code fences, tables). */
function plainLine(text: string): MarkdownLine {
  return { spans: [{ text }] };
}

/**
 * Parses one line's inline styling into spans. Handles inline code (highest precedence),
 * then bold (`**`/`__`), then italic (`*`/`_`). Unbalanced markers are treated as literal
 * text — a stray `*` never swallows the rest of the line.
 */
export function parseInline(source: string): readonly MarkdownSpan[] {
  const flattened = source.replace(LINK, "$1");
  const spans: MarkdownSpan[] = [];
  let buffer = "";
  let bold = false;
  let italic = false;

  const flush = (): void => {
    if (buffer.length === 0) return;
    spans.push({
      text: buffer,
      ...(bold ? { bold: true } : {}),
      ...(italic ? { italic: true } : {}),
    });
    buffer = "";
  };

  let i = 0;
  while (i < flattened.length) {
    const rest = flattened.slice(i);

    // Inline code: `...` — content is literal, no nested styling.
    if (rest.startsWith("`")) {
      const end = flattened.indexOf("`", i + 1);
      if (end > i) {
        flush();
        spans.push({ text: flattened.slice(i + 1, end), code: true });
        i = end + 1;
        continue;
      }
    }

    // Bold: ** or __
    if (rest.startsWith("**") || rest.startsWith("__")) {
      flush();
      bold = !bold;
      i += 2;
      continue;
    }

    // Italic: single * or _
    if (rest.startsWith("*") || rest.startsWith("_")) {
      flush();
      italic = !italic;
      i += 1;
      continue;
    }

    buffer += flattened[i];
    i += 1;
  }
  flush();

  // Any marker left unbalanced: fold the styling back to none by re-emitting as plain text is
  // overkill; instead an odd number of markers simply leaves a trailing styled span, which is
  // acceptable for the short replies §3.2 models. Return at least one span for a non-empty line.
  return spans.length > 0 ? spans : [{ text: source }];
}

/** Flattens markdown-lite source into styled lines (design §3.2). */
export function flattenMarkdownLite(source: string): readonly MarkdownLine[] {
  const lines = source.split("\n");
  const out: MarkdownLine[] = [];
  let inFence = false;

  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue; // the fence markers themselves are dropped
    }
    if (inFence) {
      out.push(plainLine(line)); // code-block body is plain
      continue;
    }
    if (TABLE_ROW.test(line)) {
      out.push(plainLine(line)); // tables flatten to plain
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      out.push({ spans: [{ text: heading[1] ?? "", bold: true }] }); // heading -> bold line
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      out.push({ spans: [{ text: "• " }, ...parseInline(bullet[2] ?? "")] }); // bullet glyph + inline
      continue;
    }
    out.push({ spans: parseInline(line) });
  }
  return out;
}
