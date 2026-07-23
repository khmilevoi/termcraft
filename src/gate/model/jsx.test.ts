import { describe, expect, test } from "bun:test";

import { computeJsxTextTokenIndices, readHyphenatedName, scanJsx } from "./jsx";
import { tokenize } from "./lexer";

describe("scanJsx (real recursive-descent JSX reader over the TypeScript scanner, WP-6a fix-pass-3)", () => {
  test("a self-closing tag reports its tag name, id presence, and own `<` position", () => {
    const { elements } = scanJsx(`<box color="fg" />`);
    expect(elements).toEqual([{ tagName: "box", hasId: false, pos: 0 }]);
  });

  test("a non-self-closing tag with a matching close reports the same shape", () => {
    const { elements } = scanJsx(`<box id="b">x</box>`);
    expect(elements).toEqual([{ tagName: "box", hasId: true, pos: 0 }]);
  });

  test("not a real tag (a relational `<`) reports no element at all", () => {
    expect(scanJsx(`a < b\n`).elements).toEqual([]);
  });

  test("an uncalled generic type argument (`Array<Foo>`) is never attempted as a tag", () => {
    // The identifier `Array` right before `<` already ends a primary
    // expression (`endsExpression`), so `scanJsx` never even tries reading
    // `Foo` as a tag name — the fix-pass-3 fix for the "dangling `</Foo>`"
    // gap (see `import-scan.test.ts`'s fix-pass-3 describe block).
    expect(scanJsx(`let xs: Array<Foo> = []\n`).elements).toEqual([]);
  });

  test("a generic call (`useRef<T>(null)`) is never attempted as a tag either", () => {
    expect(scanJsx(`const ref = useRef<T>(null)\n`).elements).toEqual([]);
  });

  test("an `id` attribute bound to an expression container still counts as present", () => {
    const { elements } = scanJsx(`<box id={rowId} />`);
    expect(elements).toEqual([{ tagName: "box", hasId: true, pos: 0 }]);
  });

  test("a mismatched closing tag name means no element is reported at all", () => {
    expect(scanJsx(`<box>hi</text>\n`).elements).toEqual([]);
  });

  test("an unterminated open tag (no matching close, runs to EOF) reports nothing", () => {
    expect(scanJsx(`<box>hi\n`).elements).toEqual([]);
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

describe("computeJsxTextTokenIndices (WP-6a fix-pass-2, Important 1; reader rebuilt fix-pass-3)", () => {
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

  test("an unclosed, tag-shaped generic (`Array<Foo>`) marks nothing — never even attempted as a tag", () => {
    expect(textValuesOf(`let xs: Array<Foo> = []\nconst z = eval("2")\n`)).toEqual([]);
  });

  test("a dangling close tag left over from an uncalled generic does not launder real code as text (fix-pass-3)", () => {
    // Before fix-pass-3: `Array<Foo>` read as a plausible childless open tag,
    // and this LATER, unrelated `</Foo>` was accepted as its matching close,
    // marking everything in between (including the real `eval("2")`) as text.
    expect(textValuesOf(`let xs: Array<Foo> = []\nconst z = eval("2")\n</Foo>\n`)).toEqual([]);
  });

  test("a mismatched closing-tag name is not treated as a match — nothing is marked", () => {
    expect(textValuesOf(`<box>hi</text>\nconst z = eval("2")\n`)).toEqual([]);
  });

  test("a bare Fragment's children text is marked too, even though it names no tag", () => {
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

  describe("prose containing code-mode punctuation still closes the tag correctly (fix-pass-3)", () => {
    test("an apostrophe (`isn't`) does not open a code-mode string that swallows the closing tag", () => {
      const idx = computeJsxTextTokenIndices(
        tokenize(`<Text id="t">eval isn't allowed here</Text>`),
        `<Text id="t">eval isn't allowed here</Text>`,
      );
      expect(idx.size).toBeGreaterThan(0);
    });

    test("`//` does not open a code-mode line comment that swallows the closing tag", () => {
      const src = `<Text id="t">eval // never</Text>`;
      const idx = computeJsxTextTokenIndices(tokenize(src), src);
      expect(idx.size).toBeGreaterThan(0);
    });
  });
});
