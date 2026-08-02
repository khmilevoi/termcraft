import * as errore from "errore";
import { LanguageVariant, SyntaxKind, createScanner } from "typescript/unstable/ast";

import { opensJsxPunctuation, readJsxTextRanges, scanCode } from "./jsx";
import type { JsxTextRange } from "./jsx";
import { SK, lineColOf, scanCodeToken } from "./scanner";
import type { BraceContext, SyntaxKind as SyntaxKindType, Tok } from "./scanner";

export { SK, lineColOf, scanCodeToken };
export type { BraceContext, SyntaxKind, Tok };

/**
 * Tokenize a page source the way the RUNTIME reads it. Shared by every gate scan — the import
 * allowlist, design §5.8's `eval`/`Function` ban, the page contract, the determinism lints — so
 * all of them reason about one reading of the file.
 *
 * ---------------------------------------------------------------------------------------------
 * THE INVARIANT (task 14b). **The gate's view of a source must cover everything the runtime will
 * execute.** Where it cannot, this function returns a {@link SourceStreamTruncatedError} naming
 * the offset; it is never silently under-scanned.
 *
 * That is one property, enforced here rather than in any one scan, because every scan built on
 * this function treats the tokens it is given AS the file and none of them can check that claim
 * for itself. Three separate bypasses reached the shipped perimeter before it was stated this
 * way, each closed by a guard aimed at the one input a reviewer had found, and each defeated by
 * the next shape. The four mechanisms below are the ones a DIFFERENTIAL ORACLE
 * (`lexer.oracle.test.ts`) measured as necessary and sufficient over its corpus — not a fourth
 * guess:
 *
 * 1. **JSX children TEXT is skipped, not lexed** ({@link readJsxTextRanges}). This is the one
 *    that closes the differential-parse class. Bun parses a `.tsx`/`.jsx` file with a JSX
 *    parser, in which children text is TEXT: `it's` is prose, `a // b` is prose, `a /* b` is
 *    prose, `#7ad7ff` is prose, a backtick is prose. A CODE-mode lexer started inside that prose
 *    reads them as a string opener, a line comment, a block comment running to end of file, a
 *    zero-width private identifier, and a template literal — each of which then swallows the
 *    real code that follows. Measured through the real `scanTreeImports` perimeter against Bun's
 *    own parse: **94 sources that Bun accepts and whose `import`/`eval` the gate could not see**
 *    (see `lexer.oracle.test.ts` for the corpus and the counts).
 * 2. **`/` is re-scanned as a regular expression where one can legally start** (`./jsx`'s
 *    `scanCode`, the same implementation the JSX reader uses). Without it a `{` or `}` written
 *    inside a regular expression's character class desynchronised the template/brace stack and
 *    swallowed the rest of the file into one literal token — `import-scan.ts`'s KNOWN GAPS 6 and
 *    6b, of which 6b was measured live: `` const s = `${/[{]/.test('x')}` `` followed by
 *    `import "node:fs"` and `eval("1")` transpiled fine under Bun and reported NO violations.
 * 3. **Coverage is accounted for, character by character** ({@link firstUnaccountedOffset}).
 *    Every source offset must belong to an emitted token, to a skipped JSX text range, to
 *    whitespace, to a TERMINATED comment, or to a leading shebang. Anything else — an
 *    unterminated `/*` that ran to end of file, a span the scanner declined to lex, a
 *    zero-width stall — is a region of the file the stream does not account for, and it fails
 *    closed. This is what makes the invariant a property of the OUTPUT rather than a list of
 *    known-bad inputs.
 * 4. **No token may swallow a JSX text range whole.** A code-mode token that starts before a
 *    prose run and ends at or after its end has read the runtime's TEXT as CODE and kept going
 *    — the two parses have diverged, and the stream cannot be trusted. (A token that merely
 *    overlaps the START of a run is tolerated: only multi-character punctuation can do that —
 *    `>` merging with a leading `=`/`>` of the prose — and mechanism 1 then resumes at the run's
 *    end, so no identifier can be mis-read as code.)
 *
 * WHAT THIS DOES NOT CLAIM. Not that the gate's parse equals Bun's in general — this is a
 * scanner driven by a JSX reader, not Bun's parser. The claim is the narrower, measurable one
 * the oracle checks: over its corpus there is no source that **Bun accepts while the gate saw
 * less than all of it**. `import-scan.ts`'s KNOWN GAP inventory records the residual shapes,
 * each re-tested against Bun in task 14b's report with a live/unreachable verdict. What would
 * falsify the claim is a single oracle row with a non-empty `underImport`/`underEval`.
 *
 * The `source.length + 1` cap is a hard backstop against a wrong terminal-token assumption
 * spinning the loop; every iteration already advances at least one character, so it is defense
 * in depth, and it FAILS CLOSED rather than returning the partial stream it used to.
 */
