import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { readJsxTextRanges } from "./jsx";
import { SK, SourceStreamTruncatedError, TRIVIA_KINDS, type Tok, tokenize } from "./lexer";

/**
 * THE TOKEN-STREAM INVARIANT: the gate's view of a source must cover everything the runtime
 * will execute, and where it cannot the file must fail closed with a typed refusal naming the
 * offset.
 *
 * Every gate scan — the import allowlist, design §5.8's `eval`/`Function` ban, the page
 * contract, the determinism lints — treats `tokenize`'s output as the file, and none of them
 * can check that claim for itself. These tests pin the four mechanisms that make it true, the
 * shapes each one closed, and the valid inputs each one must NOT refuse.
 *
 * MEASURED, NOT ARGUED (task 14b). The four mechanisms were chosen by running a DIFFERENTIAL
 * ORACLE — `lexer.oracle.test.ts` — that compares Bun's own parse of a source against what this
 * function saw, over the repository's own files, a systematic grid of JSX/TS lexing traps, every
 * code point in U+0000..U+02FF, and seeded fuzz. Before them: 94 sources Bun accepts whose
 * `import` and `eval` this perimeter could not see. After: zero, over 24 972 rows.
 */

const FFFD = "�";

/** Everything an attacker wants hidden, after the truncation point. */
const HIDDEN = `import fs from "node:fs"
export const e = eval("1")
export const r = require("child_process")
export const f = new Function("return 1")
`;

/** Unwraps the union — a fixture that truncates where the test does not expect it must say so. */
function toks(source: string): Tok[] {
  const result = tokenize(source);
  if (result instanceof Error) throw new Error(`unexpected truncation: ${result.message}`);
  return result;
}

function kindsIn(source: string): Set<number> {
  return new Set(toks(source).map((t) => t.kind));
}

/** Asserts Bun really would run this source, so a claim about hiding code from it means something. */
function expectBunAccepts(source: string): void {
  expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(source)).not.toThrow();
}

function expectBunRejects(source: string): void {
  expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(source)).toThrow();
}

describe("mechanism 1 — JSX children TEXT is skipped, never lexed as code", () => {
  // This is the mechanism that closes the differential-parse class. In a `.tsx` file Bun reads
  // children text as TEXT; a code-mode lexer started inside it reads the same characters as a
  // string opener, a comment, a template literal or a zero-width private identifier, and each
  // of those then swallows the real code that follows on the same line or to end of file.

  const TRAPS: readonly (readonly [string, string])[] = [
    ["an apostrophe (a code-mode string opener)", "it's"],
    ["a double quote", 'say "hi'],
    ["a backtick (a code-mode template opener)", "`tick"],
    ["`//` (a code-mode line comment)", "a // b"],
    ["an unterminated `/*` (a comment to end of file)", "a /* b"],
    ["a `/*` whose `*/` never comes on this line", "a /* b */ c"],
    ["a hex colour (a zero-width private identifier)", "#7ad7ff"],
    ["U+FFFD (the scanner's binary-file marker)", FFFD],
    ["a lone backslash", "\\ path"],
  ];

  for (const [label, trap] of TRAPS) {
    test(`${label} in prose hides nothing that follows it on the SAME line`, () => {
      // One line, so a mis-lex that runs "to end of line" is as fatal as one that runs to end
      // of file. Every one of these was a measured bypass through the real perimeter.
      const source = `export const T = () => <p>${trap}</p>; import fs from "node:fs"; eval("1");\n`;
      expectBunAccepts(source);
      const kinds = kindsIn(source);
      expect(kinds).toContain(SK.ImportKeyword);
      expect(toks(source).some((t) => t.value === "eval")).toBe(true);
    });

    test(`${label} in prose is not itself read as code — no false fatal on display copy`, () => {
      // The valid-input companion for the same trap: the prose alone must produce no token at
      // all inside the text run, so `import-scan.ts` cannot manufacture a violation out of it.
      const source = `export const T = () => <p>${trap} eval Function(x)</p>;\n`;
      expectBunAccepts(source);
      const ranges = readJsxTextRanges(source);
      expect(ranges.length).toBeGreaterThan(0);
      expect(
        toks(source).filter((t) => ranges.some((r) => t.pos >= r.pos && t.pos < r.end)),
      ).toEqual([]);
    });
  }

  test("an element the JSX reader cannot confirm contributes NO text range — the region stays code", () => {
    // Fail-closed direction, stated as a test: under-reporting text costs precision, never a
    // bypass. A mismatched close tag is not an element, so its "prose" is scanned as code.
    const source = `<box>eval("1")</text>\n`;
    expect(readJsxTextRanges(source)).toEqual([]);
    expect(toks(source).some((t) => t.value === "eval")).toBe(true);
  });
});

