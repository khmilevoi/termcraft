import { LanguageVariant, SyntaxKind, createScanner } from "typescript/unstable/ast";

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
 * Tokenize a page source with the TypeScript lexer. Shared by the gate's source
 * scans (import allowlist, page contract) so both read exactly the tokens the
 * author wrote — never the transform's injected edges. The `source.length + 1` cap
 * is a hard backstop against a wrong terminal-token assumption spinning the loop.
 */
export function tokenize(source: string): Tok[] {
  const scanner = createScanner(true, LanguageVariant.Standard);
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
