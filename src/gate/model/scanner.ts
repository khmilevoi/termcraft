import { SyntaxKind } from "typescript/unstable/ast";
import type { Scanner } from "typescript/unstable/ast";

/**
 * The raw TypeScript-scanner primitives every gate scan is built on: the kind enum, the token
 * record, the one token a plain `scan()` classifies wrongly, and an offset-to-line mapper.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `./lexer` (task 14b). `./lexer`'s `tokenize` must know
 * where a file's JSX children TEXT is before it lexes anything, because a code-mode lexer
 * started inside JSX prose reads an apostrophe as a string opener and a `/*` as a comment —
 * which is the whole differential-parse defect task 14b exists to close. That knowledge lives in
 * `./jsx`, and `./jsx` is itself built on the primitives below. Keeping the primitives here
 * makes the dependency a chain — `scanner -> jsx -> lexer` — instead of a cycle between `lexer`
 * and `jsx`. `./lexer` re-exports every symbol below, so no call site had to change.
 */

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
 * Deliberately NOT handled here: re-scanning `/` as a regular expression. That decision needs
 * to know what the PREVIOUS token was, which this function is not given; `./jsx`'s `scanCode`
 * layers it on top, and both `./jsx`'s reader and `./lexer`'s `tokenize` go through that one
 * implementation so the two can never disagree about where a regular expression starts.
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
  // comes back as a tail, with the scanner parked at EOF — which `./lexer`'s
  // coverage accounting is what turns into a refusal rather than a silent
  // truncation, and which `./jsx`'s `attemptElement` already treated as a failed
  // read.
  const resumed = scanner.reScanTemplateToken(false);
  if (resumed !== SK.TemplateMiddle) braces.pop();
  return resumed;
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
