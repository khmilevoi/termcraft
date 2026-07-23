import {
  LanguageVariant,
  createScanner,
  tokenIsIdentifierOrKeyword,
} from "typescript/unstable/ast";
import type { Scanner } from "typescript/unstable/ast";

import { SK } from "./lexer";
import type { SyntaxKind, Tok } from "./lexer";

/**
 * Read a (possibly hyphenated) name starting at `start`: `id`, but also
 * `data-id`, `aria-label`, `my-widget`, etc. — the CODE-mode lexer (`./lexer`,
 * `LanguageVariant.Standard`) sees each hyphen as its own `MinusToken`, so a
 * name spanning one is only complete once the merge stops. Returns `null`
 * when `start` isn't an Identifier at all. `next` is the token index right
 * after the merged name.
 *
 * Used only by `lints.ts`'s `extractDeclaredIds`, which walks the plain CODE
 * token stream looking for both the JSX form (`id="p"`) and the object-literal
 * form (`id: "p"`) of a declared id — the latter is never real JSX, so it
 * cannot go through `scanJsx` below, which is why this stays a standalone
 * token-array walker rather than folding into the real-scanner reader.
 */
export function readHyphenatedName(
  toks: readonly Tok[],
  start: number,
): { readonly name: string; readonly next: number } | null {
  const first = toks[start];
  if (first === undefined || first.kind !== SK.Identifier) return null;
  let name = first.value;
  let j = start + 1;
  while (toks[j]?.kind === SK.MinusToken && toks[j + 1]?.kind === SK.Identifier) {
    name += `-${toks[j + 1]!.value}`;
    j += 2;
  }
  return { name, next: j };
}

/**
 * One real JSX element the reader below has confirmed — self-closing, or with
 * a genuine matching close tag — anywhere in the source: its tag name ("" for
 * a bare Fragment), whether it carries an `id` attribute (literal or
 * expression-valued — presence is all that matters, matching `id={x}` too),
 * and the source offset of its own opening `<`, for lint diagnostics.
 */
export interface JsxElement {
  readonly tagName: string;
  readonly hasId: boolean;
  readonly pos: number;
}

/** A half-open source range `[pos, end)` of genuine JSX children TEXT — never
 * inside a `{}` expression container. */
export interface JsxTextRange {
  readonly pos: number;
  readonly end: number;
}

/** Both outputs of one whole-source JSX read: every element `scanJsx` could
 * confirm real, and every children-text range found inside them. */
export interface JsxScan {
  readonly elements: readonly JsxElement[];
  readonly textRanges: readonly JsxTextRange[];
}

/** The reader's own mutable accumulator, threaded through every recursive call
 * instead of two separate array parameters. Confirmed elements/text ranges are
 * pushed as they're found; a failed attempt truncates both back to where it
 * started (see `readChildren`), so nothing speculative survives a fail-closed
 * outcome. */
interface Collector {
  readonly elements: JsxElement[];
  readonly textRanges: JsxTextRange[];
}

/** An open tag `readElement` has finished reading, on its way to
 * `readChildren`: the (possibly hyphenated, merged) tag name — `""` for a bare
 * Fragment — whether it declared an `id` attribute, the source offset of its
 * own opening `<`, and whether it was self-closing (`/>`, no children to read
 * at all). */
interface OpenTag {
  readonly tagName: string;
  readonly pos: number;
  readonly hasId: boolean;
  readonly selfClosing: boolean;
}

/**
 * Token kinds that end a PRIMARY expression: an identifier reference, a
 * literal, a closing `)`/`]`, `this`/`super`/`true`/`false`/`null`, or a
 * postfix `++`/`--`. A `<` immediately following one of these can only be a
 * relational operator or a generic type-argument list opener (`Array<Foo>`,
 * `useRef<T>()`, `a < b`) — never a JSX element start, because JSX is itself a
 * primary expression and the grammar never allows one to begin where the
 * previous one has just finished (no operator in between). The real
 * TypeScript parser gets this for free from its own recursive-descent
 * structure — it only ever calls into JSX-element parsing from a position
 * already expecting a new expression; this reader has no such call graph to
 * inherit it from, so it checks explicitly, once, for both the driver over
 * the whole source and the driver over one `{}` expression container's code.
 *
 * This one check is what closes the fix-pass-3 "dangling `</Foo>`" gap
 * (`Array<Foo>` is never even attempted as a tag, so nothing hunts for a
 * matching close for it) and, as a side effect, replaces every purpose the
 * old `scanOpenTag` heuristic's dedicated "closing `>` followed by a call
 * paren" guard served (`useRef<T>(...)` is rejected because `useRef` — the
 * identifier right before `<` — already ends an expression, independent of
 * whatever follows the generic's own `>`).
 */
