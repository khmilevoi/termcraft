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
  // comes back as a tail, with the scanner parked at EOF, so the caller's own
  // end-of-file handling fails closed without a special case here.
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
 */
export function tokenize(source: string): Tok[] {
  const scanner = createScanner(true, LanguageVariant.Standard);
  scanner.setText(source);
  const toks: Tok[] = [];
  const braces: BraceContext[] = [];
  const cap = source.length + 1;
  for (
    let kind = scanCodeToken(scanner, braces), guard = 0;
    kind !== SK.EndOfFile && guard <= cap;
    kind = scanCodeToken(scanner, braces), guard += 1
  ) {
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