export function tokenize(source: string): SourceStreamTruncatedError | Tok[] {
  const textRanges = readJsxTextRanges(source);
  const scanner = createScanner(true, LanguageVariant.Standard);
  scanner.setText(source);
  const toks: Tok[] = [];
  const braces: BraceContext[] = [];
  const cap = source.length + 1;
  let guard = 0;
  let previous: SyntaxKindType = SK.EndOfFile;
  // True while the previous token is a JSX `<` rather than a relational operator — the one
  // thing `scanCode` cannot derive, and what keeps `</box>`'s `/` a division while letting
  // `a < /[}]/.test(x)`'s be the regular expression it really is (see `opensJsxPunctuation`).
  let jsxPunctuation = false;
  let range = 0; // the first text range that may still be ahead of the scan position
  let covered = 0; // the highest offset the stream accounts for, for mechanism 3

  for (;;) {
    // MECHANISM 1 — never begin a code scan inside JSX children text. The scanner's own
    // `getTokenEnd()` IS its scan position, so this is asked before every scan, including the
    // first (position 0) and the one right after a token that reached into a text run.
    const at = scanner.getTokenEnd();
    while (range < textRanges.length && textRanges[range]!.end <= at) range += 1;
    const ahead = textRanges[range];
    if (ahead !== undefined && ahead.pos <= at && at < ahead.end) {
      covered = Math.max(covered, ahead.end);
      scanner.resetTokenState(ahead.end);
      range += 1;
      // A text run always ends at `<`, `{` or end of file (`scanJsxToken` stops at exactly
      // those), so the next code token can never be a `/` whose regex-versus-division reading
      // depends on what came before the prose.
      previous = SK.EndOfFile;
      jsxPunctuation = false;
      continue;
    }

    const kind = scanCode(scanner, braces, previous, jsxPunctuation);
    const start = scanner.getTokenStart();
    const end = scanner.getTokenEnd();

    if (kind === SK.EndOfFile) {
      const gap = firstUnaccountedOffset(source, covered, source.length);
      if (gap !== null) return unaccounted(source, gap);
      return toks;
    }
    if (TRIVIA_KINDS.has(kind)) {
      // The scanner RETURNING a trivia kind is it saying it DECLINED TO LEX that span — its
      // binary-file detector (`NonTextFileMarkerTrivia`, which any invalid UTF-8 byte decodes
      // into) is the measured case, and it spans from that offset to end of file. Reported by
      // its start offset, which is where coverage of this file actually stopped.
      return new SourceStreamTruncatedError({
        reason: `the scanner returned ${kindName(kind)} at offset ${start}, so the ${end - start} character(s) from there were never lexed`,
      });
    }
    if (end === start) {
      // A ZERO-WIDTH token that is not end-of-file: the scanner consumed nothing, so scanning
      // again from here returns the same token forever. Resume one character later instead, and
      // count that character as accounted for.
      //
      // ADVANCING, not failing closed, and the difference is measured rather than argued. A
      // sweep of every code point in U+0000..U+02FF through `createScanner(true, Standard)`
      // finds EXACTLY ONE stalling character: `#` (`scan()` answers `PrivateIdentifier` at zero
      // width forever). A `#` that IS followed by an identifier start is a legal private
      // identifier and lexes normally with a real width, so the stall only ever happens on a
      // LONE `#` — a character the runtime cannot execute either (`Bun.Transpiler` rejects it
      // outside a shebang or a private field). Skipping it therefore hides nothing: it can be
      // no import, no `eval`, no `require`, and every subsequent character is still offered to
      // the scanner, so the stream still covers the code.
      //
      // Failing closed here instead was implemented and MEASURED first: it refuses an
      // extensionless `Dockerfile` of `#` comments, which `tree-scan.ts`'s measured predicate
      // classifies as code — the "tightened guard bricks a real input" failure this branch has
      // already paid for twice. The oracle reports the same zero divergences either way, so the
      // policy that costs no false rejection is the correct one.
      covered = Math.max(covered, start + 1);
      scanner.resetTokenState(start + 1);
      jsxPunctuation = opensJsxPunctuation(kind, previous);
      previous = kind;
      continue;
    }
    if (guard > cap) {
      return new SourceStreamTruncatedError({
        reason: `the scanner produced more than ${cap} tokens for a ${source.length}-character source without reaching end-of-file`,
      });
    }
    // MECHANISM 4 — this token read a whole prose run as code and kept going, so the gate's
    // parse and the runtime's have diverged about where code even is.
    const swallowed = textRanges.find((r) => start <= r.pos && end >= r.end);
    if (swallowed !== undefined) {
      return new SourceStreamTruncatedError({
        reason: `the ${kindName(kind)} at offset ${start} swallows the JSX text the runtime reads at offsets ${swallowed.pos}..${swallowed.end}, so this stream and the runtime's parse disagree about which characters are code`,
      });
    }
    // MECHANISM 3 — everything between the last accounted-for offset and this token must be
    // whitespace, a terminated comment or a leading shebang.
    if (start > covered) {
      const gap = firstUnaccountedOffset(source, covered, start);
      if (gap !== null) return unaccounted(source, gap);
    }
    covered = Math.max(covered, end);

    guard += 1;
    const value =
      kind === SK.StringLiteral || kind === SK.NumericLiteral
        ? scanner.getTokenValue()
        : kind === SK.Identifier
          ? scanner.getTokenText()
          : "";
    toks.push({ kind, value, pos: start });
    jsxPunctuation = opensJsxPunctuation(kind, previous);
    previous = kind;
  }
}

