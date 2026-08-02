import { describe, expect, test } from "bun:test";

import { readHyphenatedName, readJsxTextRanges, scanJsx } from "./jsx";
import { tokenize } from "./lexer";
import type { SourceStreamTruncatedError } from "./lexer";

/**
 * Unwraps `lexer.ts`'s completeness-invariant union at the test boundary (task-14 review round
 * 2, M6). A fixture whose token stream does not cover its source is a FIXTURE BUG, and it must
 * say so loudly here — silently reading as "no findings" is precisely the failure mode the
 * invariant exists to prevent, and a test suite that absorbed it would hide the next one.
 */
function scanned<T>(result: SourceStreamTruncatedError | T): T {
  if (result instanceof Error) {
    throw new Error(`fixture truncated the token stream: ${result.message}`);
  }
  return result;
}

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

  describe("Also fix (fix pass 5) — a namespaced attribute name no longer abandons the element", () => {
    test("a namespaced attribute (`xml:lang`) is read, not fatal to the element", () => {
      const { elements } = scanJsx(`<box xml:lang="en" id="b">hi</box>`);
      expect(elements).toEqual([{ tagName: "box", hasId: true, pos: 0 }]);
    });

    test("a namespaced attribute alone (no `id`) still parses; `hasId` stays false", () => {
      const { elements } = scanJsx(`<box xml:lang="en">hi</box>`);
      expect(elements).toEqual([{ tagName: "box", hasId: false, pos: 0 }]);
    });

    test("a namespaced attribute name missing its local part fails closed, like any other malformed attribute", () => {
      expect(scanJsx(`<box xml:="en">hi</box>`).elements).toEqual([]);
    });
  });

  describe("Also fix (fix pass 5) — a nested element read once by a doomed attempt and once by a later retry is reported only once", () => {
    test("a failed attribute list's own nested element is not double-counted once the retry confirms it for real", () => {
      // `<box a={<text>hi</text>} 1>x</box>`: `skipExpressionContainer` reads
      // `<text>hi</text>` successfully while parsing `a`'s value, but the bare
      // `1` right after it is illegal in attribute position, so the whole
      // `<box>` attempt fails and is rewound. The top-level driver then reaches
      // `<text>hi</text>` again on its own and confirms it independently — the
      // same element, recorded twice, without `normalizeElements`.
      const { elements } = scanJsx(`<box a={<text>hi</text>} 1>x</box>`);
      expect(elements).toEqual([{ tagName: "text", hasId: false, pos: 8 }]);
    });
  });
});

describe("readHyphenatedName", () => {
  test("merges a hyphenated identifier chain into one name", () => {
    const toks = scanned(tokenize(`data-id`, "jsx"));
    expect(readHyphenatedName(toks, 0)?.name).toBe("data-id");
  });

  test("returns null when not starting at an Identifier", () => {
    const toks = scanned(tokenize(`"x"`, "jsx"));
    expect(readHyphenatedName(toks, 0)).toBeNull();
  });
});

