import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { SK, SourceStreamTruncatedError, TRIVIA_KINDS, type Tok, tokenize } from "./lexer";

/**
 * THE TOKEN-STREAM COMPLETENESS INVARIANT (task-14 review round 1, Critical C1).
 *
 * Every gate scan — the import allowlist, design §5.8's `eval`/`Function` ban, the page
 * contract, the determinism lints — treats `tokenize`'s output as the file. Nothing checked
 * that it was. These tests pin the check that now does, the two truncations it closed, and the
 * one behaviour change it costs.
 *
 * SCOPE, STATED HONESTLY (task-14 review round 2): this invariant closes the case where the
 * scanner SAYS it declined to lex a span. It does NOT make the Gate's parse agree with the
 * parse the runtime executes in general — an unterminated block comment opened in JSX TEXT
 * still truncates the stream with no signal at all, because `createScanner(true, …)` SKIPS
 * comments rather than returning them, so no trivia kind is ever surfaced. That is a strictly
 * larger problem needing a differential oracle rather than another guard; it is owned by a
 * separate task, and nothing here should be read as closing it.
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

describe("tokenize — the completeness invariant", () => {
  test("REPORTS (does not throw) a source the scanner declined to lex, naming the offset where coverage stopped", () => {
    // `�` is what `TextDecoder` yields for ANY invalid UTF-8 byte, and `core/kernel`'s turn
    // staging decodes every tree file through it unfiltered. At a token position the scanner
    // answers `NonTextFileMarkerTrivia` — its binary-file detector — spanning to EOF.
    const source = `export const G = () => <Text>${FFFD}</Text>\n${HIDDEN}`;
    const result = tokenize(source);
    expect(result).toBeInstanceOf(SourceStreamTruncatedError);
    if (!(result instanceof Error)) throw new Error("expected a truncation");
    // The message must say which kind stopped the scan and where, or a future reader cannot
    // tell this apart from any other lexer failure.
    expect(result.message).toContain("NonTextFileMarkerTrivia");
    expect(result.message).toContain(`offset ${source.indexOf(FFFD)}`);
  });

  test("THE RESIDUAL, PINNED: a source Bun DOES execute, carrying U+FFFD at a token position, is now REFUSED", () => {
    // A deliberate behaviour change, and the right trade for a security perimeter.
    //
    // CORRECTED (task-14 review round 2, M3): round 1 called this a "legal source" while using
    // a `.ts`-shaped fixture with JSX in it, which `Bun.Transpiler({loader:"ts"})` REJECTS
    // (`Unexpected ï`) — so the fixture did not have the executability the claim rested on.
    // Measured: the same source under the `tsx` loader transpiles fine. THAT is the form that
    // makes the refusal a real trade-off, so that is the form pinned here.
    const executableForm = `export const G = () => <Text>${FFFD}</Text>\n`;
    expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(executableForm)).not.toThrow();
    expect(tokenize(executableForm)).toBeInstanceOf(SourceStreamTruncatedError);
    // THE AUTHOR'S FIX is to remove the U+FFFD — it is either a real replacement character (the
    // file was decoded from invalid UTF-8 and is already corrupt) or a literal one that belongs
    // in an escape (`�`), where it does not sit at a token position (sibling test below).
  });

  test("…and the same character inside a string or a comment does NOT refuse — the guard is about token positions, not the character", () => {
    // The valid-input companion. If this refused too, "reject everything containing U+FFFD"
    // would satisfy the test above, and every legitimate page carrying the character in copy
    // would be rejected.
    expect(tokenize(`const s = "${FFFD}"\n${HIDDEN}`)).not.toBeInstanceOf(Error);
    expect(tokenize(`// ${FFFD}\n${HIDDEN}`)).not.toBeInstanceOf(Error);
    // …and the hidden import is genuinely still in the stream, not merely un-refused.
    expect(kindsIn(`const s = "${FFFD}"\n${HIDDEN}`)).toContain(SK.ImportKeyword);
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

describe("tokenize — the zero-width spin (found while proving C1's fix does not over-fire)", () => {
  test("a hex colour in JSX text no longer truncates the stream — the hidden import IS scanned", () => {
    // `<Text>#7ad7ff</Text>`: the `#` is not a legal private identifier, so `scan()` returned
    // `PrivateIdentifier` at ZERO WIDTH forever. The old loop's `guard <= cap` condition caught
    // the spin and silently returned the partial token list, so everything after the `#` was
    // unscanned — C1's bypass shape, through a character this project's palette is made of.
    const source = `export const G = () => <Text>#7ad7ff</Text>\n${HIDDEN}`;
    expect(tokenize(source)).not.toBeInstanceOf(Error);
    const kinds = kindsIn(source);
    expect(kinds).toContain(SK.ImportKeyword);
    expect(kinds).toContain(SK.Identifier);
  });

  test("a bare `#` at any position advances rather than spinning, and a LEGAL private field still lexes", () => {
    expect(kindsIn(`const a = 1\n#\n${HIDDEN}`)).toContain(SK.ImportKeyword);
    // The valid input the advance must not disturb: `#x` IS a legal private identifier.
    const legal = toks(`class C { #x = 1 }\n${HIDDEN}`);
    expect(legal.some((t) => t.kind === SK.PrivateIdentifier)).toBe(true);
    expect(legal.some((t) => t.kind === SK.ImportKeyword)).toBe(true);
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
    // CORRECTED (task-14 review round 2, M4): round 1 asserted only `> 800` while its comment
    // claimed the test "re-derives the file count the doc comment cites, so that number cannot
    // silently drift". It could — and had: the doc said 886, counting files outside `src/` this
    // walk never visits, while `find src -type f \( -name '*.ts' -o … \)` reports 884. The count
    // is asserted exactly now, so the doc comment and this walk cannot disagree again. Update
    // BOTH together when the corpus grows.
    expect(files.length).toBe(884);
  });
});
