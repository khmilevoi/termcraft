import { LanguageVariant, ScriptTarget, SyntaxKind, createScanner } from "typescript/unstable/ast";

/**
 * Untyped view of the unstable AST `SyntaxKind` enum — the API ships the members
 * but without stable TS types on this pin; the numeric values are load-bearing.
 * NOTE: the end-of-file member is `EndOfFile` (=1), NOT `EndOfFileToken`.
 */
export const SK = SyntaxKind as unknown as Record<string, number>;

/** One lexed token: its kind, its string value (for literals/identifiers), and its start offset. */
export interface Tok {
  readonly kind: number;
  readonly value: string;
  readonly pos: number;
}

interface Scanner {
  setText(text: string): void;
  scan(): number;
  getTokenValue(): string;
  getTokenText(): string;
  getTokenStart(): number;
}

// The unstable/ast `createScanner` type on this pin disagrees with the runtime arg
// order (the classic `(languageVersion, skipTrivia, languageVariant)` call produces
// correct tokens here). Cast to a permissive callable and use the verified order.
const makeScanner = createScanner as unknown as (a: unknown, b: unknown, c: unknown) => Scanner;

/**
 * Tokenize a page source with the TypeScript lexer. Shared by the gate's source
 * scans (import allowlist, page contract) so both read exactly the tokens the
 * author wrote — never the transform's injected edges. The `source.length + 1` cap
 * is a hard backstop against a wrong terminal-token assumption spinning the loop.
 */
export function tokenize(source: string): Tok[] {
  const scanner = makeScanner(ScriptTarget.Latest, true, LanguageVariant.Standard);
  scanner.setText(source);
  const toks: Tok[] = [];
  const cap = source.length + 1;
  for (
    let kind = scanner.scan(), guard = 0;
    kind !== SK.EndOfFile && guard <= cap;
    kind = scanner.scan(), guard += 1
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