function endsExpression(kind: SyntaxKind): boolean {
  switch (kind) {
    case SK.Identifier:
    case SK.CloseParenToken:
    case SK.CloseBracketToken:
    case SK.NumericLiteral:
    case SK.BigIntLiteral:
    case SK.StringLiteral:
    case SK.NoSubstitutionTemplateLiteral:
    case SK.TemplateTail:
    case SK.ThisKeyword:
    case SK.SuperKeyword:
    case SK.TrueKeyword:
    case SK.FalseKeyword:
    case SK.NullKeyword:
    case SK.PlusPlusToken:
    case SK.MinusMinusToken:
      return true;
    default:
      return false;
  }
}

/**
 * Try reading one JSX element at the scanner's CURRENT token, which must
 * already be a `LessThanToken` fetched by the caller's own `scan()`. On
 * success, `collector` gains whatever `readElement` found and the scanner
 * sits right after the consumed element. On failure — malformed or
 * unterminated JSX, read JSX must fail closed — nothing is trusted: the
 * scanner is rewound to just past the failed `<` (`resetTokenState`) so the
 * caller resumes scanning the SAME code from there, and the caller's own
 * "try every position independently" loop (the whole point of a shared
 * helper here) still reaches whatever the failed attempt walked over,
 * including a well-formed nested element the failed attempt gave up around.
 */
function attemptElement(
  scanner: Scanner,
  collector: Collector,
): { readonly consumed: boolean; readonly next: SyntaxKind } {
  const start = scanner.getTokenStart();
  if (readElement(scanner, collector)) {
    return { consumed: true, next: scanner.scan() };
  }
  scanner.resetTokenState(start + 1);
  return { consumed: false, next: scanner.scan() };
}

/**
 * Read one JSX attribute list's `{...}` value, or one JSX children `{...}`
 * expression container — the scanner is already past the opening `{`. Tracks
 * brace depth with the plain code scanner (`scan()`, never `scanJsxToken()`:
 * this IS code) until the matching `}`, trying every `<` it meets along the
 * way as a nested element (`endsExpression` guards against `a < b`-shaped
 * code inside the expression the same way the outer driver does). A string or
 * template literal's own `{`/`}`-looking characters never confuse the depth
 * count, because the real scanner returns them as part of one literal token,
 * never as separate brace tokens. Returns false only on an unterminated `{`
 * (EOF before the matching `}`) — fail closed, per `scanJsx`'s doc comment.
 */
function skipExpressionContainer(scanner: Scanner, collector: Collector): boolean {
  let depth = 1;
  let previous: SyntaxKind = SK.EndOfFile;
  let kind = scanner.scan();
  while (depth > 0) {
    if (kind === SK.EndOfFile) return false;
    if (kind === SK.OpenBraceToken) {
      depth += 1;
      previous = kind;
      kind = scanner.scan();
      continue;
    }
    if (kind === SK.CloseBraceToken) {
      depth -= 1;
      // Stop right here on the container's OWN matching `}` — do not consume
      // one more token past it: the caller (an attribute value, or JSX
      // children) expects the scanner positioned exactly after this `}`, and
      // an unconditional extra `scan()` here would silently eat whatever
      // comes next (the self-closing `/`, or the first character of the next
      // JSX text run) before the caller ever sees it.
      if (depth === 0) return true;
      previous = kind;
      kind = scanner.scan();
      continue;
    }
    if (kind === SK.LessThanToken && !endsExpression(previous)) {
      const attempt = attemptElement(scanner, collector);
      previous = attempt.consumed ? SK.GreaterThanToken : SK.LessThanToken;
      kind = attempt.next;
      continue;
    }
    previous = kind;
    kind = scanner.scan();
  }
  return true;
}

/**
 * Read one JSX element (or Fragment) starting at its own `<` — already the
 * scanner's current token when this is called, whether from `scanJsx`'s own
 * driver or from a recursive call below. Returns true and records the element
 * (plus, for a container, every genuine children text range) on success;
 * false — leaving the scanner wherever the failed read gave up, for the
 * caller to rewind — on any malformed or unterminated shape.
 *
 * The open tag is read with the plain code scanner: a name via
 * `scanJsxIdentifier()` (merges `data-id`-shaped hyphens into one token, the
 * JSX-specific counterpart to `readHyphenatedName` above), then an attribute
 * list whose value is either a string (`scanJsxAttributeValue()` — the JSX
 * grammar's own attribute-string scan, which does not require the surrounding
 * quotes to also be valid CODE-mode string syntax) or a `{...}` expression
 * container (`skipExpressionContainer`); anything else in attribute position
 * fails the whole element (this is what rejects `<b>`-shaped false positives
 * like `foo\nbar = c > d` sitting in what looked like an attribute list — a
 * bare, unquoted, non-`{` value is not legal JSX).
 */
