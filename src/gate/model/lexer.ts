import * as errore from "errore";
import { LanguageVariant, SyntaxKind, createScanner } from "typescript/unstable/ast";
import type { Scanner } from "typescript/unstable/ast";

import { opensJsxPunctuation, readJsxTextRanges, scanCode } from "./jsx";
import type { JsxTextRange } from "./jsx";
import { SK, lineColOf, scanCodeToken } from "./scanner";
import type { BraceContext, SyntaxKind as SyntaxKindType, Tok } from "./scanner";

export { SK, lineColOf, scanCodeToken };
export type { BraceContext, SyntaxKind, Tok };

/**
 * Whether the runtime parses this source as JSX. Passed EXPLICITLY at every call site rather
 * than defaulted, because both possible defaults are wrong in a way that costs the perimeter:
 * assuming JSX in a `.ts` file invents element boundaries Bun never draws, and assuming no JSX
 * in a `.tsx` file lexes a page's own prose as code.
 *
 * MEASURED on the real import path (`await import(<absolute path>)` from one directory per
 * fixture, as `host/session/model/source-mount.ts:137` does), Bun 1.3.14, with two sources —
 * one valid ONLY as JSX (`export const a = <p>hi</p>`) and one valid ONLY as non-JSX (the
 * `<string>v` type assertion, which a JSX parser reads as an unclosed element):
 *
 * ```
 * .tsx  .jsx  .js  <extensionless>   ->  JSX parsed   (the type assertion is a Syntax Error)
 * .ts   .mts  .cts                   ->  no JSX       (the element is a Syntax Error)
 * .mjs  .cjs                         ->  neither form runs; plain JS, so no JSX
 * ```
 *
 * `tree-scan.ts`'s `parsesJsx` is the one predicate that maps a tree-relative path onto this,
 * so the whole-tree scan and the closure walk can never disagree about it.
 */
export type SourceSyntax = "jsx" | "no-jsx";

