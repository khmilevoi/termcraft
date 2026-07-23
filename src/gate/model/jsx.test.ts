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

  describe("everyday JSX forms the reader now lexes (fix pass 4)", () => {
    test("a spread attribute is read as an attribute, not a give-up", () => {
      const { elements } = scanJsx(`<box {...rest}>raw</box>`);
      expect(elements).toEqual([{ tagName: "box", hasId: false, pos: 0 }]);
    });

    test("a spread attribute alongside a literal `id` still reports the id", () => {
      const { elements } = scanJsx(`<Text id="t" {...rest}>hi</Text>`);
      expect(elements).toEqual([{ tagName: "Text", hasId: true, pos: 0 }]);
    });

    test("a bare `{expr}` in attribute position is NOT JSX — the element fails closed", () => {
      // Only `{...expr}` is a legal attribute-position container; `{rest}` is
      // not JSX at all, so the reader must keep refusing it.
      expect(scanJsx(`<box {rest}>raw</box>`).elements).toEqual([]);
    });

    test("a dotted (member-expression) tag name is read whole", () => {
      const { elements } = scanJsx(`<Kit.Text id="t">hi</Kit.Text>`);
      expect(elements).toEqual([{ tagName: "Kit.Text", hasId: true, pos: 0 }]);
    });

    test("a three-segment dotted tag name is read whole too", () => {
      const { elements } = scanJsx(`<A.B.C>hi</A.B.C>`);
      expect(elements).toEqual([{ tagName: "A.B.C", hasId: false, pos: 0 }]);
    });

    test("a close tag naming a different member of the same object is not a match", () => {
      expect(scanJsx(`<Kit.Text id="t">hi</Kit.Other>`).elements).toEqual([]);
    });

    test("a close tag dropping the dotted qualifier is not a match either", () => {
      expect(scanJsx(`<Kit.Text id="t">hi</Text>`).elements).toEqual([]);
    });

    test("a dotted tag with a trailing `.` and no member fails closed", () => {
      expect(scanJsx(`<Kit.>hi</Kit.>`).elements).toEqual([]);
    });

    test("an attribute value holding a template literal keeps the element readable", () => {
      const { elements } = scanJsx("<box label={`R${n}`}>raw</box>");
      expect(elements).toEqual([{ tagName: "box", hasId: false, pos: 0 }]);
    });
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

  /** The children-text runs themselves, as source slices — the clearest way to
   * show WHERE a text/code boundary landed, rather than which tokens fell in. */
  function textRunsOf(source: string): string[] {
    return scanJsx(source).textRanges.map((range) => source.slice(range.pos, range.end));
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
      // The apostrophe still opens a CODE-mode string literal that runs past
      // `</Text>` — the code stream is lexed independently — but the whole
      // mis-lexed token starts inside the text range, so every token here is
      // skipped and nothing outside the range is marked.
      expect(textValuesOf(`<Text id="t">eval isn't allowed here</Text>`)).toEqual([
        "eval",
        "isn",
        "t allowed here</Text>",
      ]);
    });

    test("`//` does not open a code-mode line comment that swallows the closing tag", () => {
      // `// never</Text>` is code-mode trivia, so `eval` is the only code token
      // left inside the text range — and it is marked, not read as a reference.
      expect(textValuesOf(`<Text id="t">eval // never</Text>`)).toEqual(["eval"]);
    });
  });

  describe("an expression container lexes the code that is actually there (fix pass 4)", () => {
    test("a template literal's interpolation `}` does not close the container early", () => {
      expect(textValuesOf('<box id="b">a{`${0}`+eval("x")}b</box>')).toEqual(["a", "b"]);
    });

    test("a template literal with several interpolations is followed to its own tail", () => {
      expect(textValuesOf('<box id="b">a{`${0}m${1}`+eval("x")}b</box>')).toEqual(["a", "b"]);
    });

    test("a nested template literal inside an interpolation is tracked to its own tail", () => {
      expect(textValuesOf('<box id="b">a{`${`${x}`}`+eval("x")}b</box>')).toEqual(["a", "b"]);
    });

    test("a regex literal's `}` does not close the container early", () => {
      expect(textValuesOf('<box id="b">a{/[}]/.test(s) ? eval("1") : 0}b</box>')).toEqual([
        "a",
        "b",
      ]);
    });

    test("division is not mistaken for a regex literal", () => {
      expect(textValuesOf('<box id="b">a{w / h / 2}b</box>')).toEqual(["a", "b"]);
    });

    test("an object literal in a container still balances", () => {
      expect(textValuesOf('<box id="b">a{fn({ k: 1 })}b</box>')).toEqual(["a", "b"]);
    });

    test("an arrow-function body in a container still balances", () => {
      expect(textValuesOf('<box id="b">a{xs.map((i) => { return i })}b</box>')).toEqual(["a", "b"]);
    });

    test("a nested container inside a nested element still balances", () => {
      expect(textValuesOf('<box id="b">a{c && <text id="t">n{`${v}`}m</text>}b</box>')).toEqual([
        "a",
        "n",
        "m",
        "b",
      ]);
    });

    test("an unterminated template literal in a container fails closed — nothing is text", () => {
      expect(textValuesOf('<box id="b">a{`${0}b</box>')).toEqual([]);
    });

    test("an attribute value holding a template literal leaves the children text readable", () => {
      expect(textValuesOf("<box label={`R${n}`}>raw</box>")).toEqual(["raw"]);
    });

    test("a spread attribute leaves the children text readable", () => {
      expect(textValuesOf("<box {...rest}>raw</box>")).toEqual(["raw"]);
    });

    test("a spread attribute's own expression is code, never text", () => {
      expect(textValuesOf("<box {...{ e: eval }}>raw</box>")).toEqual(["raw"]);
    });

    test("a dotted tag's children text is marked, the close tag is not", () => {
      expect(textValuesOf(`<Kit.Text id="t">hello world</Kit.Text>`)).toEqual(["hello", "world"]);
    });

    test("a mismatched dotted close tag marks nothing at all", () => {
      expect(textValuesOf(`<Kit.Text id="t">hello</Kit.Other>\nconst z = eval("2")\n`)).toEqual([]);
    });

    test("KNOWN GAP: a regex literal right after `<` or `}` is read as division, hiding a real call just like `)` does", () => {
      // `scanCode` refuses to re-scan `/` as a regex after `<` or `}` because
      // this reader re-lexes a FAILED element attempt's own JSX punctuation as
      // code, where `</tag>` and `{expr} />` put a `/` right after exactly
      // those tokens. The cost is these two shapes: the `}` inside the
      // character class closes the container early, and the rest of the
      // container — including a REAL call, not just a harmless `.source`
      // access — is recorded as children text. All three predecessors (`)`,
      // `<`, `}`) are reachable this way; `)` is pinned at the reachable-call
      // level in `import-scan.test.ts`, alongside these same two.
      expect(textRunsOf('<box id="b">a{x < /[}]/.test(s) && eval("1")}b</box>')).toEqual([
        "a",
        ']/.test(s) && eval("1")}b',
      ]);
      expect(textRunsOf('<box id="b">a{ {} /[}]/.test(s) && eval("1")}b</box>')).toEqual([
        "a",
        ']/.test(s) && eval("1")}b',
      ]);
    });
  });
});