describe("mechanism 2 — `/` is re-scanned as a regular expression where one can legally start", () => {
  test("a `{` inside a character class no longer desynchronises the brace stack (KNOWN GAP 6b, closed)", () => {
    // MEASURED LIVE before this: `Bun.Transpiler` accepted this source and executed it, while
    // the whole perimeter reported nothing at all — the phantom `{` made the template's own
    // closing backtick open a fresh literal that swallowed the rest of the file.
    const source = 'const s = `${/[{]/.test("x")}`\n' + HIDDEN;
    expectBunAccepts(source);
    const kinds = kindsIn(source);
    expect(kinds).toContain(SK.ImportKeyword);
    expect(toks(source).some((t) => t.value === "eval")).toBe(true);
  });

  test("a `}` inside a character class no longer closes the interpolation early (KNOWN GAP 6, closed)", () => {
    const source = "const s = `${/[}]/ && 1}`\n" + HIDDEN;
    expectBunAccepts(source);
    expect(kindsIn(source)).toContain(SK.ImportKeyword);
  });

  test("DIVISION is still division — the re-scan does not swallow a line of arithmetic", () => {
    // The valid-input companion. `endsExpression` (shared with `./jsx`'s reader) is what keeps
    // these `/` characters operators; if it were dropped, the first one would open a bogus
    // regex literal running to end of line and the import below would vanish.
    const source = `const a = (w) / (h) / 2\nconst b = xs[0] / 2\nconst c = f() / 2\n${HIDDEN}`;
    expectBunAccepts(source);
    expect(kindsIn(source)).toContain(SK.ImportKeyword);
    expect(toks(source).filter((t) => t.kind === SK.RegularExpressionLiteral)).toEqual([]);
  });

  test("a JSX close tag's `/` is never re-scanned as a regex", () => {
    const source = `export const T = () => <p>a</p>\nexport const U = () => <b />\n${HIDDEN}`;
    expectBunAccepts(source);
    expect(kindsIn(source)).toContain(SK.ImportKeyword);
    expect(toks(source).filter((t) => t.kind === SK.RegularExpressionLiteral)).toEqual([]);
  });
});

