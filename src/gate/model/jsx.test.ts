import { describe, expect, test } from "bun:test";

import { computeJsxTextTokenIndices, readHyphenatedName, scanOpenTag } from "./jsx";
import { tokenize } from "./lexer";

describe("scanOpenTag (shared JSX open-tag recognizer)", () => {
  test("a self-closing tag reports selfClosing: true", () => {
    const toks = tokenize(`<box color="fg" />`);
    const scan = scanOpenTag(toks, 0, `<box color="fg" />`);
    expect(scan?.selfClosing).toBe(true);
  });

  test("a non-self-closing tag reports selfClosing: false and the terminator's token index", () => {
    const src = `<box>x</box>`;
    const toks = tokenize(src);
    const scan = scanOpenTag(toks, 0, src);
    expect(scan?.selfClosing).toBe(false);
    // toks: `<`(0) `box`(1) `>`(2) `x`(3) `<`(4) `/`(5) `box`(6) `>`(7)
    expect(scan?.terminatorIndex).toBe(2);
  });

  test("not a real tag (a relational `<`) still returns null", () => {
    const src = `a < b\n`;
    const toks = tokenize(src);
    expect(scanOpenTag(toks, 1, src)).toBeNull();
  });
});

describe("readHyphenatedName", () => {
  test("merges a hyphenated identifier chain into one name", () => {
    const toks = tokenize(`data-id`);
    expect(readHyphenatedName(toks, 0)?.name).toBe("data-id");
  });

  test("returns null when not starting at an Identifier", () => {
    const toks = tokenize(`"x"`);
    expect(readHyphenatedName(toks, 0)).toBeNull();
  });
});

describe("computeJsxTextTokenIndices (WP-6a fix-pass-2, Important 1)", () => {
  function textValuesOf(source: string): string[] {
    const toks = tokenize(source);
    const idx = computeJsxTextTokenIndices(toks, source);
    return [...idx].sort((a, b) => a - b).map((i) => toks[i]!.value || `<${toks[i]!.kind}>`);
  }

  test("children text between a tag's `>` and its closing tag is marked", () => {
    expect(textValuesOf(`<Text id="t">hello world</Text>`)).toEqual(["hello", "world"]);
  });

  test("a self-closing tag has no text region at all", () => {
    expect(textValuesOf(`<box color="fg" />`)).toEqual([]);
  });

  test("an expression container's contents are never marked as text", () => {
    expect(textValuesOf(`<Text id="t">{eval("1")}</Text>`)).toEqual([]);
  });

  test("text either side of an expression container is marked, the container itself is not", () => {
    const values = textValuesOf(`<Text id="t">before{x}after</Text>`);
    expect(values).toEqual(["before", "after"]);
  });

  test("nested elements are each recognized independently, their own text marked", () => {
    const toks = tokenize(`<box>hello<text id="t">world</text></box>`);
    const idx = computeJsxTextTokenIndices(toks, `<box>hello<text id="t">world</text></box>`);
    const values = [...idx].map((i) => toks[i]!.value);
    expect(values.sort()).toEqual(["hello", "world"]);
  });

  test("an unclosed, tag-shaped generic (`Array<Foo>`) marks nothing — no matching close ever appears", () => {
    expect(textValuesOf(`let xs: Array<Foo> = []\nconst z = eval("2")\n`)).toEqual([]);
  });

  test("a mismatched closing-tag name is not treated as a match — nothing is marked", () => {
    expect(textValuesOf(`<box>hi</text>\nconst z = eval("2")\n`)).toEqual([]);
  });

  test("a bare Fragment's children text is marked too, even though scanOpenTag itself does not name it", () => {
    expect(textValuesOf(`<>hello world</>`)).toEqual(["hello", "world"]);
  });

  test("a Fragment nested inside a named element is recognized independently", () => {
    const src = `<box><>hello</></box>`;
    const toks = tokenize(src);
    const idx = computeJsxTextTokenIndices(toks, src);
    expect([...idx].map((i) => toks[i]!.value)).toEqual(["hello"]);
  });

  test("an unclosed bare Fragment marks nothing (same matching-close discipline as named tags)", () => {
    expect(textValuesOf(`<>\nconst z = eval("2")\n`)).toEqual([]);
  });
});
