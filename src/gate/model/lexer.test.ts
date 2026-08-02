import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { SK, SourceStreamTruncatedError, tokenize } from "./lexer";

/**
 * THE TOKEN-STREAM COMPLETENESS INVARIANT (task-14 review round 1, Critical C1).
 *
 * Every gate scan — the import allowlist, design §5.8's `eval`/`Function` ban, the page
 * contract, the determinism lints — treats `tokenize`'s output as the file. Nothing checked
 * that it was. These tests pin the check that now does, the two truncations it closed, and the
 * one behaviour change it costs.
 */

const FFFD = "�";

/** Everything an attacker wants hidden, after the truncation point. */
const HIDDEN = `import fs from "node:fs"
export const e = eval("1")
export const r = require("child_process")
export const f = new Function("return 1")
`;

function kindsIn(source: string): Set<number> {
  return new Set(tokenize(source).map((t) => t.kind));
}

describe("tokenize — the completeness invariant", () => {
  test("refuses a source the scanner declined to lex, naming the offset where coverage stopped", () => {
    // `�` is what `TextDecoder` yields for ANY invalid UTF-8 byte, and `core/kernel`'s turn
    // staging decodes every tree file through it unfiltered. At a token position the scanner
    // answers `NonTextFileMarkerTrivia` — its binary-file detector — spanning to EOF.
    const source = `export const G = () => <Text>${FFFD}</Text>\n${HIDDEN}`;
    let thrown: unknown = null;
    try {
      tokenize(source);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SourceStreamTruncatedError);
    // The CODE, not merely "an error": the message must say which kind stopped the scan and
    // where, or a future reader cannot tell this apart from any other lexer failure.
    expect((thrown as Error).message).toContain("NonTextFileMarkerTrivia");
    expect((thrown as Error).message).toContain(`offset ${source.indexOf(FFFD)}`);
  });

  test("THE RESIDUAL, PINNED: a legal source with U+FFFD at a token position is now REFUSED", () => {
    // A deliberate behaviour change, and the right trade for a security perimeter: this file
    // is legal TypeScript and Bun executes it, but the scanner will not lex past the marker, so
    // the Gate cannot vouch for it. THE AUTHOR'S FIX is to remove the U+FFFD — which is either
    // a real replacement character (the file was decoded from invalid UTF-8 and is already
    // corrupt) or a literal one that belongs in an escape (`�`), where it does not sit at
    // a token position and does not truncate (see the sibling test below).
    expect(() => tokenize(`export const G = () => <Text>${FFFD}</Text>\n`)).toThrow(
      SourceStreamTruncatedError,
    );
  });

  test("…and the same character inside a string or a comment does NOT refuse — the guard is about token positions, not the character", () => {
    // The valid-input companion. If this refused too, "reject everything containing U+FFFD"
    // would satisfy the test above, and every legitimate page carrying the character in copy
    // would be rejected.
    expect(() => tokenize(`const s = "${FFFD}"\n${HIDDEN}`)).not.toThrow();
    expect(() => tokenize(`// ${FFFD}\n${HIDDEN}`)).not.toThrow();
    // …and the hidden import is genuinely still in the stream, not merely un-refused.
    expect(kindsIn(`const s = "${FFFD}"\n${HIDDEN}`)).toContain(SK.ImportKeyword);
  });

  test("the guard is derived from the SyntaxKind names, so it covers a kind outside TypeScript's own trivia range", () => {
    // `NonTextFileMarkerTrivia` is 7; `LastTriviaToken` is 6. A `First..Last` range test — the
    // obvious way to write this guard — would have missed precisely the kind that carried the
    // bypass. This asserts the property that makes the derivation necessary, so a future
    // refactor to a range test fails here rather than silently reopening C1.
    const kinds = SK as unknown as Record<string, number>;
    expect(kinds["NonTextFileMarkerTrivia"]).toBeGreaterThan(kinds["LastTriviaToken"] ?? 0);
  });
});

describe("tokenize — the zero-width spin (found while proving C1's fix does not over-fire)", () => {
  test("a hex colour in JSX text no longer truncates the stream — the hidden import IS scanned", () => {
    // `<Text>#7ad7ff</Text>`: the `#` is not a legal private identifier, so `scan()` returned
    // `PrivateIdentifier` at ZERO WIDTH forever. The old loop's `guard <= cap` condition caught
    // the spin and silently returned the partial token list, so everything after the `#` was
    // unscanned — C1's bypass shape, through a character this project's palette is made of.
    const source = `export const G = () => <Text>#7ad7ff</Text>\n${HIDDEN}`;
    expect(() => tokenize(source)).not.toThrow();
    const kinds = kindsIn(source);
    expect(kinds).toContain(SK.ImportKeyword);
    expect(kinds).toContain(SK.Identifier);
  });

  test("a bare `#` at any position advances rather than spinning, and a LEGAL private field still lexes", () => {
    expect(kindsIn(`const a = 1\n#\n${HIDDEN}`)).toContain(SK.ImportKeyword);
    // The valid input the advance must not disturb: `#x` IS a legal private identifier.
    const legal = tokenize(`class C { #x = 1 }\n${HIDDEN}`);
    expect(legal.some((t) => t.kind === SK.PrivateIdentifier)).toBe(true);
    expect(legal.some((t) => t.kind === SK.ImportKeyword)).toBe(true);
  });
});

describe("tokenize — the over-fire proof, re-measured on every run", () => {
  test("every one of the repository's own .ts/.tsx files tokenizes, with zero refusals", () => {
    // The corpus check the C1 ruling demanded, kept as a test rather than as a one-off probe so
    // it cannot go stale: any future tightening of this guard that starts refusing ordinary
    // TypeScript fails here, naming the files. It also re-derives the file count the
    // `tokenize` doc comment cites, so that number cannot silently drift either.
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
      try {
        tokenize(fs.readFileSync(file, "utf8"));
      } catch (e) {
        refused.push(`${path.relative(root, file)}: ${(e as Error).message}`);
      }
    }
    expect(refused).toEqual([]);
    // A floor, not an equality: the corpus grows. This only guards against the walk silently
    // finding nothing and the assertion above passing vacuously.
    expect(files.length).toBeGreaterThan(800);
  });
});