function readElement(scanner: Scanner, collector: Collector): boolean {
  const pos = scanner.getTokenStart(); // this element's own `<`
  let kind = scanner.scan();

  if (kind === SK.GreaterThanToken) {
    // A bare Fragment: `<>` — never carries attributes, so never an `id`.
    return readChildren(scanner, { tagName: "", pos, hasId: false, selfClosing: false }, collector);
  }
  if (!tokenIsIdentifierOrKeyword(kind)) return false;
  kind = scanner.scanJsxIdentifier();
  const tagName = scanner.getTokenText();

  let hasId = false;
  kind = scanner.scan();
  for (;;) {
    if (tokenIsIdentifierOrKeyword(kind)) {
      kind = scanner.scanJsxIdentifier();
      if (scanner.getTokenText() === "id") hasId = true;
      kind = scanner.scan();
      if (kind !== SK.EqualsToken) continue; // a value-less (boolean) attribute
      kind = scanner.scanJsxAttributeValue();
      if (kind === SK.StringLiteral) {
        kind = scanner.scan();
        continue;
      }
      if (kind !== SK.OpenBraceToken) return false; // neither a string nor `{...}`
      if (!skipExpressionContainer(scanner, collector)) return false;
      kind = scanner.scan();
      continue;
    }
    if (kind === SK.SlashToken) {
      return (
        scanner.scan() === SK.GreaterThanToken &&
        readChildren(scanner, { tagName, pos, hasId, selfClosing: true }, collector)
      );
    }
    if (kind === SK.GreaterThanToken) {
      return readChildren(scanner, { tagName, pos, hasId, selfClosing: false }, collector);
    }
    return false; // nothing else is legal in an attribute list
  }
}

/**
 * Read the children of an already-open element/Fragment (`open.tagName` is
 * `""` for a Fragment), then commit it as a real `JsxElement` — but ONLY on
 * success: a container whose children never resolve to a genuine matching
 * close (mismatched name, or EOF) contributes NOTHING, not even the open tag
 * itself, to `collector` — fail closed, the same discipline `scanJsx`'s doc
 * comment describes for the whole reader. A self-closing tag skips children
 * entirely and commits immediately, since `/>` is complete on its own.
 *
 * Uses `scanJsxToken()` — the real JSX-children scan: text runs until the
 * next `<`/`{`/EOF with no code-mode lexing at all inside them, so an
 * apostrophe, `//`, or `—` in prose is just text, never a string opener or a
 * comment marker (the fix-pass-3 finding this reader replaces). `{...}` is an
 * expression container, skipped as code and never added to `textRanges`. A
 * nested `<` is a candidate child element, read recursively; if it fails, the
 * WHOLE enclosing element fails too (no "try again as text" recovery here,
 * unlike the top-level driver/`skipExpressionContainer`) — but `scanJsx`'s own
 * top-level loop still reaches that nested `<` on its own later and can
 * recognize it independently, so a well-formed nested element inside an
 * otherwise-broken wrapper is not lost.
 */
function readChildren(scanner: Scanner, open: OpenTag, collector: Collector): boolean {
  const { tagName, pos, hasId } = open;
  if (open.selfClosing) {
    collector.elements.push({ tagName, hasId, pos });
    return true;
  }
  const elemStart = collector.elements.length;
  const textStart = collector.textRanges.length;

  for (;;) {
    const kind = scanner.scanJsxToken();
    if (kind === SK.JsxText || kind === SK.JsxTextAllWhiteSpaces) {
      collector.textRanges.push({ pos: scanner.getTokenStart(), end: scanner.getTokenEnd() });
      continue;
    }
    if (kind === SK.OpenBraceToken) {
      if (skipExpressionContainer(scanner, collector)) continue;
      break;
    }
    if (kind === SK.LessThanSlashToken) {
      if (closesTag(scanner, tagName)) {
        collector.elements.push({ tagName, hasId, pos });
        return true;
      }
      break; // mismatched close (or a malformed one) — fail the whole element
    }
    if (kind === SK.LessThanToken) {
      if (readElement(scanner, collector)) continue;
      break;
    }
    break; // EndOfFile, ConflictMarkerTrivia, or anything else — unterminated
  }

  collector.elements.length = elemStart;
  collector.textRanges.length = textStart;
  return false;
}