/**
 * Tokenize a page source the way the RUNTIME reads it. Shared by every gate scan — the import
 * allowlist, design §5.8's `eval`/`Function` ban, the page contract, the determinism lints — so
 * all of them reason about one reading of the file.
 *
 * ---------------------------------------------------------------------------------------------
 * THE INVARIANT (task 14b, restated in fix round 1). **No classification uncertainty may make
 * executable code invisible to the scan.** A span this function cannot confidently classify is
 * scanned as CODE or makes the file fail closed — it is never silently skipped, and it is never
 * consumed by a token that runs past it.
 *
 * WHY IT IS STATED THAT WAY, and not as "the gate's view must cover what the runtime executes".
 * Both formulations of THAT invariant have now been caught, one on each horn, and each time by
 * picking a winner between two classifications:
 *
 * - lexing JSX children text as CODE let an apostrophe open a string and an unterminated `/*`
 *   open a comment that swallowed the rest of the file (94 measured divergences);
 * - skipping what `scanJsx` called JSX TEXT made real code vanish outright wherever `scanJsx`
 *   confirmed an element Bun does not see — 28 of a 150-row grid, and a REGRESSION against the
 *   previous commit, which still reported the `import` in those files.
 *
 * A third guess between the two classifications would lose the same way. So classification is
 * demoted: it no longer decides WHETHER a span is scanned, only where token BOUNDARIES are
 * forced. The stream is lexed in WINDOWS delimited by the JSX reader's text-range boundaries,
 * and **no token may cross a boundary in either direction**:
 *
 * - a code-mode token started before a prose run stops at the run's start, so
 *   `<p title="C:\Users\">home</p>` no longer has its attribute string swallow the children —
 *   and no longer needs the fail-closed refusal that cost a legal Windows path a whole page;
 * - a token started inside a prose run stops at the run's end, so an apostrophe, a `//`, a `/*`
 *   or a backtick in a page's copy cannot reach the code after `</p>`;
 * - **every character is still lexed either way.** Where the classification is wrong, the worst
 *   outcome is a token boundary in an odd place, never a span nobody looked at.
 *
 * The remaining mechanisms:
 *
 * 1. **`syntax` decides whether there are text ranges at all.** In a `.ts`/`.mts`/`.cts` source
 *    Bun parses no JSX whatsoever, so every range `scanJsx` would produce there is fiction; the
 *    caller says which it is and this function asks the reader nothing for a non-JSX source.
 * 2. **`/` is re-scanned as a regular expression where one can legally start** (`./jsx`'s
 *    `scanCode`, the same implementation the JSX reader uses, so the two can never disagree
 *    about where one is). Closes `import-scan.ts`'s KNOWN GAPS 6 and 6b, of which 6b was
 *    measured live: `` const s = `${/[{]/.test('x')}` `` followed by `import "node:fs"` and
 *    `eval("1")` transpiled under Bun and reported NO violations.
 * 3. **Coverage is accounted for, character by character** ({@link firstUnaccountedOffset}).
 *    Every source offset must belong to an emitted token, to whitespace, to a TERMINATED
 *    comment, or to a leading shebang. An unterminated `/*` is SKIPPED by
 *    `createScanner(true, …)` — it returns no comment kind, and end-of-file still reports
 *    `source.length` — so neither a trivia-kind guard nor a positional end check can see it.
 *
 * TOKENS INSIDE A PROSE RUN ARE MARKED, NOT DROPPED ({@link Tok.jsxText}). `import-scan.ts`'s
 * three dynamic-code checks skip a marked token, because a page's own display copy —
 * `<Text>Never use eval here</Text>` — must not trip a FATAL. That filter suppresses a FINDING;
 * it does not remove the span from the stream, so the import/require/re-export checks, the page
 * contract and every lint still see it. That distinction is the whole difference between this
 * round and the last one.
 *
 * WHAT THIS DOES NOT CLAIM. Not that the gate's parse equals Bun's — this is a scanner driven by
 * a JSX reader, not Bun's parser. The claim is the one the oracle checks
 * (`lexer.oracle.test.ts`): over its corpus there is no source that Bun accepts and executes
 * whose `import`, `require`, `eval` or `Function` this perimeter cannot see, and no legal source
 * it refuses. What would falsify it is one oracle row with a non-empty `underImport` /
 * `underEval` / `overFatal`.
 */
export function tokenize(source: string, syntax: SourceSyntax): SourceStreamTruncatedError | Tok[] {
  // MECHANISM 1. A non-JSX source has no JSX children text, so it gets no boundaries at all —
  // asking the reader would invent them, which is precisely what made real code invisible.
  const textRanges = syntax === "jsx" ? readJsxTextRanges(source) : [];
  const scanner = createScanner(true, LanguageVariant.Standard);
  const toks: Tok[] = [];
  const braces: BraceContext[] = [];
  const cap = source.length + 1;
  let guard = 0;
  let covered = 0;

  for (const window of windowsOf(source, textRanges)) {
    // A PROSE window gets its own throwaway brace stack: `scanJsxToken` stops children text at
    // `{`, so a run can hold an unmatched `}` (measured: Bun accepts `<p>}</p>`), and letting
    // that pop the real stack would desynchronise every template literal after it.
    const stack = window.jsxText ? [] : braces;
    // A PROSE window is accounted for in full, by construction: the runtime executes none of it,
    // so `//` and an unterminated `/*` in a page's own copy are ordinary text rather than spans
    // the scan lost. Running mechanism 3 inside one would refuse `<p>a /* b</p>` — legal,
    // Bun-accepted source — which is the over-fire this branch has already paid for twice. The
    // window is BOUNDED, so this can never reach a character outside the run.
    if (window.jsxText) covered = Math.max(covered, window.end);
    const lexed = lexWindow({ scanner, source, window, stack, toks, covered, guard, cap });
    if (lexed instanceof Error) return lexed;
    covered = lexed.covered;
    guard = lexed.guard;
  }

  const gap = firstUnaccountedOffset(source, covered, source.length);
  if (gap !== null) {
    // The only span that can still reach here is a trailing unterminated `/*` with no token
    // after it to trigger the re-lex above. Nothing follows it, so there is nothing it can be
    // hiding — but say so rather than silently accepting, because "nothing follows" is a claim
    // about THIS source and the next reader deserves to see it checked.
    const rest = firstUnaccountedOffset(source, gap + 1, source.length);
    if (rest !== null && rest !== gap + 1) return unaccounted(source, gap);
  }
  return toks;
}

