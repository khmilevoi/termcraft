import * as errore from "errore";
import { LanguageVariant, SyntaxKind, createScanner } from "typescript/unstable/ast";
import type { Scanner } from "typescript/unstable/ast";

/**
 * Short alias for the unstable AST `SyntaxKind` enum, which every gate scan compares
 * against. NOTE: the end-of-file member is `EndOfFile` (=1), NOT `EndOfFileToken`.
 */
export const SK = SyntaxKind;

/** The token-kind type behind {@link SK}, re-exported so the gate's scans keep the
 * unstable AST package as a single import seam. */
export type { SyntaxKind };

/** One lexed token: its kind, its string value (for literals/identifiers), and its start offset. */
export interface Tok {
  readonly kind: SyntaxKind;
  readonly value: string;
  readonly pos: number;
}

/**
 * What one open `{` currently in scope actually is. `scan()` cannot tell the two
 * apart on its own, yet they close differently: a real brace — a block, an
 * object literal, a JSX expression container — is closed by a plain
 * `CloseBraceToken`, while the `${` that opened a template literal's
 * interpolation is closed by a `}` that RESUMES the literal (in `` `a${x}b` ``
 * the `` }b` `` is one more template token, not code, and only
 * `reScanTemplateToken` lexes it that way — see `node_modules/typescript/dist/
 * ast/scanner.d.ts`). Callers thread a stack of these through
 * {@link scanCodeToken}, innermost last.
 */
export type BraceContext = "brace" | "template";

/**
 * Scan the next CODE token, keeping `braces` up to date and resolving the one
 * token a plain `scan()` classifies wrongly: the `}` that resumes a template
 * literal. Left unresolved, the scanner reads that `}` as a brace and then
 * takes the literal's own closing backtick as the START of a fresh template,
 * swallowing everything after it (up to the next backtick, or to EOF) into one
 * literal token — which is how a real `eval(...)` written after an interpolated
 * string used to disappear from the token stream entirely.
 *
 * Deliberately NOT handled here: re-scanning `/` as a regular expression.
 * {@link tokenize} below lexes a page's JSX punctuation as code too, and there
 * `</Text>` and `{expr} />` both put a `/` in a position no expression has just
 * ended — `reScanSlashToken` would happily turn either into a regex literal
 * that swallows the rest of the line. `./jsx`'s reader knows when it is
 * genuinely inside code, so it layers that re-scan on top of this step itself.
 */
export function scanCodeToken(scanner: Scanner, braces: BraceContext[]): SyntaxKind {
  const kind = scanner.scan();
  if (kind === SK.OpenBraceToken) {
    braces.push("brace");
    return kind;
  }
  if (kind === SK.TemplateHead) {
    braces.push("template");
    return kind;
  }
  if (kind !== SK.CloseBraceToken) return kind;
  if (braces[braces.length - 1] !== "template") {
    braces.pop(); // a stray `}` with an empty stack pops nothing — harmless
    return kind;
  }
  // `}…${` (TemplateMiddle) keeps the interpolation context open for the next
  // span; `}…` ` (TemplateTail) ends the literal. An UNTERMINATED literal also
  // comes back as a tail, with the scanner parked at EOF. That is a real
  // fail-closed guarantee for `./jsx`'s reader — its own caller
  // (`attemptElement`) treats hitting EOF before a matching `}` as a failed
  // read and falls back to ordinary code, never to text — but it is NOT one
  // for {@link tokenize} below: an unterminated template literal has no such
  // fallback there, so the swallowed span (everything from the unmatched
  // opening backtick to EOF) simply never produces the separate tokens a real
  // `eval`/`Function` reference inside it would need to be caught by (KNOWN
  // GAP, pinned in `import-scan.test.ts`).
  const resumed = scanner.reScanTemplateToken(false);
  if (resumed !== SK.TemplateMiddle) braces.pop();
  return resumed;
}

