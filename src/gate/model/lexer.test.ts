import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { readJsxTextRanges } from "./jsx";
import { SK, type SourceSyntax, TRIVIA_KINDS, type Tok, tokenize } from "./lexer";
import { parsesJsx } from "./tree-scan";

/**
 * THE TOKEN-STREAM INVARIANT (task 14b, restated in fix round 1): **no classification
 * uncertainty may make executable code invisible to the scan.** A span `tokenize` cannot
 * confidently classify is scanned as CODE — it is never silently skipped, and it is never
 * consumed by a token that runs past it.
 *
 * Every gate scan — the import allowlist, design §5.8's `eval`/`Function` ban, the page
 * contract, the determinism lints — treats `tokenize`'s output as the file, and none of them can
 * check that claim for itself. These tests pin the mechanisms that make it true, the shapes each
 * one closed, and the valid inputs each one must NOT reject.
 *
 * WHY THE INVARIANT IS STATED THAT WAY. Both halves of the earlier formulation shipped and both
 * were broken, one on each horn: lexing JSX children text as CODE let an apostrophe and an
 * unterminated `/*` swallow the rest of the file (94 measured divergences), and then SKIPPING
 * what the JSX reader called text made real code vanish wherever that reader confirmed an
 * element Bun does not see (28 of a 150-row grid, and a regression). Classification is therefore
 * demoted: it decides where token BOUNDARIES are forced, never whether a span is scanned.
 *
 * MEASURED, NOT ARGUED. The mechanisms were chosen by running a DIFFERENTIAL ORACLE —
 * `lexer.oracle.test.ts` — that compares Bun's own parse of a source against what this function
 * saw, over the repository's own files, a systematic grid of JSX/TS lexing traps in BOTH loaders,
 * every code point in U+0000..U+02FF, and seeded fuzz.
 */

const FFFD = "�";

/** Everything an attacker wants hidden, after the truncation point. */
const HIDDEN = `import fs from "node:fs"
export const e = eval("1")
export const r = require("child_process")
export const f = new Function("return 1")
`;