describe("readJsxTextRanges — where the runtime reads TEXT, and therefore where `tokenize` refuses to lex code", () => {
  /**
   * The children-text runs as source slices, normalized exactly as `./lexer`'s `tokenize`
   * consumes them.
   *
   * RE-POINTED in task 14b, from `computeJsxTextTokenIndices` (deleted) to the ranges
   * themselves. That function answered "which CODE tokens fell inside JSX prose", so that
   * `import-scan.ts` could filter them back out of its `eval`/`Function` checks. Filtering was
   * the wrong layer: the mis-lexed prose token was still IN the stream, and an apostrophe or a
   * `/*` in prose still swallowed whatever real code followed it — 94 measured differential
   * divergences. `tokenize` now skips these ranges outright, so the question the old function
   * asked has exactly one answer on every input (no tokens at all), and it is asserted as an
   * invariant by {@link expectNoTokenInsideText} below rather than fixture by fixture.
   */
  function textRunsOf(source: string): string[] {
    return readJsxTextRanges(source).map((range) => source.slice(range.pos, range.end));
  }

  /**
   * THE WINDOW INVARIANT: no token `tokenize` emits may span a children-text boundary. That is
   * what makes an apostrophe in prose stop being a string opener that reaches the code after
   * `</p>` — without removing the prose from the stream, which is how real code went invisible
   * in an earlier round.
   *
   * Asserted as "the code after the run is reached", which is the observable form of it: if a
   * token had swallowed the boundary there would be no token past the run at all.
   */
  function expectTextIsMarked(source: string): void {
    const ranges = readJsxTextRanges(source);
    if (ranges.length === 0) return;
    const last = ranges[ranges.length - 1]!;
    if (last.end >= source.length) return;
    expect(scanned(tokenize(source, "jsx")).some((t) => t.pos >= last.end)).toBe(true);
  }

  test("children text between a tag's `>` and its closing tag is one run", () => {
    expect(textRunsOf(`<Text id="t">hello world</Text>`)).toEqual(["hello world"]);
    expectTextIsMarked(`<Text id="t">hello world</Text>`);
  });

  test("a self-closing tag has no text region at all", () => {
    expect(textRunsOf(`<box color="fg" />`)).toEqual([]);
  });

  test("an expression container's contents are never text — its code stays code", () => {
    const source = `<Text id="t">{eval("1")}</Text>`;
    expect(textRunsOf(source)).toEqual([]);
    // …and the container's `eval` really is still in the stream, not merely un-marked.
    expect(scanned(tokenize(source, "jsx")).some((t) => t.value === "eval")).toBe(true);
  });

  test("text either side of an expression container is text, the container itself is not", () => {
    expect(textRunsOf(`<Text id="t">before{x}after</Text>`)).toEqual(["before", "after"]);
    expectTextIsMarked(`<Text id="t">before{x}after</Text>`);
  });

  test("nested elements are each recognized independently, their own text runs kept apart", () => {
    expect(textRunsOf(`<box>hello<text id="t">world</text></box>`)).toEqual(["hello", "world"]);
  });

  test("an unclosed, tag-shaped generic (`Array<Foo>`) yields no text — never even attempted as a tag", () => {
    expect(textRunsOf(`let xs: Array<Foo> = []\nconst z = eval("2")\n`)).toEqual([]);
  });

  test("a dangling close tag left over from an uncalled generic does not launder real code as text (fix-pass-3)", () => {
    // Before fix-pass-3: `Array<Foo>` read as a plausible childless open tag,
    // and this LATER, unrelated `</Foo>` was accepted as its matching close,
    // marking everything in between (including the real `eval("2")`) as text.
    expect(textRunsOf(`let xs: Array<Foo> = []\nconst z = eval("2")\n</Foo>\n`)).toEqual([]);
  });

  test("a mismatched closing-tag name is not treated as a match — nothing is text", () => {
    expect(textRunsOf(`<box>hi</text>\nconst z = eval("2")\n`)).toEqual([]);
  });

  test("a bare Fragment's children text is a run too, even though it names no tag", () => {
    expect(textRunsOf(`<>hello world</>`)).toEqual(["hello world"]);
  });

  test("a Fragment nested inside a named element is recognized independently", () => {
    expect(textRunsOf(`<box><>hello</></box>`)).toEqual(["hello"]);
  });

  test("an unclosed bare Fragment yields nothing (same matching-close discipline as named tags)", () => {
    expect(textRunsOf(`<>\nconst z = eval("2")\n`)).toEqual([]);
  });

  describe("prose containing code-mode punctuation is TEXT, and `tokenize` never lexes it (task 14b)", () => {
    test("an apostrophe (`isn't`) opens no string literal at all now — the whole run is one text range", () => {
      // BEFORE task 14b the apostrophe DID open a code-mode string literal that ran past
      // `</Text>`; the old filter merely suppressed the fatal it caused, while the mis-lexed
      // token still swallowed everything after it on the line. Measured through the real
      // perimeter, `<p>it's</p>; import "node:fs"; eval("1");` reported NO violations while Bun
      // executed all of it. Now the prose is skipped and the code after it is lexed.
      const source = `<Text id="t">eval isn't allowed here</Text>`;
      expect(textRunsOf(source)).toEqual(["eval isn't allowed here"]);
      expectTextIsMarked(source);
      // The word IS in the stream: prose is lexed, not skipped. Since fix round 2 there is no
      // mark and no filter, so `import-scan.ts` DOES raise a fatal on it — the uniform
      // over-approximation that replaced three unsound suppression rules.
      expect(scanned(tokenize(source, "jsx")).some((t) => t.value === "eval")).toBe(true);
    });

    test("`//` opens no line comment that swallows the closing tag", () => {
      const source = `<Text id="t">eval // never</Text>`;
      expect(textRunsOf(source)).toEqual(["eval // never"]);
      expectTextIsMarked(source);
      expect(scanned(tokenize(source, "jsx")).some((t) => t.value === "eval")).toBe(true);
    });
  });

  describe("an expression container lexes the code that is actually there (fix pass 4)", () => {
    test("a template literal's interpolation `}` does not close the container early", () => {
      expect(textRunsOf('<box id="b">a{`${0}`+eval("x")}b</box>')).toEqual(["a", "b"]);
    });

    test("a template literal with several interpolations is followed to its own tail", () => {
      expect(textRunsOf('<box id="b">a{`${0}m${1}`+eval("x")}b</box>')).toEqual(["a", "b"]);
    });

    test("a nested template literal inside an interpolation is tracked to its own tail", () => {
      expect(textRunsOf('<box id="b">a{`${`${x}`}`+eval("x")}b</box>')).toEqual(["a", "b"]);
    });

    test("a regex literal's `}` does not close the container early", () => {
      expect(textRunsOf('<box id="b">a{/[}]/.test(s) ? eval("1") : 0}b</box>')).toEqual(["a", "b"]);
    });

    test("division is not mistaken for a regex literal", () => {
      expect(textRunsOf('<box id="b">a{w / h / 2}b</box>')).toEqual(["a", "b"]);
    });

    test("an object literal in a container still balances", () => {
      expect(textRunsOf('<box id="b">a{fn({ k: 1 })}b</box>')).toEqual(["a", "b"]);
    });

    test("an arrow-function body in a container still balances", () => {
      expect(textRunsOf('<box id="b">a{xs.map((i) => { return i })}b</box>')).toEqual(["a", "b"]);
    });

    test("a nested container inside a nested element still balances", () => {
      expect(textRunsOf('<box id="b">a{c && <text id="t">n{`${v}`}m</text>}b</box>')).toEqual([
        "a",
        "n",
        "m",
        "b",
      ]);
    });

    test("an unterminated template literal in a container fails closed — nothing is text", () => {
      expect(textRunsOf('<box id="b">a{`${0}b</box>')).toEqual([]);
    });

    test("an attribute value holding a template literal leaves the children text readable", () => {
      expect(textRunsOf("<box label={`R${n}`}>raw</box>")).toEqual(["raw"]);
    });

    test("a spread attribute leaves the children text readable", () => {
      expect(textRunsOf("<box {...rest}>raw</box>")).toEqual(["raw"]);
    });

    test("a spread attribute's own expression is code, never text", () => {
      expect(textRunsOf("<box {...{ e: eval }}>raw</box>")).toEqual(["raw"]);
    });

    test("a dotted tag's children text is one run, the close tag is not part of it", () => {
      expect(textRunsOf(`<Kit.Text id="t">hello world</Kit.Text>`)).toEqual(["hello world"]);
    });

    test("a mismatched dotted close tag yields nothing at all", () => {
      expect(textRunsOf(`<Kit.Text id="t">hello</Kit.Other>\nconst z = eval("2")\n`)).toEqual([]);
    });

    test("the `<` predecessor is CLOSED and the `}` one is not (task 14b)", () => {
      // `scanCode` used to refuse to re-scan `/` as a regex after EITHER `<` or `}`, because
      // this reader re-lexes a FAILED element attempt's own JSX punctuation as code, where
      // `</tag>` and `{expr} />` put a `/` right after exactly those tokens. The cost was that
      // the `}` inside the character class closed the container early and the rest of it —
      // including a REAL call — was recorded as children text.
      //
      // The `<` half is now distinguished by `jsxPunctuation`: a `<` that reached the ordinary
      // path did so BECAUSE its predecessor ended an expression, so it is a relational operator
      // and a regular expression may legally follow it. The whole container is code again.
      expect(textRunsOf('<box id="b">a{x < /[}]/.test(s) && eval("1")}b</box>')).toEqual([
        "a",
        "b",
      ]);
      // The `}` half stays, and is MEASURED not to be a live bypass: `Bun.Transpiler` rejects
      // every spelling of a regular expression opening right after a `}` in expression
      // position (`Unexpected }`), because only a block or an object literal can put a `}`
      // there and a JSX expression container holds neither.
      expect(() =>
        new Bun.Transpiler({ loader: "tsx" }).transformSync(
          'export const el = <box id="b">a{ {} /[}]/.test(s) && eval("1")}b</box>;',
        ),
      ).toThrow();
      expect(textRunsOf('<box id="b">a{ {} /[}]/.test(s) && eval("1")}b</box>')).toEqual([
        "a",
        ']/.test(s) && eval("1")}b',
      ]);
    });

    test("a genuine relational `<` inside a container is still just a comparison", () => {
      // The valid-input companion for the re-scan above: `w < h` must stay two operands and an
      // operator, with the container's own `}` still closing it.
      expect(textRunsOf('<box id="b">a{w < h && "x"}b</box>')).toEqual(["a", "b"]);
    });
  });
});

