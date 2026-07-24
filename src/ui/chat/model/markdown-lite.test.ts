import { describe, expect, test } from "bun:test";

import { flattenMarkdownLite, parseInline } from "./markdown-lite";

describe("parseInline", () => {
  test("plain text is one plain span", () => {
    expect(parseInline("hello world")).toEqual([{ text: "hello world" }]);
  });

  test("**bold** becomes a bold span", () => {
    expect(parseInline("a **b** c")).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " c" },
    ]);
  });

  test("*italic* becomes an italic span", () => {
    expect(parseInline("a *b* c")).toEqual([
      { text: "a " },
      { text: "b", italic: true },
      { text: " c" },
    ]);
  });

  test("`code` becomes a code span with literal content (no nested styling)", () => {
    expect(parseInline("run `npm **install**`")).toEqual([
      { text: "run " },
      { text: "npm **install**", code: true },
    ]);
  });

  test("a link flattens to its text", () => {
    expect(parseInline("see [the docs](https://x.example)")).toEqual([{ text: "see the docs" }]);
  });

  test("combined bold+italic nest", () => {
    const spans = parseInline("**_x_**");
    expect(spans).toEqual([{ text: "x", bold: true, italic: true }]);
  });
});

describe("flattenMarkdownLite", () => {
  test("a heading flattens to a single bold line", () => {
    expect(flattenMarkdownLite("## Overview")).toEqual([
      { spans: [{ text: "Overview", bold: true }] },
    ]);
  });

  test("bullets get a • glyph and keep inline styling", () => {
    const lines = flattenMarkdownLite("- first\n- **second**");
    expect(lines[0]?.spans).toEqual([{ text: "• " }, { text: "first" }]);
    expect(lines[1]?.spans).toEqual([{ text: "• " }, { text: "second", bold: true }]);
  });

  test("a fenced code block renders its body as plain, dropping the fences", () => {
    const lines = flattenMarkdownLite("```ts\nconst x = **1**\n```");
    expect(lines).toEqual([{ spans: [{ text: "const x = **1**" }] }]);
  });

  test("a table row flattens to plain text", () => {
    const lines = flattenMarkdownLite("| a | b |");
    expect(lines).toEqual([{ spans: [{ text: "| a | b |" }] }]);
  });

  test("multi-line prose keeps one line per source line", () => {
    const lines = flattenMarkdownLite("line one\nline two");
    expect(lines).toHaveLength(2);
    expect(lines[0]?.spans).toEqual([{ text: "line one" }]);
  });
});
