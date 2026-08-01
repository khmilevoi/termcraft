import {
  LanguageVariant,
  createScanner,
  tokenIsIdentifierOrKeyword,
} from "typescript/unstable/ast";
import type { Scanner } from "typescript/unstable/ast";

import { SK, scanCodeToken } from "./lexer";
import type { BraceContext, SyntaxKind, Tok } from "./lexer";

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
 * confirm real — each listed once, even when an abandoned attribute-list
 * attempt (see `readElement`'s doc comment) recorded a nested element before
 * a later, independent retry confirmed the very same element again — and
 * every children-text range found inside them. */
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
 * postfix `++`/`--`. This is the classic JavaScript-lexer predicate, and this
 * reader needs it for both of the ambiguities a context-free scan cannot
 * settle on its own:
 *
 * - **`<` — JSX element or relational/generic?** A `<` immediately following
 *   one of these can only be a relational operator or a generic type-argument
 *   list opener (`Array<Foo>`, `useRef<T>()`, `a < b`) — never a JSX element
 *   start, because JSX is itself a primary expression and the grammar never
 *   allows one to begin where the previous one has just finished (no operator
 *   in between).
 * - **`/` — regular expression or division?** Symmetrically, a `/` after an
 *   expression-ending token is division; anywhere else a regular-expression
 *   literal may start, and `reScanSlashToken` must lex it as one so that a `}`
 *   inside a character class (`/[}]/`) is literal text rather than a brace.
 *
 * The real TypeScript parser gets both for free from its own recursive-descent
 * structure — it only ever calls into JSX-element or regex scanning from a
 * position already expecting a new expression; this reader has no such call
 * graph to inherit it from, so it checks explicitly, once, for the driver over
 * the whole source and the driver over one `{}` expression container's code
 * alike.
 *
 * The `<` half is what closes the fix-pass-3 "dangling `</Foo>`" gap
 * (`Array<Foo>` is never even attempted as a tag, so nothing hunts for a
 * matching close for it) and, as a side effect, replaces the dedicated
 * "closing `>` followed by a call paren" guard an earlier, plain code-token
 * walk needed to reject the same shape (`useRef<T>(...)` is rejected because
 * `useRef` — the identifier right before `<` — already ends an expression,
 * independent of whatever follows the generic's own `>`).
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
    case SK.RegularExpressionLiteral:
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
 * True when the token the scanner has JUST produced is ZERO-WIDTH and is not the end of the
 * file — `getTokenStart() === getTokenEnd()`, i.e. the scan consumed no characters, so the next
 * identical call consumes none either and every `for (;;)` driver below would spin forever.
 *
 * This is a real, reachable state, not a defensive hypothetical: the TypeScript scanner returns
 * `PrivateIdentifier@p..p` indefinitely for a `#` that is not followed by an identifier start
 * (measured — `#`, `# comment`, `const x = 1 # 2` each produce that token forever, while the
 * legal `class C { #x = 1 }` produces `PrivateIdentifier@10..12` and advances normally). `#` is
 * the comment character of every extensionless file the tree may legitimately hold
 * (`Dockerfile`, `Makefile`, `README`), and `tree-scan.ts`'s measured perimeter classifies those
 * as code and feeds them here, so the shape arrives through ordinary content rather than
 * through an attack.
 *
 * `./lexer`'s `tokenize` survives the same input only because of the `source.length + 1` cap on
 * its own loop. This is the same backstop in exact rather than proxy form, and the difference
 * matters HERE specifically: `tokenize` never rewinds, so counting its iterations against the
 * source length is provably safe there, whereas this reader BACKTRACKS
 * (`attemptElement`'s `resetTokenState` rewinds and re-lexes a failed attempt's region), so no
 * iteration bound is self-evidently large enough to never truncate a legitimate read — and a
 * bound chosen too small silently returns a PARTIAL scan, which is the one failure mode this
 * module must not have. Comparing a single token's own start against its own end needs no bound
 * at all: it costs O(1), never compares across iterations, so backtracking cannot confuse it,
 * and it names the actual defect rather than approximating it.
 *
 * Every caller treats a stall as the malformed-input case it already has: the drivers stop, and
 * the element readers fail closed. Nothing is newly trusted — the unread region stays visible
 * to `import-scan.ts` as ordinary CODE rather than as exempted JSX text, which is the same
 * direction `scanJsx`'s doc comment describes for every other malformed shape.
 */
function scannerStalled(scanner: Scanner, kind: SyntaxKind): boolean {
  return kind !== SK.EndOfFile && scanner.getTokenStart() === scanner.getTokenEnd();
}

/**
 * Scan the next CODE token for either of this reader's two code drivers: the
 * whole-source one in `scanJsx` and the per-container one in
 * `skipExpressionContainer`. Template literals are followed across their
 * interpolations by `./lexer`'s shared `scanCodeToken` (which owns the
 * `braces` stack), and a `/` that cannot be division is re-scanned here as a
 * regular-expression literal, so neither construct's `}`-looking characters
 * are ever mistaken for a brace.
 *
 * KNOWN GAP — three predecessors are read as division even though a regular
 * expression could legally follow them, so a `}` in such a regex DOES close
 * the enclosing container early. All three are reachable: each can leave a
 * real `eval(...)`/`Function(...)` call sitting in what the reader then calls
 * children text, unguarded by the fatal dynamic-code check.
 *
 * - `)` (via `endsExpression`): correct in every expression position, wrong in
 *   STATEMENT position (`if (x) /re/.test(s)` inside an arrow-function body).
 *   Telling the two apart needs the statement/expression distinction only a
 *   parser has. Pinned by the "regex literal in STATEMENT position after `)`"
 *   KNOWN GAP test in `import-scan.test.ts`.
 * - `<` and `}`: legal regex predecessors in plain code too, but this reader
 *   re-lexes a FAILED element attempt's own JSX punctuation as code (see
 *   `attemptElement`), where `</tag>` and `{expr} />` put a `/` right after
 *   exactly those two tokens. Re-scanning there would swallow the rest of the
 *   line into a bogus regex literal and hide the well-formed elements behind
 *   it, so division wins there on purpose — the same trade as `)`, not a free
 *   one: `x < /[}]/.test(s) && eval(...)` and `{} /[}]/.test(s) && eval(...)`
 *   both hide the call just as `)` does. Pinned at the reader level by the
 *   "regex literal right after `<` or `}`" KNOWN GAP test in `jsx.test.ts`,
 *   and at the reachable-call level by the matching KNOWN GAP tests in
 *   `import-scan.test.ts`.
 */
function scanCode(scanner: Scanner, braces: BraceContext[], previous: SyntaxKind): SyntaxKind {
  const kind = scanCodeToken(scanner, braces);
  if (kind !== SK.SlashToken && kind !== SK.SlashEqualsToken) return kind;
  if (endsExpression(previous)) return kind;
  if (previous === SK.LessThanToken || previous === SK.CloseBraceToken) return kind;
  return scanner.reScanSlashToken();
}

/**
 * Try reading one JSX element at the scanner's CURRENT token, which must
 * already be a `LessThanToken` fetched by the caller's own scan. On success,
 * `collector` gains whatever `readElement` found and the scanner sits on the
 * element's last token, ready for the caller's next scan. On failure —
 * malformed or unterminated JSX, read JSX must fail closed — nothing is
 * trusted: the scanner is rewound to just past the failed `<`
 * (`resetTokenState`) so the caller resumes scanning the SAME code from there,
 * and the caller's own "try every position independently" loop (the whole
 * point of a shared helper here) still reaches whatever the failed attempt
 * walked over, including a well-formed nested element the failed attempt gave
 * up around. Either way the caller advances with its own `scanCode` call, so
 * the brace/template stack it threads stays the one authority on `}`.
 */
function attemptElement(scanner: Scanner, collector: Collector): boolean {
  const start = scanner.getTokenStart();
  if (readElement(scanner, collector)) return true;
  scanner.resetTokenState(start + 1);
  return false;
}

/**
 * Read one JSX attribute list's `{...}` value, one spread attribute's
 * `{...expr}` tail, or one JSX children `{...}` expression container — the
 * scanner is already past the opening `{`. Walks the contents with the plain
 * code scanner (`scanCode`, never `scanJsxToken()`: this IS code) until the
 * `{` this call started on is closed, trying every `<` it meets along the way
 * as a nested element (`endsExpression` guards against `a < b`-shaped code
 * inside the expression the same way the outer driver does).
 *
 * `braces` is what makes the "until the matching `}`" part true rather than
 * merely plausible: an ordinary string literal's braces were already safe (the
 * scanner returns the whole literal as one token), but a template literal's
 * `` ${…} `` and a regular expression's `/[}]/` are not — `scanCode` resolves
 * both, and the stack records which construct each open `{` belongs to, so the
 * `}` that ends an interpolation is never mistaken for this container's own.
 *
 * Returns false only on an unterminated `{` (EOF before the matching `}`) —
 * fail closed, per `scanJsx`'s doc comment.
 */
function skipExpressionContainer(scanner: Scanner, collector: Collector): boolean {
  const braces: BraceContext[] = ["brace"]; // the `{` the caller already consumed
  let previous: SyntaxKind = SK.EndOfFile;
  for (;;) {
    const kind = scanCode(scanner, braces, previous);
    if (kind === SK.EndOfFile) return false;
    // A stalled scanner (see `scannerStalled`) is treated exactly like the unterminated `{`
    // below it: this container never closes, so the enclosing element fails closed.
    if (scannerStalled(scanner, kind)) return false;
    // Stop right on the container's OWN matching `}` — do not consume one more
    // token past it: the caller (an attribute value, or JSX children) expects
    // the scanner positioned exactly after this `}`, and an unconditional extra
    // scan here would silently eat whatever comes next (the self-closing `/`,
    // or the first character of the next JSX text run) before the caller ever
    // sees it.
    if (kind === SK.CloseBraceToken && braces.length === 0) return true;
    if (kind === SK.LessThanToken && !endsExpression(previous)) {
      previous = attemptElement(scanner, collector) ? SK.GreaterThanToken : SK.LessThanToken;
      continue;
    }
    previous = kind;
  }
}

/**
 * Read one JSX element (or Fragment) starting at its own `<` — already the
 * scanner's current token when this is called, whether from `scanJsx`'s own
 * driver or from a recursive call below. Returns true and records the element
 * (plus, for a container, every genuine children text range) on success;
 * false — leaving the scanner wherever the failed read gave up, for the
 * caller to rewind — on any malformed or unterminated shape.
 *
 * The open tag is read with the plain code scanner: a name via `readTagName`
 * (dotted, and hyphen-merging), then an attribute list whose entries are a
 * name — plain, hyphenated, or namespaced (`xml:lang`, one colon-joined pair,
 * matching the JSX grammar's own `JsxNamespacedName`, never a chain) — with an
 * optional value: either a string (`scanJsxAttributeValue()` — the JSX
 * grammar's own attribute-string scan, which does not require the surrounding
 * quotes to also be valid CODE-mode string syntax) or a `{...}` expression
 * container (`skipExpressionContainer`) — or a spread `{...expr}`.
 * Anything else in attribute position fails the whole element: that is what
 * rejects `<b>`-shaped false positives like `foo\nbar = c > d` sitting in what
 * looked like an attribute list (a bare, unquoted, non-`{` value is not legal
 * JSX), and it is why the spread branch insists on a literal `...` rather than
 * accepting any `{`-opened attribute.
 *
 * A FAILED attribute list has no rollback of its own here — unlike
 * `readChildren`, which truncates `collector` back to where it started on
 * failure, a `{...}` value already read successfully by `skipExpressionContainer`
 * earlier in the SAME attribute list stays in `collector` even though the
 * element around it is later abandoned. If the top-level driver then reaches
 * the very same nested element again independently and confirms it for real,
 * it is recorded twice; `scanJsx`'s `normalizeElements` is what de-duplicates
 * that, not this function.
 */
function readElement(scanner: Scanner, collector: Collector): boolean {
  const pos = scanner.getTokenStart(); // this element's own `<`
  let kind = scanner.scan();

  if (kind === SK.GreaterThanToken) {
    // A bare Fragment: `<>` — never carries attributes, so never an `id`.
    return readChildren(scanner, { tagName: "", pos, hasId: false, selfClosing: false }, collector);
  }
  const name = readTagName(scanner, kind);
  if (name === null) return false;
  const tagName = name.name;

  let hasId = false;
  kind = name.next;
  for (;;) {
    // A stalled scanner (see `scannerStalled`) is nothing this attribute list can consume —
    // `<p #>x</p>` reaches here — so fail the element closed, the same outcome every other
    // illegal token in attribute position already gets at the bottom of this loop.
    if (scannerStalled(scanner, kind)) return false;
    if (tokenIsIdentifierOrKeyword(kind)) {
      kind = scanner.scanJsxIdentifier();
      const isBareIdCandidate = scanner.getTokenText() === "id";
      kind = scanner.scan();
      if (kind === SK.ColonToken) {
        // A namespaced attribute name (`xml:lang="en"`, `id:foo="x"`) — legal
        // JSX the scanner has no dedicated call for. Read the local part the
        // same way the name itself was read, then fall through to the
        // ordinary value handling below. A namespaced name is never treated
        // as the bare `id` prop, whether `id` is the LOCAL part (`xml:id`,
        // decided against because the segment read above was `xml`, not
        // `id`) or the NAMESPACE part (`id:foo`, decided against here
        // because a colon follows) — only a colon-free bare `id` counts.
        kind = scanner.scan();
        if (!tokenIsIdentifierOrKeyword(kind)) return false;
        scanner.scanJsxIdentifier();
        kind = scanner.scan();
      } else if (isBareIdCandidate) {
        hasId = true;
      }
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
    if (kind === SK.OpenBraceToken) {
      // A spread attribute — `{...rest}`. The `...` is required: it is the
      // only shape the JSX grammar allows a `{` to open in attribute position.
      if (scanner.scan() !== SK.DotDotDotToken) return false;
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
    // Symmetry with the three loops above. `scanJsxToken` has NOT been observed to stall —
    // measured over `<p></p>`, `<p> </p>`, `<p>a</p>`, `<p>#</p>`, `<p>{x}{y}</p>`,
    // `<p><b/></p>`: zero zero-width non-EOF tokens, and `<p># Heading</p>` reads fine on the
    // real reader — so this guard is inert today and is here so the last `for (;;)` in the
    // module is not the one left able to spin.
    if (scannerStalled(scanner, kind)) break;
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

/**
 * Read one JSX tag name — the scanner's current token is the name's first
 * token, whose kind the caller passes as `first`. Two shapes, both spelled out
 * by the JSX grammar and both ordinary page code here:
 *
 * - a plain name, via `scanJsxIdentifier()`, which merges `data-id`-shaped
 *   hyphens into one token (the JSX-specific counterpart to
 *   `readHyphenatedName` above) — `box`, `my-widget`;
 * - a member expression, `<Kit.Text>` / `<A.B.C>`, which a namespace import of
 *   the runtime (`import * as Kit from "@termcraft/runtime"`) makes the natural
 *   way to reference a Kit component. The dotted name is returned joined, so
 *   `closesTag` can require the close tag to spell exactly the same one.
 *
 * Returns null — the caller then fails the element closed — when the first
 * token is not a name at all, or when a `.` is not followed by one.
 * `next` is the token after the name, already scanned.
 */
function readTagName(
  scanner: Scanner,
  first: SyntaxKind,
): { readonly name: string; readonly next: SyntaxKind } | null {
  if (!tokenIsIdentifierOrKeyword(first)) return null;
  scanner.scanJsxIdentifier();
  let name = scanner.getTokenText();
  let kind = scanner.scan();
  while (kind === SK.DotToken) {
    if (!tokenIsIdentifierOrKeyword(scanner.scan())) return null;
    scanner.scanJsxIdentifier();
    name += `.${scanner.getTokenText()}`;
    kind = scanner.scan();
  }
  return { name, next: kind };
}

/** Having just scanned a `LessThanSlashToken`, confirm it is THIS element's
 * own close: a bare `</>` when `tagName` is `""` (a Fragment), else the very
 * same (possibly hyphenated, possibly dotted) name followed by `>`. */
function closesTag(scanner: Scanner, tagName: string): boolean {
  if (tagName === "") return scanner.scan() === SK.GreaterThanToken;
  const name = readTagName(scanner, scanner.scan());
  if (name === null) return false;
  return name.name === tagName && name.next === SK.GreaterThanToken;
}

/**
 * Read a whole page source as JSX, for real, over the actual TypeScript
 * scanner in its JSX language variant (`node_modules/typescript/dist/ast/
 * scanner.d.ts`: `scanJsxToken`, `scanJsxIdentifier`, `scanJsxAttributeValue`,
 * `resetTokenState`, and `LanguageVariant.JSX` via `createScanner`'s own
 * `languageVariant` parameter) — replacing an earlier walk over a plain
 * CODE-mode token array whose premise was unsound: guessing where JSX text
 * lives by walking CODE-mode tokens means an apostrophe or `//`
 * inside ordinary prose opens a real string literal or line comment that can
 * swallow a closing tag, silently curdling a page's own display copy into what
 * looks like live code (or, the mirror image, laundering real code into what
 * looks like harmless text — the "dangling `</Foo>`" gap, see
 * `endsExpression`'s doc comment). `scanJsxToken` never lexes strings or
 * comments in JSX children — text is just text — so an apostrophe, a `//` or
 * an em dash in a page's own display copy can no longer swallow its closing
 * tag.
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
 * What is NOT claimed: that a text/code boundary can never land in the wrong
 * place. The reader is a scanner, not a parser, and `scanCode`'s doc comment
 * records the shapes that still move a boundary — a regular-expression
 * literal right after `)`, `<`, or `}`, whose `}` closes an expression
 * container early — with their pinning tests.
 *
 * Also NOT claimed: that this read is linear in the source. `attemptElement`
 * re-lexes a failed attempt's whole region, and on DEEPLY NESTED UNTERMINATED
 * input that backtracking compounds — measured on `"<a>{".repeat(k)`, which
 * contains no `#` and no stall at all: 32 chars in 9ms, 72 chars in 287ms, 88
 * chars in 2359ms, roughly 3.5x per two more levels. That is pre-existing (the
 * numbers above are from this function BEFORE `scannerStalled` was added, and
 * the guard does not change them), it is a separate problem from the stall
 * `scannerStalled` fixes, and it is NOT fixed here — recorded so the next
 * reader finds it stated rather than has to rediscover it. It needs a memo on
 * failed `(position, kind)` attempts, not a limiter.
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
  const braces: BraceContext[] = [];

  let previous: SyntaxKind = SK.EndOfFile;
  for (;;) {
    const kind = scanCode(scanner, braces, previous);
    if (kind === SK.EndOfFile) break;
    // A stalled scanner (see `scannerStalled`) ends the read here. Whatever follows is simply
    // never recognized as JSX, so `import-scan.ts` keeps treating it as ordinary code — the
    // fail-closed direction, and the same one every malformed shape already takes.
    if (scannerStalled(scanner, kind)) break;
    if (kind === SK.LessThanToken && !endsExpression(previous)) {
      previous = attemptElement(scanner, collector) ? SK.GreaterThanToken : SK.LessThanToken;
      continue;
    }
    previous = kind;
  }

  return { elements: normalizeElements(collector.elements), textRanges: collector.textRanges };
}

/**
 * The CODE-mode token indices (`toks`, from `./lexer`'s `tokenize`, i.e. the
 * fatal dynamic-code check's own token stream) that fall inside genuine JSX
 * children TEXT, per `scanJsx` above. Mapping by POSITION — a source offset —
 * rather than by token identity is what makes it safe to reconcile against a
 * separately tokenized stream: `toks` and `scanJsx`'s own JSX-variant scan
 * read the same source characters, so a given offset means the same thing to
 * both regardless of where either scanner happened to draw a token boundary
 * there. A code-mode token born from mis-lexing prose (e.g. the STRING literal
 * an apostrophe opens) still STARTS inside the text range and is correctly
 * skipped regardless of how far its own span runs past the range's end.
 *
 * An `eval(...)`/`Function(...)` reference written as real code stays out of
 * every `textRanges` span, because `scanJsx` reads a `{...}` expression
 * container as code and records no text for it — with the pinned exceptions
 * in `scanCode`'s KNOWN GAP note, where a regular expression right after `)`,
 * `<`, or `}` closes a container early and what follows it inside that
 * container is recorded as text after all.
 */
export function computeJsxTextTokenIndices(
  toks: readonly Tok[],
  source: string,
): ReadonlySet<number> {
  const ranges = normalizeRanges(scanJsx(source).textRanges);
  if (ranges.length === 0) return new Set();

  // One merge walk over two lists already in source order (`toks` by
  // construction, `ranges` by `normalizeRanges`), instead of re-scanning every
  // range for every token: `r` only ever moves forward, so the whole mapping
  // is linear in tokens + ranges rather than their product.
  const textIdx = new Set<number>();
  let r = 0;
  for (let i = 0; i < toks.length; i += 1) {
    const pos = toks[i]!.pos;
    while (r < ranges.length && ranges[r]!.end <= pos) r += 1;
    if (r === ranges.length) break;
    if (pos >= ranges[r]!.pos) textIdx.add(i);
  }
  return textIdx;
}

/**
 * The same text ranges, sorted by start and with any touching or overlapping
 * pair fused into one — the shape `computeJsxTextTokenIndices`'s merge walk
 * needs. `scanJsx` emits its ranges in source order and disjoint already
 * (the scanner only moves forward within one successful read), but a failed
 * element attempt can leave a range behind that the retry then records a
 * second time, so this pass is what makes the walk's precondition a fact
 * rather than an assumption about the reader's backtracking.
 */
function normalizeRanges(ranges: readonly JsxTextRange[]): JsxTextRange[] {
  const sorted = [...ranges].sort((a, b) => a.pos - b.pos);
  const merged: JsxTextRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last === undefined || range.pos > last.end) {
      merged.push(range);
      continue;
    }
    if (range.end > last.end) merged[merged.length - 1] = { pos: last.pos, end: range.end };
  }
  return merged;
}

/**
 * `collector.elements` with any duplicate dropped, keyed by each element's own
 * `<` position — the one thing that uniquely identifies which physical open
 * tag produced it, so two entries sharing a `pos` can never disagree on the
 * rest of their shape. The same failed-attempt backtracking that motivates
 * `normalizeRanges` above produces this duplicate too, but through a different
 * path: `readElement`'s attribute-list loop has no rollback of its own (see
 * its doc comment), so a nested element read once inside an attribute value
 * that USED to be well-formed — until a later, unrelated token in the SAME
 * attribute list fails the whole enclosing element — stays in `collector`
 * even though the enclosing element never commits; if the top-level driver
 * then reaches that nested element's `<` again on its own and confirms it for
 * real, it is recorded a second time.
 */
function normalizeElements(elements: readonly JsxElement[]): JsxElement[] {
  const seen = new Set<number>();
  const result: JsxElement[] = [];
  for (const el of elements) {
    if (seen.has(el.pos)) continue;
    seen.add(el.pos);
    result.push(el);
  }
  return result;
}