describe("mechanism 3 — every character is accounted for, or the file fails closed", () => {
  test("an UNTERMINATED `/*` in code is refused, naming the offset — the scanner SKIPS it, so no trivia kind is ever surfaced", () => {
    // This is the shape that defeated both of round 1's formulations: `createScanner(true, …)`
    // skips comments rather than returning them, so the trivia guard never fires, and the
    // scanner reaches `EndOfFile` at `source.length`, so a positional end-of-file check does not
    // fire either. Only per-character accounting sees it.
    const source = `const a = 1\n/* never closed\n${HIDDEN}`;
    const result = tokenize(source);
    expect(result).toBeInstanceOf(SourceStreamTruncatedError);
    if (!(result instanceof Error)) throw new Error("expected a truncation");
    expect(result.message).toContain(`offset ${source.indexOf("/* never")}`);
    // …and Bun refuses it too, so failing closed AGREES with the runtime rather than over-firing.
    expectBunRejects(source);
  });

  test("TERMINATED comments, blank lines, a shebang and a byte-order mark are all accounted for", () => {
    // The valid-input companion for the accounting: if any of these read as unaccounted, the
    // guard would refuse ordinary TypeScript.
    expect(tokenize(`#!/usr/bin/env bun\n/* a */ // b\n\n${HIDDEN}`)).not.toBeInstanceOf(Error);
    expect(tokenize(`﻿/* a */\n${HIDDEN}`)).not.toBeInstanceOf(Error);
    expect(tokenize(`${HIDDEN}// a trailing comment with no newline`)).not.toBeInstanceOf(Error);
    expect(kindsIn(`#!/usr/bin/env bun\n/* a */ // b\n\n${HIDDEN}`)).toContain(SK.ImportKeyword);
  });

  test("a span the scanner DECLINES to lex is refused by kind, naming the offset", () => {
    // U+FFFD is what `TextDecoder` yields for ANY invalid UTF-8 byte, and turn staging decodes
    // every tree file through it unfiltered. At a CODE token position the scanner answers
    // `NonTextFileMarkerTrivia` — its binary-file detector — spanning to end of file.
    const source = `const x = ${FFFD}\n${HIDDEN}`;
    const result = tokenize(source);
    expect(result).toBeInstanceOf(SourceStreamTruncatedError);
    if (!(result instanceof Error)) throw new Error("expected a truncation");
    expect(result.message).toContain("NonTextFileMarkerTrivia");
    expect(result.message).toContain(`offset ${source.indexOf(FFFD)}`);
    // Bun REJECTS this source (`Unexpected ï`), so the refusal is aligned with the runtime.
    expectBunRejects(source);
  });

  test("ROUND 1'S RESIDUAL IS GONE: U+FFFD in prose, a string or a comment is SCANNED, not refused", () => {
    // A behaviour change, and it is the good direction. Round 1 refused
    // `<Text>U+FFFD</Text>` — a source Bun accepts and executes — and pinned that as an
    // accepted trade. Mechanism 1 removes the trade entirely: the character is prose, so it is
    // skipped, and the code after it is lexed. The refusal now fires only where Bun refuses too
    // (the sibling test above).
    for (const source of [
      `export const G = () => <Text>${FFFD}</Text>\n${HIDDEN}`,
      `export const G = () => <Text a="${FFFD}">z</Text>\n${HIDDEN}`,
      `const s = "${FFFD}"\n${HIDDEN}`,
      `// ${FFFD}\n${HIDDEN}`,
    ]) {
      expectBunAccepts(source);
      expect(tokenize(source)).not.toBeInstanceOf(Error);
      expect(kindsIn(source)).toContain(SK.ImportKeyword);
    }
  });

  test("the guard set is DERIVED from the SyntaxKind names, so it covers a kind outside TypeScript's own trivia range", () => {
    // `NonTextFileMarkerTrivia` is 7; `LastTriviaToken` is 6. A `First..Last` range test — the
    // obvious way to write this guard — would have missed precisely the kind that carried the
    // bypass.
    //
    // CORRECTED (task-14 review round 2, M1): round 1 asserted only that 7 > 6 and claimed "a
    // future refactor to a range test fails HERE". It did not — mutating `TRIVIA_KINDS` to
    // `{2,3,4,5,6}` left that assertion passing (three OTHER tests caught it). The set itself is
    // now exported and asserted, so a range implementation fails in this test, where the comment
    // says it does.
    const kinds = SK as unknown as Record<string, number>;
    const nonText = kinds["NonTextFileMarkerTrivia"];
    if (nonText === undefined) throw new Error("NonTextFileMarkerTrivia is gone from SyntaxKind");
    expect(nonText).toBeGreaterThan(kinds["LastTriviaToken"] ?? 0);
    expect(TRIVIA_KINDS.has(nonText)).toBe(true);
    // …and it really is derived, not a hand-written list that happens to include 7: every
    // `*Trivia` member of the enum is present.
    for (const [name, value] of Object.entries(SK)) {
      if (typeof value === "number" && name.endsWith("Trivia")) {
        expect(TRIVIA_KINDS.has(value)).toBe(true);
      }
    }
  });
});

describe("mechanism 4 — a token that swallows a whole prose run fails closed", () => {
  test("a JSX attribute string ending in a backslash is refused, naming the run it swallowed", () => {
    // JSX attribute strings do not process `\` escapes; code-mode strings do. So `a="x\"` ends
    // the attribute for the runtime while the code lexer reads on through `>hi</Text>` and
    // whatever follows. Bun ACCEPTS AND EXECUTES this source, so the gate must not pretend it
    // read it.
    const source = `export const G = () => <Text a="x\\">hi</Text>\n${HIDDEN}`;
    expectBunAccepts(source);
    const result = tokenize(source);
    expect(result).toBeInstanceOf(SourceStreamTruncatedError);
    if (!(result instanceof Error)) throw new Error("expected a truncation");
    expect(result.message).toContain("swallows the JSX text");
  });

  test("the same attribute without the trailing backslash still passes — no over-fire", () => {
    const source = `export const G = () => <Text a="x">hi</Text>\n${HIDDEN}`;
    expectBunAccepts(source);
    expect(tokenize(source)).not.toBeInstanceOf(Error);
    expect(kindsIn(source)).toContain(SK.ImportKeyword);
  });
});