/** Having just scanned a `LessThanSlashToken`, confirm it is THIS element's
 * own close: a bare `</>` when `tagName` is `""` (a Fragment), else a matching
 * (possibly hyphenated) name followed by `>`. */
function closesTag(scanner: Scanner, tagName: string): boolean {
  if (tagName === "") return scanner.scan() === SK.GreaterThanToken;
  const nameKind = scanner.scan();
  if (!tokenIsIdentifierOrKeyword(nameKind)) return false;
  scanner.scanJsxIdentifier();
  if (scanner.getTokenText() !== tagName) return false;
  return scanner.scan() === SK.GreaterThanToken;
}

/**
 * Read a whole page source as JSX, for real, over the actual TypeScript
 * scanner in its JSX language variant (`node_modules/typescript/dist/ast/
 * scanner.d.ts`: `scanJsxToken`, `scanJsxIdentifier`, `scanJsxAttributeValue`,
 * `resetTokenState`, and `LanguageVariant.JSX` via `createScanner`'s own
 * `languageVariant` parameter) — WP-6a fix-pass-3, replacing the earlier
 * code-token heuristic (`scanOpenTag`/`consumeJsxElement`) whose premise was
 * unsound: walking CODE-mode tokens to guess where JSX text lives means an
 * apostrophe or `//` inside ordinary prose opens a real string literal or line
 * comment that can swallow a closing tag, silently curdling a page's own
 * display copy into what looks like live code (or, the mirror image,
 * laundering real code into what looks like harmless text — the "dangling
 * `</Foo>`" gap, see `endsExpression`'s doc comment). `scanJsxToken` never
 * lexes strings or comments in JSX children — text is just text — so neither
 * failure mode can occur here.
 *
 * The driver walks the WHOLE source with the plain scanner, trying
 * `attemptElement` at every `<` not immediately preceded by an
 * expression-ending token (`endsExpression`) — independent of nesting, so a
 * well-formed element sitting inside an otherwise-malformed region is still
 * found on its own (see `readChildren`'s doc comment). Fail closed
 * throughout: any malformed or unterminated shape contributes nothing,
 * leaving that source region visible to the callers below as ordinary code,
 * never as exempted text.
 *
 * Two callers build on this single result: `computeJsxTextTokenIndices`
 * (`import-scan.ts`'s dynamic-code check needs to skip identifier/bracket
 * tokens that are JSX prose) and `lintUnpointedElements` (`lints.ts` needs
 * every real element's tag name/id/position) — one notion of JSX, not two.
 */
export function scanJsx(source: string): JsxScan {
  const scanner = createScanner(true, LanguageVariant.JSX);
  scanner.setText(source);
  const collector: Collector = { elements: [], textRanges: [] };

  let previous: SyntaxKind = SK.EndOfFile;
  let kind = scanner.scan();
  while (kind !== SK.EndOfFile) {
    if (kind === SK.LessThanToken && !endsExpression(previous)) {
      const attempt = attemptElement(scanner, collector);
      previous = attempt.consumed ? SK.GreaterThanToken : SK.LessThanToken;
      kind = attempt.next;
      continue;
    }
    previous = kind;
    kind = scanner.scan();
  }

  return collector;
}

/**
 * The CODE-mode token indices (`toks`, from `./lexer`'s `tokenize`, i.e. the
 * fatal dynamic-code check's own token stream) that fall inside genuine JSX
 * children TEXT, per `scanJsx` above. Mapping by POSITION — a source offset —
 * rather than by token identity is what makes it safe to reconcile against a
 * separately tokenized stream: `toks` and `scanJsx`'s own JSX-variant scan
 * read the same source characters, so a given offset means the same thing to
 * both regardless of where either scanner happened to draw a token boundary
 * there. A real `eval(...)`/`Function(...)` reference is never inside a
 * `textRanges` span (expression containers are excluded there already), while
 * a code-mode token born from mis-lexing prose (e.g. the STRING literal an
 * apostrophe opens) still starts inside the text range and is correctly
 * skipped regardless of how far its own span runs past the range's end.
 */
export function computeJsxTextTokenIndices(
  toks: readonly Tok[],
  source: string,
): ReadonlySet<number> {
  const { textRanges } = scanJsx(source);
  if (textRanges.length === 0) return new Set();

  const textIdx = new Set<number>();
  for (let i = 0; i < toks.length; i += 1) {
    const pos = toks[i]!.pos;
    if (textRanges.some((range) => pos >= range.pos && pos < range.end)) textIdx.add(i);
  }
  return textIdx;
}