/**
 * Tokenize a page source with the TypeScript lexer. Shared by the gate's source
 * scans (import allowlist, page contract) so both read exactly the tokens the
 * author wrote — never the transform's injected edges. Template literals are
 * followed across their interpolations ({@link scanCodeToken}), so the text
 * spans of `` `a${x}b` `` stay literal tokens and the code between them stays
 * code. The `source.length + 1` cap is a hard backstop against a wrong terminal-
 * token assumption spinning the loop.
 *
 * Not followed correctly: a `}` inside a regular-expression body (never
 * re-scanned as one here, by design — see {@link scanCodeToken}'s own doc
 * comment) can desync this same brace/template tracking and swallow real code
 * — including an unterminated template's tail running straight through EOF
 * with no failure signal at all. `import-scan.ts`'s own KNOWN GAP inventory is
 * where every reproduced shape of this is named and pinned; this function
 * does not special-case any of them.
 *
 * THE COMPLETENESS INVARIANT (task-14 review round 1, Critical C1). Every scan
 * built on this function — the import allowlist, the `eval`/`Function` ban, the
 * page contract, every determinism lint — reasons about the tokens it is given
 * as if they were the file. Nothing checked that they WERE. They are not,
 * whenever `scan()` hands back a TRIVIA kind: a trivia kind returned (rather
 * than skipped) is the scanner saying it DECLINED TO LEX that span, and the
 * span runs to the end of the file. Enforced here rather than in any one scan,
 * because every one of them shares the assumption.
 *
 * MEASURED, and this is why the guard is stated as "no trivia kind" rather than
 * as any one character or kind. `�` — which is precisely what
 * `TextDecoder` produces for ANY invalid UTF-8 byte, and `core/kernel`'s turn
 * staging decodes every tree file through it unfiltered — makes the scanner
 * emit `NonTextFileMarkerTrivia` (its binary-file detector) spanning from that
 * offset to EOF. One `�` at a token position therefore erased 61 of 132
 * characters from the stream, taking `import fs from "node:fs"`, `eval(...)`,
 * `require(...)` and `new Function(...)` with them, and Bun EXECUTES that
 * module (verified by `await import()`-ing it: the side effect ran). Through
 * the real perimeter, before this guard: zero violations reported; the same
 * file with the `�` replaced by `x`: all four. For a SHARED module the
 * whole-tree scan is the only check there is, so that was a total bypass.
 *
 * DELIBERATELY NOT a `�` check, and not a position check either. A
 * position check is what this guard was first written as, and it does not work:
 * measured, the scanner's `getTokenEnd()` at EOF still reports `source.length`
 * for the truncated file (132 = 132), because the trivia token itself spans the
 * swallowed region. The trivia-kind test is both the correct mechanism and the
 * general one — it catches any present or future kind the scanner surfaces to
 * say "I did not lex this", not the one character a probe happened to find.
 *
 * PROVEN NOT TO OVER-FIRE, not assumed: `scan()` returns no trivia kind for
 * ordinary sources, a `#!` shebang, a leading BOM, comments, whitespace, or
 * even git conflict markers — and all 886 of the repository's own `.ts`/`.tsx`
 * files tokenize with zero refusals (`lexer.test.ts`'s corpus test re-runs that
 * measurement, so it cannot go stale silently).
 * The one behaviour change is stated on {@link SourceStreamTruncatedError}'s
 * own test: a legal source with `�` at a token position is now REFUSED.
 */