describe("the zero-width stall (found in round 1 while proving C1's fix does not over-fire)", () => {
  test("a bare `#` at any position advances rather than spinning, and a LEGAL private field still lexes", () => {
    // A sweep of every code point in U+0000..U+02FF finds exactly ONE stalling character: `#`,
    // and only when it cannot begin a legal private identifier. Advancing past it hides nothing
    // — Bun rejects such a source outright — while REFUSING there was measured to reject an
    // extensionless `Dockerfile` of `#` comments, which `tree-scan.ts` classifies as code.
    expect(kindsIn(`const a = 1\n#\n${HIDDEN}`)).toContain(SK.ImportKeyword);
    const legal = toks(`class C { #x = 1 }\n${HIDDEN}`);
    expect(legal.some((t) => t.kind === SK.PrivateIdentifier)).toBe(true);
    expect(legal.some((t) => t.kind === SK.ImportKeyword)).toBe(true);
  });

  test("`#` inside a regular expression is one token now, not a stall", () => {
    // The four repository files round 1 found truncated this way (`markdown-lite.ts` and
    // friends) all carried their `#` inside a regex; mechanism 2 lexes those as one literal.
    const source = `const heading = /^#{1,6}\\s/\n${HIDDEN}`;
    expectBunAccepts(source);
    expect(toks(source).some((t) => t.kind === SK.RegularExpressionLiteral)).toBe(true);
    expect(kindsIn(source)).toContain(SK.ImportKeyword);
  });
});

describe("tokenize — the over-fire proof, re-measured on every run", () => {
  test("every one of the repository's own .ts/.tsx files tokenizes, with zero refusals", () => {
    // The corpus check the C1 ruling demanded, kept as a test rather than a one-off probe so it
    // cannot go stale: any future tightening that starts refusing ordinary TypeScript fails
    // here, naming the files.
    const root = path.resolve(import.meta.dir, "../../..");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          walk(p);
        } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) files.push(p);
      }
    };
    walk(path.join(root, "src"));

    const refused: string[] = [];
    for (const file of files) {
      const result = tokenize(fs.readFileSync(file, "utf8"));
      if (result instanceof Error) refused.push(`${path.relative(root, file)}: ${result.message}`);
    }
    expect(refused).toEqual([]);
    // The count is asserted exactly, so the doc comments citing it and this walk cannot drift
    // apart (task-14 review round 2, M4, where the doc said 886 and the walk saw 884). Task 14b
    // adds `gate/model/scanner.ts` and `gate/model/lexer.oracle.test.ts`, so it is 886 again —
    // update BOTH this number and the counts quoted in `lexer.ts` when the corpus grows.
    expect(files.length).toBe(886);
  });

  test("no token any repository file produces starts inside a JSX children-text range", () => {
    // MECHANISM 1, asserted as a property over the whole corpus rather than fixture by fixture.
    // A single violation would mean the code scanner was positioned inside prose, which is
    // exactly how an apostrophe becomes a string opener.
    const root = path.resolve(import.meta.dir, "../../..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          walk(p);
        } else if (/\.tsx$/.test(entry.name)) {
          const source = fs.readFileSync(p, "utf8");
          const result = tokenize(source);
          if (result instanceof Error) continue;
          const ranges = readJsxTextRanges(source);
          if (ranges.length === 0) continue;
          const inside = result.filter((t) => ranges.some((r) => t.pos >= r.pos && t.pos < r.end));
          if (inside.length > 0) offenders.push(`${path.relative(root, p)}: ${inside.length}`);
        }
      }
    };
    walk(path.join(root, "src"));
    expect(offenders).toEqual([]);
  });
});