/** One half-open span of the source, and whether the runtime reads it as JSX children text. */
interface LexWindow {
  readonly pos: number;
  readonly end: number;
  readonly jsxText: boolean;
}

/**
 * The source split at every JSX text-range boundary, in order and covering it exactly once.
 * Ranges arrive sorted and disjoint (`readJsxTextRanges` normalizes them), so this is one walk.
 */
function windowsOf(source: string, ranges: readonly JsxTextRange[]): LexWindow[] {
  const windows: LexWindow[] = [];
  let at = 0;
  for (const range of ranges) {
    if (range.pos > at) windows.push({ pos: at, end: range.pos, jsxText: false });
    windows.push({ pos: range.pos, end: range.end, jsxText: true });
    at = range.end;
  }
  if (at < source.length) windows.push({ pos: at, end: source.length, jsxText: false });
  return windows;
}

/**
 * Lex one window to its end, appending to `toks`. The scanner is re-pointed at exactly this
 * span (`setText(source, pos, length)`), which is what makes "no token crosses a boundary" a
 * property of the scanner rather than a check applied afterwards: a literal the window cannot
 * terminate simply ends at the window's end.
 */
function lexWindow(input: {
  readonly scanner: Scanner;
  readonly source: string;
  readonly window: LexWindow;
  readonly stack: BraceContext[];
  readonly toks: Tok[];
  readonly covered: number;
  readonly guard: number;
  readonly cap: number;
}): SourceStreamTruncatedError | { covered: number; guard: number } {
  const { scanner, source, window, stack, toks, cap } = input;
  let covered = input.covered;
  let guard = input.guard;
  scanner.setText(source, window.pos, window.end - window.pos);
  let previous: SyntaxKindType = SK.EndOfFile;
  let jsxPunctuation = false;
  // The highest offset this window has consumed, so a span the scanner walked PAST — a comment
  // it skipped — is visible to the prose rule below rather than only to mechanism 3.
  let reached = window.pos;

  for (;;) {
    // Inside a PROSE window a `/` is never a regular expression: a run of children text is not
    // an expression context, and re-scanning there would let `/…/` swallow prose the same way a
    // quote would.
    const kind = scanCode(scanner, stack, previous, jsxPunctuation || window.jsxText);
    const start = scanner.getTokenStart();
    const end = scanner.getTokenEnd();

    // NOTHING MAY BE CONSUMED BY A TOKEN THAT RUNS PAST IT (task 14b fix round 1). Bounding a
    // window stops a quote in a page's prose from reaching the code after `</p>`, but on its own
    // it stops neither of the two ways a span still disappears INSIDE a window:
    //
    //  - an UNTERMINATED literal — a string, template or regular expression with no closing
    //    delimiter — consumes everything from its opener to the end of the window. Measured
    //    live: `/<b>/.test(s); } // \`tick` mis-lexes the `//` into a regular expression, which
    //    leaves the backtick as live code, and the template it opens swallows the `import` and
    //    `eval` that follow while Bun (for which the backtick is inside a comment) accepts and
    //    executes the file;
    //  - a SKIPPED COMMENT inside a JSX prose run, where `/*` is text to the runtime but trivia
    //    to this scanner, so the run's tail vanishes.
    //
    // Both are answered the same way: the scanner is rewound to ONE CHARACTER past where the
    // offender began, and the characters it wanted to swallow are re-offered as ordinary tokens.
    // Nothing is refused and nothing is skipped — the span simply gets a different, uglier token
    // shape, which no scan built on this stream depends on.
    //
    // A TERMINATED literal is kept as one token, because its VALUE is load-bearing:
    // `import("node:fs")` must still hand `firstStringFrom` a real specifier, or the edge is
    // reported with an empty one and no closure can resolve it. `isUnterminated()` is the
    // scanner's own answer to which is which, so this needs no guess about where a window ends.
    const swallowing =
      OPAQUE_KINDS.has(kind) && scanner.isUnterminated()
        ? start
        : window.jsxText
          ? firstNonWhitespaceOffset(source, reached, kind === SK.EndOfFile ? window.end : start)
          : null;
    if (swallowing !== null) {
      // The one character rewound past is the OPENER itself — a lone `"`, `` ` `` or `/`, which
      // no runtime executes on its own and which cannot be an import, an `eval` or a `require`.
      // Everything after it is re-offered to the scanner, so it is accounted for here rather
      // than left as a hole mechanism 3 would refuse the file over.
      if (swallowing > covered) {
        const gap = firstUnaccountedOffset(source, covered, swallowing);
        if (gap !== null) return unaccounted(source, gap);
      }
      covered = Math.max(covered, swallowing + 1);
      scanner.resetTokenState(swallowing + 1);
      reached = swallowing + 1;
      previous = SK.EndOfFile;
      jsxPunctuation = false;
      continue;
    }
    reached = Math.max(reached, end);
    if (kind === SK.EndOfFile) {
      // THE TAIL, and it is not a formality: the measured shape is an unterminated `/*` with NO
      // token after it, so the per-token gap check below never runs and the span it swallowed —
      // `import "node:fs"; eval("1");` in the row that found this — left the stream silently.
      // Same answer as everywhere else: one character past the opener, and keep lexing.
      const tail = firstUnaccountedOffset(source, covered, window.end);
      if (tail !== null) {
        covered = tail + 1;
        scanner.resetTokenState(tail + 1);
        reached = tail + 1;
        previous = SK.EndOfFile;
        jsxPunctuation = false;
        continue;
      }
      return { covered, guard };
    }

    if (TRIVIA_KINDS.has(kind)) {
      // The scanner RETURNING a trivia kind is it saying it DECLINED TO LEX that span — its
      // binary-file detector (`NonTextFileMarkerTrivia`, which any invalid UTF-8 byte decodes
      // into) is the measured case, and it spans from that offset to the end of the window.
      //
      // RE-LEXED, NOT REFUSED, and not skipped either (task 14b fix round 1). Round 1 of task 14
      // answered this with a refusal, which was the only tool it had; the rewind is strictly
      // better at the same job. The bypass that guard existed for is "everything after the
      // marker left the stream" — and rewinding one character past the marker puts every one of
      // those characters back, so the `import`, `eval`, `require` and `new Function` after it are
      // all reported, where a refusal only ever said "I could not read this file".
      //
      // It also removes the last measured over-fire: `// ` + U+FFFD is a COMMENT to Bun, which
      // accepts the file, and the marker only became live to this scanner because a regular
      // expression upstream had been mis-lexed. Refusing there rejected legal source.
      //
      // WHAT CHANGES FOR A GENUINE `�` AT A CODE POSITION: the file is now SCANNED (and its
      // real violations reported) instead of returning `UNSCANNABLE_SOURCE`. Bun rejects such a
      // source outright, so it never reaches the runtime either way; the security diagnostics
      // survive and the "I could not read it" one is no longer true. `lexer.test.ts` pins both
      // halves.
      covered = Math.max(covered, start + 1);
      scanner.resetTokenState(start + 1);
      reached = start + 1;
      previous = SK.EndOfFile;
      jsxPunctuation = false;
      continue;
    }

    if (end === start) {
      // A ZERO-WIDTH token that is not end-of-file: the scanner consumed nothing, so scanning
      // again from here returns the same token forever. Resume one character later, and count
      // that character as accounted for.
      //
      // ADVANCING, not failing closed, and the difference is measured rather than argued. A
      // sweep of every code point in U+0000..U+02FF through `createScanner(true, Standard)`
      // finds EXACTLY ONE stalling character: `#` (`scan()` answers `PrivateIdentifier` at zero
      // width forever). A `#` that IS followed by an identifier start is a legal private
      // identifier and lexes normally with a real width, so the stall only ever happens on a
      // LONE `#` — a character the runtime cannot execute either (`Bun.Transpiler` rejects it
      // outside a shebang or a private field). Skipping it hides nothing: it can be no import,
      // no `eval`, no `require`, and every subsequent character is still offered to the scanner.
      //
      // Failing closed here instead was implemented and MEASURED first: it refuses an
      // extensionless `Dockerfile` of `#` comments, which `tree-scan.ts`'s measured predicate
      // classifies as code — the "tightened guard bricks a real input" failure this branch has
      // already paid for twice.
      covered = Math.max(covered, start + 1);
      scanner.resetTokenState(start + 1);
      jsxPunctuation = opensJsxPunctuation(kind, previous);
      previous = kind;
      continue;
    }

    if (guard > cap) {
      // Unreachable while every iteration advances at least one character, kept as defense in
      // depth — and it FAILS CLOSED rather than returning the partial stream it used to.
      return new SourceStreamTruncatedError({
        reason: `the scanner produced more than ${cap} tokens for a ${source.length}-character source without reaching end-of-file`,
      });
    }

    // MECHANISM 3 — everything between the last accounted-for offset and this token must be
    // whitespace, a terminated comment or a leading shebang. The measured offender is an
    // UNTERMINATED `/*`, which `createScanner(true, …)` SKIPS: it returns no comment kind and
    // end-of-file still reports `source.length`, so neither a trivia guard nor a positional
    // check can see it.
    //
    // RE-LEXED, NOT REFUSED (task 14b fix round 1). The invariant offers two arms — scan the
    // span as code, or fail closed — and this takes the first, because failing closed here was
    // measured to reject sources Bun ACCEPTS: a `/*` sitting inside what Bun reads as a `//`
    // line comment becomes live to this scanner whenever a regular expression upstream was
    // mis-lexed, and the whole page was then rejected over a comment. Rewinding one character
    // past the opener makes the swallowed span ordinary tokens instead, so nothing is hidden and
    // nothing legal is refused. A page that really does hold an unterminated `/*` in code is
    // rejected by Bun regardless, so the extra findings this can produce there cost nothing.
    if (start > covered) {
      const gap = firstUnaccountedOffset(source, covered, start);
      if (gap !== null) {
        covered = gap + 1;
        scanner.resetTokenState(gap + 1);
        reached = gap + 1;
        previous = SK.EndOfFile;
        jsxPunctuation = false;
        continue;
      }
    }
    covered = Math.max(covered, end);

    guard += 1;
    const value =
      kind === SK.StringLiteral || kind === SK.NumericLiteral
        ? scanner.getTokenValue()
        : kind === SK.Identifier
          ? scanner.getTokenText()
          : "";
    toks.push({ kind, value, pos: start, jsxText: window.jsxText });
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
 * kind, so no trivia guard can see it) and runs to end of file. Inside a prose window that span
 * is a page's own copy and the window's own end bounds it; anywhere else the runtime refuses the
 * file outright, so failing closed here agrees with it rather than over-firing.
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

/** The first non-whitespace offset in `[from, to)`, or `null` when the span is blank. */
function firstNonWhitespaceOffset(source: string, from: number, to: number): number | null {
  for (let i = from; i < to; i += 1) {
    if (!WHITESPACE.test(source[i]!)) return i;
  }
  return null;
}

/**
 * Token kinds that consume an arbitrary span of source as ONE opaque unit, so whatever they
 * cover is invisible to every scan built on this stream. Inside a prose window each one is
 * rewound past instead of emitted — see {@link lexWindow}.
 */
const OPAQUE_KINDS: ReadonlySet<number> = new Set<number>([
  SK.StringLiteral,
  SK.NoSubstitutionTemplateLiteral,
  SK.TemplateHead,
  SK.TemplateMiddle,
  SK.TemplateTail,
  SK.RegularExpressionLiteral,
]);

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

export type { JsxTextRange };