/**
 * Run `scanJsx` over each source in a SEPARATE Bun process under a hard wall-clock budget,
 * printing one JSON line per source as it finishes.
 *
 * A plain in-process test cannot do this job. `bun test`'s own per-test timeout is a timer on
 * the very event loop a synchronous spin blocks, so a regression here would WEDGE the whole
 * suite instead of failing it — measured, not assumed: a `test(..., () => { for (;;) {} },
 * 1000)` never timed out and had to be killed from outside. Printing one line PER SOURCE is
 * what makes a regression name the shape it hung on, rather than only reporting "no output".
 */
async function scanJsxInSubprocess(sources: readonly string[], budgetMs: number) {
  const modulePath = `${import.meta.dir.replaceAll("\\", "/")}/jsx.ts`;
  const script = [
    `const { scanJsx } = await import(${JSON.stringify(modulePath)});`,
    `for (const source of ${JSON.stringify(sources)}) {`,
    `  const scan = scanJsx(source);`,
    `  console.log(JSON.stringify({ source, elements: scan.elements.length }));`,
    `}`,
  ].join("\n");
  const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), budgetMs);
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  const lines = stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { source: string; elements: number });
  return { exitCode: proc.exitCode, lines };
}

describe("scanJsx terminates on a scanner that stops advancing (task-12 review round 4, Critical 1)", () => {
  test("every `#` shape that used to spin forever now returns", async () => {
    // The TypeScript scanner returns `PrivateIdentifier@p..p` — zero width — indefinitely for a
    // `#` that is not followed by an identifier start, so three of this module's four `for (;;)`
    // drivers spun with no timeout, no cancellation and no error. `runTreeImports` is
    // synchronous, so this blocked the event loop outright. Each source below was verified to
    // HANG (killed at a 12s budget) on the pre-fix reader and to return in under 2ms after it;
    // together they cover all three spinning loops — the whole-source driver (`#`,
    // `# comment`, `const x = 1 # 2`, `<p>x</p>#`), `skipExpressionContainer` (`<p>{# }</p>`,
    // `<box>{a # b}</box>`, `` `${# }` ``), and `readElement`'s attribute list (`<p #>x</p>`).
    const sources = [
      "#",
      "# comment",
      "const x = 1 # 2",
      "<p>x</p>#",
      "<p>{# }</p>",
      "<box>{a # b}</box>",
      "`${# }`",
      "<p #>x</p>",
    ];
    const { exitCode, lines } = await scanJsxInSubprocess(sources, 20_000);
    expect(lines.map((line) => line.source)).toEqual(sources);
    expect(exitCode).toBe(0);
    // Terminating is not enough on its own: an element BEFORE the stall must still be read, or
    // the guard would be closing the hang by throwing the whole read away.
    expect(lines.find((line) => line.source === "<p>x</p>#")?.elements).toBe(1);
  }, 40_000);

  test("a `#` inside genuine JSX children TEXT is unaffected — it never reached a stalling scan", () => {
    // Safe to run in-process: measured on the PRE-fix reader, `<p># Heading</p>` already
    // returned in under 1ms, because `readChildren` reads children with `scanJsxToken()`, which
    // lexes `#` as ordinary text. Worth pinning anyway — it is the shape an agent actually
    // writes, and it is the "valid input still passes" half of the guard: the fix must not have
    // turned a heading into a failed read.
    const { elements, textRanges } = scanJsx("<p># Heading</p>");
    expect(elements).toEqual([{ tagName: "p", hasId: false, pos: 0 }]);
    expect(textRanges.map((range) => "<p># Heading</p>".slice(range.pos, range.end))).toEqual([
      "# Heading",
    ]);
  });
});