/** The refusal mechanism 3 raises, naming the offset where the stream stops accounting for the source. */
function unaccounted(source: string, offset: number): SourceStreamTruncatedError {
  const where = lineColOf(source, offset);
  return new SourceStreamTruncatedError({
    reason: `no token accounts for the source at offset ${offset} (line ${where.line}, column ${where.column}), so the ${source.length - offset} character(s) from there may hold code this scan never saw`,
  });
}

/**
 * The first offset in `[from, to)` that the token stream does not account for, or `null` when
 * every character in the span is one the runtime does not execute either.
 *
 * WHAT COUNTS AS ACCOUNTED FOR, and why each entry is on the list rather than assumed:
 *
 * - **whitespace**, including the byte-order mark, which JavaScript's own `\s` class covers;
 * - **a terminated comment** — `/*…*` + `/`, or `//…` up to a newline or end of file. Bun strips
 *   exactly these, so a gap made of them hides nothing the runtime runs;
 * - **a `#!` shebang on the first line**, which the scanner skips and Bun accepts.
 *
 * Everything else is a region the scanner walked past without telling anyone: the measured case
 * is an UNTERMINATED `/*`, which `createScanner(true, …)` SKIPS (it does not return a comment
 * kind, so no trivia guard can see it) and runs to end of file. In JSX children that shape is
 * prose and is already skipped by `tokenize`'s mechanism 1; anywhere else the runtime refuses
 * the file outright, so failing closed here agrees with it rather than over-firing.
 */
function firstUnaccountedOffset(source: string, from: number, to: number): number | null {
  let i = from;
  while (i < to) {
    const char = source[i]!;
    if (WHITESPACE.test(char)) {
      i += 1;
      continue;
    }
    if (i === 0 && source.startsWith("#!")) {
      const eol = source.indexOf("\n", 2);
      i = eol === -1 ? to : eol + 1;
      continue;
    }
    if (source.startsWith("//", i)) {
      const eol = source.indexOf("\n", i + 2);
      i = eol === -1 ? to : eol + 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const close = source.indexOf("*/", i + 2);
      if (close === -1) return i; // unterminated — everything from here on was never lexed
      i = close + 2;
      continue;
    }
    return i;
  }
  return null;
}

/** One character of JavaScript whitespace, byte-order mark included (`\s` covers `﻿`). */
const WHITESPACE = /\s/u;

/**
 * {@link tokenize} could not produce a token stream covering the whole source, so nothing
 * downstream may treat the tokens it saw as that file's complete content.
 *
 * RETURNED AS A VALUE, NOT THROWN (task-14 review round 2, M6). Round 1 threw it and caught it
 * with `errore.try` in `gate.ts` — but `tokenize` is this module's OWN code, and the project
 * constraint permits `errore.try` only at UNCONTROLLED boundaries (a third-party library, the
 * engine). The union is both errore-correct and materially safer here: it makes `tsc` enumerate
 * every consumer of `tokenize` rather than leaving "is a truncated stream getting through
 * somewhere else?" to reasoning — which matters, because this defect has now reopened twice.
 * The genuine uncontrolled boundary that remains is `./jsx`'s recursive-descent reader, which
 * the ENGINE can overflow; that one is still an `errore.try`, in `tree-scan.ts` and `gate.ts`.
 */
export class SourceStreamTruncatedError extends errore.createTaggedError({
  name: "SourceStreamTruncatedError",
  message: "the lexer could not produce a complete token stream: $reason",
}) {}

/**
 * Every `SyntaxKind` whose NAME ends in `Trivia`, derived from the enum at load time.
 *
 * DERIVED, NOT ENUMERATED, and deliberately NOT `FirstTriviaToken..LastTriviaToken`. Measured
 * against the pinned TypeScript: `FirstTriviaToken = 2`, `LastTriviaToken = 6`
 * (`ConflictMarkerTrivia`) — but `NonTextFileMarkerTrivia = 7`, OUTSIDE that range, because it
 * was added after the range markers were fixed. A range test would therefore have missed
 * exactly the kind {@link tokenize}'s guard exists to catch, and a hand-written list would go
 * stale the same way the next time a trivia kind is added. Reading the names keeps the guard
 * correct across a TypeScript upgrade without anyone remembering to update it.
 */
export const TRIVIA_KINDS: ReadonlySet<number> = new Set(
  Object.entries(SyntaxKind)
    .filter(([name, value]) => typeof value === "number" && name.endsWith("Trivia"))
    .map(([, value]) => value as number),
);

/** The enum member name for a kind, for diagnostics — `String(kind)` when the reverse mapping has none. */
function kindName(kind: SyntaxKindType): string {
  const name = (SyntaxKind as unknown as Record<number, string | undefined>)[kind];
  return name ?? String(kind);
}

export type { JsxTextRange };