/** Unwraps the union — a fixture that truncates where the test does not expect it must say so. */
function toks(source: string, syntax: SourceSyntax = "jsx"): Tok[] {
  const result = tokenize(source, syntax);
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

    test(`${label} in prose is LEXED, and no token it produces reaches past the run`, () => {
      // The boundary half of the invariant, for the same trap. The prose IS lexed — a span
      // nobody looks at is how real code went invisible in an earlier round — and the WINDOW is
      // what stops a token started inside it from reaching the code after `</p>`.
      //
      // There is no mark and no prose filter any more (fix round 2, Critical 1): every
      // suppression rule tried here produced a false negative the moment the JSX reader's
      // classification was wrong, so §5.8 over-approximates uniformly instead.
      const source = `export const T = () => <p>${trap} words</p>;
import fs from "node:fs"
`;
      expectBunAccepts(source);
      const ranges = readJsxTextRanges(source);
      expect(ranges.length).toBeGreaterThan(0);
      const lastRange = ranges[ranges.length - 1]!;
      // A token exists past the run's end — if one had swallowed the boundary there would be
      // none, which is exactly the 94-divergence class.
      expect(toks(source).some((t) => t.pos >= lastRange.end)).toBe(true);
      expect(kindsIn(source)).toContain(SK.ImportKeyword);
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

describe("mechanism 3 — every character is accounted for, and what cannot be is RE-LEXED", () => {
  test("an UNTERMINATED `/*` in code hides nothing — the span it swallowed is re-lexed", () => {
    // This is the shape that defeated both of round 1's formulations: `createScanner(true, …)`
    // skips comments rather than returning them, so the trivia guard never fires, and the
    // scanner reaches `EndOfFile` at `source.length`, so a positional end-of-file check does not
    // fire either. Only per-character accounting sees it at all.
    //
    // ANSWERED BY RE-LEXING, not by refusing (fix round 1). The invariant offers two arms and
    // this takes the first, because refusing was MEASURED to reject sources Bun ACCEPTS: a `/*`
    // sitting inside what Bun reads as a `//` line comment becomes live to this scanner whenever
    // a regular expression upstream was mis-lexed, and the page was then rejected over a comment.
    const source = `const a = 1\n/* never closed\n${HIDDEN}`;
    expectBunRejects(source);
    const kinds = kindsIn(source);
    expect(kinds).toContain(SK.ImportKeyword);
    expect(toks(source).some((t) => t.value === "eval")).toBe(true);
    expect(kinds).toContain(SK.RequireKeyword);
  });

  test("…and a TERMINATED comment is still just a comment — no findings invented from prose", () => {
    // The valid-input companion. If the re-lex fired on terminated comments too, every page
    // whose comments mention `eval` would be fatally rejected.
    const source = `const a = 1\n/* mentions eval and require here */\nexport const b = a\n`;
    expectBunAccepts(source);
    expect(toks(source).some((t) => t.value === "eval")).toBe(false);
    expect(toks(source).some((t) => t.value === "require")).toBe(false);
  });

  test("TERMINATED comments, blank lines, a shebang and a byte-order mark are all accounted for", () => {
    // The valid-input companion for the accounting: if any of these read as unaccounted, the
    // guard would refuse ordinary TypeScript.
    expect(tokenize(`#!/usr/bin/env bun\n/* a */ // b\n\n${HIDDEN}`, "jsx")).not.toBeInstanceOf(
      Error,
    );
    expect(tokenize(`﻿/* a */\n${HIDDEN}`, "jsx")).not.toBeInstanceOf(Error);
    expect(tokenize(`${HIDDEN}// a trailing comment with no newline`, "jsx")).not.toBeInstanceOf(
      Error,
    );
    expect(kindsIn(`#!/usr/bin/env bun\n/* a */ // b\n\n${HIDDEN}`)).toContain(SK.ImportKeyword);
  });

  test("a span the scanner DECLINES to lex hides nothing — it is re-lexed one character on", () => {
    // U+FFFD is what `TextDecoder` yields for ANY invalid UTF-8 byte, and turn staging decodes
    // every tree file through it unfiltered. At a CODE token position the scanner answers
    // `NonTextFileMarkerTrivia` — its binary-file detector — spanning to end of file, which is
    // how task-14 round 1's Critical hid an import, an `eval`, a `require` and a `new Function`
    // at once.
    //
    // ROUND 1 ANSWERED THIS WITH A REFUSAL; task 14b fix round 1 answers it by re-lexing, which
    // does the same job strictly better. The bypass was "everything after the marker left the
    // stream" — rewinding one character past it puts every one of those characters back, so all
    // four violations are REPORTED where a refusal only ever said "I could not read this file".
    // It also removed the last measured over-fire, where the marker sat inside what Bun reads as
    // a comment and a legal page was rejected for it.
    const source = `const x = ${FFFD}\n${HIDDEN}`;
    expectBunRejects(source);
    const kinds = kindsIn(source);
    expect(kinds).toContain(SK.ImportKeyword);
    expect(toks(source).some((t) => t.value === "eval")).toBe(true);
    expect(kinds).toContain(SK.RequireKeyword);
    expect(toks(source).some((t) => t.value === "Function")).toBe(true);
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
      expect(tokenize(source, "jsx")).not.toBeInstanceOf(Error);
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

describe("windowed lexing — no token crosses a prose boundary in EITHER direction", () => {
  test("a JSX attribute string ending in a backslash no longer refuses the page (round-1 over-fire, fixed)", () => {
    // JSX attribute strings do not process `\` escapes; code-mode strings do. So `a="C:\Users\"`
    // ends the attribute for the runtime while the code lexer reads on through `>home</p>`.
    // The previous commit answered that with a fail-closed refusal, which rejected a legal
    // Bun-accepted page over a plausible Windows path in a prop. Windowing answers it instead:
    // the attribute string simply STOPS at the prose boundary, so nothing is swallowed and
    // nothing is refused.
    const source = `export const T = () => <p title="C:\\Users\\">home</p>;\n${HIDDEN}`;
    expectBunAccepts(source);
    expect(tokenize(source, "jsx")).not.toBeInstanceOf(Error);
    // …and the code AFTER the element is still lexed, which is what the swallow guard was for.
    expect(kindsIn(source)).toContain(SK.ImportKeyword);
    expect(toks(source).some((t) => t.value === "eval")).toBe(true);
  });

  test("an ordinary attribute is unaffected — the valid-input companion", () => {
    const source = `export const G = () => <Text a="x">hi</Text>\n${HIDDEN}`;
    expectBunAccepts(source);
    expect(tokenize(source, "jsx")).not.toBeInstanceOf(Error);
    expect(kindsIn(source)).toContain(SK.ImportKeyword);
  });

  test("a NON-JSX source gets no prose boundaries at all — a `.ts` file has no JSX to find", () => {
    // CRITICAL 1 of fix round 1. Bun parses no JSX in `.ts`/`.mts`/`.cts`, so every children-text
    // range a JSX reader would report there is invented — and the previous commit SKIPPED those
    // spans, so the code inside them vanished. Measured: this source transpiles, `await import()`
    // executes it, and the whole perimeter reported nothing.
    const source = `let a: <T>(x: T) => T;\n${HIDDEN}// </T>\n`;
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(source)).not.toThrow();
    const lexed = toks(source, "no-jsx");
    expect(new Set(lexed.map((t) => t.kind))).toContain(SK.ImportKeyword);
    expect(lexed.some((t) => t.value === "eval")).toBe(true);
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
      // The syntax comes from the SAME measured predicate production uses, so this walk covers
      // both arms: `.ts`/`.mts`/`.cts` are lexed with no JSX at all, `.tsx` with it.
      const result = tokenize(fs.readFileSync(file, "utf8"), parsesJsx(file.replaceAll("\\", "/")));
      if (result instanceof Error) refused.push(`${path.relative(root, file)}: ${result.message}`);
    }
    expect(refused).toEqual([]);
    // The count is asserted exactly, so the doc comments citing it and this walk cannot drift
    // apart (task-14 review round 2, M4, where the doc said 886 and the walk saw 884). Task 14b
    // adds `gate/model/scanner.ts` and `gate/model/lexer.oracle.test.ts`, taking it to 886;
    // task 15 adds `entities/design-tree/model/code-file.ts` and
    // `host/supervisor/model/mount-request.ts`, taking it to 888; design-tree-phase-1-closeout
    // task 7 adds `entities/design-tree/model/hashing.ts` and its own `hashing.test.ts`, taking
    // it to 890; task 9 splits `store/model/design-tree-store.ts` out of
    // `store/model/factory.ts`, taking it to 891 — update BOTH this number and the counts
    // quoted in `lexer.ts` and `lexer.oracle.test.ts` when the corpus grows.
    expect(files.length).toBe(891);
  });

  test("across the corpus, every prose run is LEXED and none of them swallows what follows", () => {
    // THE WINDOW GUARANTEE, as a property over the whole corpus rather than fixture by fixture,
    // and stated in the two observable halves a token's `pos` alone can settle:
    //
    //  - a run with real content produces at least one token INSIDE it — so prose is lexed, not
    //    skipped, which is how real code went invisible in fix round 0;
    //  - and there is a token at or after every run's end, whenever the file continues past it
    //    — so nothing started inside a run reached the code after `</p>`, which is the
    //    94-divergence class.
    //
    // Both directions have been shipped broken once on this branch, which is why both are here.
    const root = path.resolve(import.meta.dir, "../../..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          walk(p);
          continue;
        }
        if (!/\.tsx$/.test(entry.name)) continue;
        const source = fs.readFileSync(p, "utf8");
        const result = tokenize(source, "jsx");
        if (result instanceof Error) continue;
        const where = path.relative(root, p);
        for (const range of readJsxTextRanges(source)) {
          const content = source.slice(range.pos, range.end);
          if (/\S/.test(content) && !result.some((t) => t.pos >= range.pos && t.pos < range.end)) {
            offenders.push(`${where}: run ${range.pos}..${range.end} produced no token`);
          }
          if (/\S/.test(source.slice(range.end)) && !result.some((t) => t.pos >= range.end)) {
            offenders.push(`${where}: run ${range.pos}..${range.end} swallowed the rest`);
          }
        }
      }
    };
    walk(path.join(root, "src"));
    expect(offenders).toEqual([]);
  });
});

describe("the loader distinction — a non-JSX source has no prose at all", () => {
  test("`parsesJsx` maps every extension the way Bun's own parser does", () => {
    // `parsesJsx` is what keeps `tokenize` from inventing children-text boundaries in a file Bun
    // parses with no JSX — and an invented boundary is not cosmetic: it changes the EDGE LIST
    // (see the closure-agreement test below), so the flat scan and the closure walk must derive
    // it from this one predicate or they build different closures.
    const source = `let a: <T>(x: T) => T;\nexport const r = 1;\n// </T>\n`;
    expect(parsesJsx("lib/m.ts")).toBe("no-jsx");
    expect(parsesJsx("lib/m.mts")).toBe("no-jsx");
    expect(parsesJsx("lib/m.cts")).toBe("no-jsx");
    expect(parsesJsx("lib/m.tsx")).toBe("jsx");
    expect(parsesJsx("lib/m.jsx")).toBe("jsx");
    expect(parsesJsx("lib/m.js")).toBe("jsx");
    expect(parsesJsx("Dockerfile")).toBe("jsx");
    // …and asked as JSX, the same source DOES get a (fictional) children-text run — which is
    // exactly why the loader has to be told, not guessed.
    expect(readJsxTextRanges(source).length).toBeGreaterThan(0);
  });

  test("the measurement behind `parsesJsx`, re-run: Bun agrees about every extension", () => {
    // One source valid ONLY as JSX, one valid ONLY as non-JSX. If a Bun upgrade moves an
    // extension between the two lists, this fails here rather than silently in the perimeter.
    const jsxOnly = `export const a = <p>hi</p>;\n`;
    const typeAssertionOnly = `const v: unknown = 1;\nexport const a = <string>v;\n`;
    const accepts = (loader: "tsx" | "ts", src: string) => {
      try {
        new Bun.Transpiler({ loader }).transformSync(src);
        return true;
      } catch {
        return false;
      }
    };
    expect(accepts("tsx", jsxOnly)).toBe(true);
    expect(accepts("tsx", typeAssertionOnly)).toBe(false);
    expect(accepts("ts", jsxOnly)).toBe(false);
    expect(accepts("ts", typeAssertionOnly)).toBe(true);
  });
});

describe("windows are what stop a TERMINATED literal from spanning a prose boundary", () => {
  // The unterminated case is handled by the `isUnterminated` rewind, so it does not exercise
  // windows at all — measured, and the reason the window mutation killed nothing until this row
  // existed. A quote PAIR that brackets the code is the shape only the boundary catches: the
  // apostrophe in `don't` opens a string that the apostrophe in `won't` closes, swallowing
  // `</p>` and the import between them.
  const BRACKETED: readonly (readonly [string, string])[] = [
    [
      "apostrophes",
      `export const T = () => <p>don't</p>; import fs from "node:fs"; // won't
`,
    ],
    [
      "double quotes",
      `export const T = () => <p>say "hi</p>; import fs from "node:fs"; // "bye
`,
    ],
    [
      "backticks",
      `export const T = () => <p>\`a</p>; import fs from "node:fs"; // \`b
`,
    ],
  ];

  for (const [label, source] of BRACKETED) {
    test(`a ${label} PAIR bracketing the code does not hide the import`, () => {
      expectBunAccepts(source);
      expect(kindsIn(source)).toContain(SK.ImportKeyword);
    });
  }
});