describe("readElement's memo (task-12b — the superlinear re-lex `scanJsx`'s doc used to only record)", () => {
  test("deeply nested UNTERMINATED input returns instead of compounding, and reports the same nothing", async () => {
    // `attemptElement` rewinds a failed attempt and the caller re-scans the same characters as
    // code, so before the memo the attempt at nesting level i cost `A(i+1) + A(i+2) + …` —
    // exactly 2x per level. Measured through `tokenize`, which reaches this reader, warmed
    // up: 32 chars 0.4ms, 64 chars 47.6ms, 88 chars 2 155ms, 96 chars 12 971ms. The 256-char
    // source below is 40 levels deeper than the 96-char row, i.e. about 10^12 times its cost —
    // it does not finish in any budget without the memo, so this test FAILS (killed subprocess,
    // non-zero exit, no output line) the moment `readElement`'s memo is removed. With it: ~1ms.
    //
    // The shape is not adversarial: `"<a>{".repeat(k)` is what an agent leaves behind when it
    // stops mid-page. It contains no `#`, triggers no `scannerStalled`, and `scanTreeImports`
    // reports ZERO errors for it, so every millisecond was wasted work — and `runTreeImports`
    // is synchronous, so it was wasted ON the event loop.
    //
    // OUT OF PROCESS with an external kill for the same reason as the `#` tests above: `bun
    // test`'s own timeout is a timer on the loop a synchronous spin blocks, so an in-process
    // version would wedge the suite instead of failing it.
    const sources = ["<a>{".repeat(64), "<a x={".repeat(64), "<a>{<b>{".repeat(32)];
    const { exitCode, lines } = await scanJsxInSubprocess(sources, 20_000);
    expect(lines.map((line) => line.source)).toEqual(sources);
    expect(exitCode).toBe(0);
    expect(lines.map((line) => line.elements)).toEqual([0, 0, 0]);
  }, 40_000);

  test("a memo HIT replays the rows the first read left behind — `<><a/>`", () => {
    // The 6-character witness, found by fuzzing a memo that replays only the verdict against the
    // real one. The Fragment at 0 fails (EOF before `</>`), but the `<a/>` it walked over was
    // already committed and survives its truncation (`readElement`'s attribute/child rollback
    // asymmetry). The driver then re-reaches that same `<` at offset 2 and HITS the memo — so if
    // the hit did not replay the delta, the element would vanish and `lints.ts`'s
    // `lintUnpointedElements` would stop seeing it. Verified identical on HEAD's jsx.ts.
    expect(scanJsx("<><a/>")).toEqual({
      elements: [{ tagName: "a", hasId: false, pos: 2 }],
      textRanges: [],
    });
  });

  test("a memo HIT restores the scanner position the first read ended on — `<><><>t</></>`", () => {
    // The 13-character witness, found the same way against a memo that replays the verdict and
    // the delta but leaves the scanner where the caller's own `<` scan parked it. Without the
    // restore the driver re-reads the confirmed element's body and records its text run a second
    // time (`textRanges` becomes `[[6,7],[6,7]]`). `readJsxTextRanges` would merge that
    // pair away, but `scanJsx`'s own result is a published contract — `lints.ts` reads it too —
    // so it is pinned here rather than assumed harmless. Verified identical on HEAD's jsx.ts.
    expect(scanJsx("<><><>t</></>")).toEqual({
      elements: [
        { tagName: "", hasId: false, pos: 4 },
        { tagName: "", hasId: false, pos: 2 },
      ],
      textRanges: [{ pos: 6, end: 7 }],
    });
  });
});