export function tokenize(source: string): Tok[] {
  const scanner = createScanner(true, LanguageVariant.Standard);
  scanner.setText(source);
  const toks: Tok[] = [];
  const braces: BraceContext[] = [];
  const cap = source.length + 1;
  let guard = 0;
  for (
    let kind = scanCodeToken(scanner, braces);
    kind !== SK.EndOfFile;
    kind = scanCodeToken(scanner, braces)
  ) {
    if (TRIVIA_KINDS.has(kind)) {
      // The span the scanner declined to lex — reported by its start offset, which is where
      // coverage of this file actually stopped.
      throw new SourceStreamTruncatedError({
        reason: `the scanner returned ${kindName(kind)} at offset ${scanner.getTokenStart()}, so the ${scanner.getTokenEnd() - scanner.getTokenStart()} character(s) from there were never lexed`,
      });
    }
    if (scanner.getTokenEnd() === scanner.getTokenStart()) {
      // A ZERO-WIDTH token that is not end-of-file: the scanner consumed nothing, so scanning
      // again from here returns the same token forever. Resume one character later instead.
      //
      // MEASURED, and this is a REAL, PRE-EXISTING, REACHABLE TRUNCATION that enforcing the
      // invariant above is what surfaced (task-14 review round 1, found while proving C1's fix
      // does not over-fire). A `#` that is not the start of a legal private identifier —
      // `<Text>#7ad7ff</Text>`, a hex colour in JSX text, which this project's entire palette
      // is made of (`design/termcraft-engine.js`'s `pal`) — makes `scan()` return
      // `PrivateIdentifier` at zero width, forever. The old loop's `guard <= cap` condition
      // caught the spin and SILENTLY RETURNED the partial token list, so everything after the
      // `#` was unscanned: exactly C1's bypass shape, through a character a design page is far
      // more likely to contain. Four of the repository's own 886 `.ts`/`.tsx` files were
      // already being truncated this way (`host/protocol/model/frame.ts`,
      // `runtime/model/tokens.test.ts`, `ui/chat/model/markdown-lite.ts`,
      // `ui/theme/model/palette.test.ts`).
      //
      // ADVANCING, not failing closed, and the difference matters: skipping ONE character at an
      // offset where no token exists cannot hide an import, an `eval` or a `require` — every
      // subsequent character is still offered to the scanner, so the stream still covers the
      // source. Failing closed here instead would refuse every design page that renders a hex
      // colour, which is the "tightened guard bricks a real command" failure this branch has
      // already paid for twice.
      scanner.resetTokenState(scanner.getTokenStart() + 1);
      continue;
    }
    if (guard > cap) {
      // Unreachable now that every iteration advances at least one character (above), but kept
      // as defense in depth — and it FAILS CLOSED rather than returning the partial stream the
      // way it used to, because a silent partial stream is the whole defect C1 names.
      throw new SourceStreamTruncatedError({
        reason: `the scanner produced more than ${cap} tokens for a ${source.length}-character source without reaching end-of-file`,
      });
    }
    guard += 1;
    const value =
      kind === SK.StringLiteral || kind === SK.NumericLiteral
        ? scanner.getTokenValue()
        : kind === SK.Identifier
          ? scanner.getTokenText()
          : "";
    toks.push({ kind, value, pos: scanner.getTokenStart() });
  }
  return toks;
}

/**
 * {@link tokenize} could not produce a token stream covering the whole source, so nothing
 * downstream may treat the tokens it saw as that file's complete content. Carried as a throw so
 * every existing fail-closed converter picks it up unchanged: `tree-scan.ts`'s
 * `TreeFileUnscannableError` (-> `UNSCANNABLE_SOURCE`), `gate/adapters/gate-runner.ts`'s
 * `ClosureEdgesUnreadableError` (-> `edges-unreadable`), and `gate.ts`'s per-page catch.
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
const TRIVIA_KINDS: ReadonlySet<number> = new Set(
  Object.entries(SyntaxKind)
    .filter(([name, value]) => typeof value === "number" && name.endsWith("Trivia"))
    .map(([, value]) => value as number),
);

/** The enum member name for a kind, for diagnostics — `String(kind)` when the reverse mapping has none. */
function kindName(kind: SyntaxKind): string {
  const name = (SyntaxKind as unknown as Record<number, string | undefined>)[kind];
  return name ?? String(kind);
}

/** Convert a source offset to 1-based line/column for diagnostics. */
export function lineColOf(source: string, pos: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < pos && i < source.length; i += 1) {
    if (source[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}
