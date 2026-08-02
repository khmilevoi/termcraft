import * as errore from "errore";
import {
  LanguageVariant,
  createScanner,
  tokenIsIdentifierOrKeyword,
} from "typescript/unstable/ast";
import type { Scanner } from "typescript/unstable/ast";

import { SK, scanCodeToken } from "./scanner";
import type { BraceContext, SyntaxKind, Tok } from "./scanner";

/**
 * The deepest JSX element nesting this reader will descend into before refusing the whole
 * source. Chosen an order of magnitude above real code and PINNED THERE BY A TEST that scans
 * every `src/ui/**\/*.tsx` in this repository — the deepest genuine JSX available, and the same
 * shape a design page has. Raising it is a cost decision; lowering it below the measurement is
 * a correctness one, and the test is what says which you are doing.
 *
 * WHY IT EXISTS. The reader is recursive descent with retries; the element memo bounds how
 * often one element is DERIVED, not the recursion. Measured through `scanTreeImports` on
 * `"<a>{".repeat(k)`: 16 000 chars 1 541 ms, 24 000 chars 3 774 ms, ~28 800 chars up to ~9 s
 * before the JS stack exhausts — and WHETHER it exhausts is stochastic, so the overflow is not
 * a bound anyone can rely on. `gate/model/gate.ts`'s `runTreeImports` is synchronous and runs
 * once per turn; 512 files at that cost is ~77 minutes of blocked event loop from ~14.8 MB,
 * comfortably inside the store's own 512-file / 64 MiB budget (task-14 report §9 item 1).
 */
export const MAX_JSX_NESTING_DEPTH = 64;

/**
 * The source nests JSX deeper than {@link MAX_JSX_NESTING_DEPTH}. THROWN, not returned, and
 * that is deliberate in a codebase whose rule is errors-as-values.
 *
 * The reader's every function returns `boolean` — "this was an element" / "it was not" — and a
 * `false` return means "no JSX here", which for a source that really does contain JSX is a
 * PARTIAL SCAN: the exact failure mode {@link readElement}'s own doc says this module must
 * never have, because a partial scan silently drops import diagnostics. Threading an error
 * value out through every recursive return would work, but the abort channel it would build is
 * the one this module ALREADY has: the stack exhaustion that `tree-scan.ts`'s `errore.try`
 * converts into a fail-closed `UNSCANNABLE_SOURCE`. This throw takes that same path,
 * deterministically and ~4 orders of magnitude sooner.
 *
 * Every production entry into this reader is inside that guard — `scanTreeImports`
 * (`gate/model/tree-scan.ts`) for `scanImportAllowlist`, and `gate/adapters/gate-runner.ts`'s
 * own `errore.try` for `scanModuleEdges`. Both were checked when this landed; a new caller
 * that is not guarded is a fail-open and must be given one.
 */
export class JsxNestingTooDeepError extends errore.createTaggedError({
  name: "JsxNestingTooDeepError",
  message: "JSX nesting exceeds the $limit-level ceiling at source offset $pos",
}) {}

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

/**
 * Everything ONE completed {@link readElement} produced at one source offset — its verdict, the
 * scanner position it left behind, and the exact rows it appended to the collector — kept so a
 * SECOND read of the very same `<` replays it instead of re-lexing the region.
 *
 * All four fields are needed, and each one is what makes the replay observationally identical to
 * a fresh read rather than merely similar:
 *
 * - `ok` — the verdict both call sites branch on.
 * - `end` — the scanner's own `getTokenEnd()`, which IS its scan position, so
 *   `resetTokenState(end)` leaves the next `scan()`/`scanJsxToken()` reading exactly the
 *   characters a fresh read would have. Every caller scans before it inspects any token state,
 *   so nothing observes the difference between "parked after a real token" and "reset to that
 *   same offset".
 * - `elements`/`textRanges` — the delta, replayed on a hit. This is not bookkeeping: a FAILED
 *   read can legitimately leave rows behind (see {@link readElement}'s doc comment on the
 *   attribute list's missing rollback), and `normalizeElements`/`normalizeRanges` are built to
 *   absorb exactly those duplicates. Dropping the delta on a memo hit would silently change what
 *   the scan sees, which is the one thing an optimisation here must never do.
 */
interface ElementRead {
  readonly ok: boolean;
  readonly end: number;
  readonly elements: readonly JsxElement[];
  readonly textRanges: readonly JsxTextRange[];
}

/** The reader's own mutable accumulator, threaded through every recursive call
 * instead of two separate array parameters. Confirmed elements/text ranges are
 * pushed as they're found; a failed attempt truncates both back to where it
 * started (see `readChildren`), so nothing speculative survives a fail-closed
 * outcome.
 *
 * `reads` is this one whole-source read's element memo (see {@link readElement}), keyed by the
 * source offset of an element's own `<`. It lives here because the collector is already threaded
 * through every recursive call, and it is created per {@link scanJsx} call because a source
 * offset only means something against one source. */
interface Collector {
  readonly elements: JsxElement[];
  readonly textRanges: JsxTextRange[];
  readonly reads: Map<number, ElementRead>;
  /** Current recursion depth, incremented around each {@link readElementUncached} and checked
   * against {@link MAX_JSX_NESTING_DEPTH}. A MEMO HIT DOES NOT COUNT: replaying a recorded read
   * consumes no stack, so charging it depth would refuse a source the reader can handle. */
  depth: number;
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
 * - `}`: a legal regex predecessor in plain code too, but this reader re-lexes a FAILED element
 *   attempt's own JSX punctuation as code (see `attemptElement`), where `{expr} />` puts a `/`
 *   right after one. Re-scanning there would swallow the rest of the line into a bogus regex
 *   literal and hide the well-formed elements behind it, so division wins there on purpose.
 *   MEASURED in task 14b: every spelling of the reachable half of this — a regular expression
 *   opening right after a `}` in an expression position — is REJECTED by `Bun.Transpiler`
 *   (`Unexpected }`), because only a block or an object literal can put a `}` there and a JSX
 *   expression container holds neither. So the `}` exclusion costs no live bypass; it is pinned
 *   rather than assumed, in `jsx.test.ts`.
 *
 * `<` USED TO BE ON THAT LIST AND IS NOT ANY MORE (task 14b). It was there for the same reason
 * as `}` — a re-lexed `</tag>` puts a `/` right after a `<` — but the two cases are
 * distinguishable and were being conflated. `jsxPunctuation` is the distinction, decided by the
 * CALLER, which is the only place that knows: a `<` this reader is re-lexing out of a failed
 * element attempt is JSX punctuation, while a `<` that reached the caller's ordinary path did so
 * precisely BECAUSE its own predecessor ended an expression, i.e. it is a relational operator and
 * a regular expression may legally follow it. Conflating them cost two measured live bypasses —
 * `a{0 < /[}]/.test(s) && eval("1")}b` inside a JSX container, and
 * `` `${0 < /[{]/.test("x")}` `` followed by `import "node:fs"` and `eval("1")` — both of which
 * `Bun.Transpiler` accepts and `await import()` executes while the whole perimeter reported
 * nothing.
 *
 * EXPORTED for `./lexer`'s `tokenize` (task 14b), which used to lex `/` as division
 * unconditionally and so lost a whole `eval(...)` behind a `}` written inside a regular
 * expression's character class (`import-scan.ts`'s KNOWN GAPS 6 and 6b). One implementation,
 * so the whole-file token stream and this reader can never disagree about where a regular
 * expression starts — a disagreement between them would move a JSX text boundary.
 */
export function scanCode(
  scanner: Scanner,
  braces: BraceContext[],
  previous: SyntaxKind,
  jsxPunctuation: boolean,
): SyntaxKind {
  const kind = scanCodeToken(scanner, braces);
  if (kind !== SK.SlashToken && kind !== SK.SlashEqualsToken) return kind;
  if (jsxPunctuation) return kind;
  if (endsExpression(previous)) return kind;
  if (previous === SK.CloseBraceToken) return kind;
  return scanner.reScanSlashToken();
}

/**
 * True when a `<` the caller has just scanned is JSX PUNCTUATION rather than a relational
 * operator — the one input {@link scanCode} cannot derive for itself.
 *
 * The rule is the same one {@link endsExpression} already encodes, read the other way round: JSX
 * is a primary expression, so a `<` that opens an element can never follow a token that has just
 * finished one. `./lexer`'s `tokenize` uses this directly (it lexes `</box>` linearly and must
 * keep that `/` a division); this module's own drivers use it implicitly, by only ever attempting
 * an element where `endsExpression(previous)` is false.
 */
export function opensJsxPunctuation(kind: SyntaxKind, previous: SyntaxKind): boolean {
  return kind === SK.LessThanToken && !endsExpression(previous);
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
  // True only while the previous token is JSX punctuation this reader re-lexed out of a FAILED
  // element attempt (`attemptElement`), where `</tag>` puts a `/` right after a `<`.
  let jsxPunctuation = false;
  for (;;) {
    const kind = scanCode(scanner, braces, previous, jsxPunctuation);
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
      const read = attemptElement(scanner, collector);
      previous = read ? SK.GreaterThanToken : SK.LessThanToken;
      jsxPunctuation = !read;
      continue;
    }
    previous = kind;
    jsxPunctuation = false;
  }
}

/**
 * {@link readElementUncached}, memoized on the source offset of the element's own `<` — the
 * ONLY entry point; every call site below goes through this one.
 *
 * WHY, measured on `"<a>{".repeat(k)` — a shape an agent-authored page reaches by simply leaving
 * elements unterminated, containing no `#` and triggering no `scannerStalled` — through
 * `tokenize` (which reaches this module through `readJsxTextRanges`), the identical call shape
 * against this module before
 * and after, warmed up. The whole-perimeter cost (`scanTreeImports` → `scanImportAllowlist` →
 * here → `scanJsx`) is within noise of the "after" column, and `scanTreeImports` reports ZERO
 * errors on every row, so every millisecond below was wasted work:
 *
 * | chars | before | after |
 * | --- | --- | --- |
 * | 32 | 0.4 ms | 0.10 ms |
 * | 64 | 47.6 ms | 0.08 ms |
 * | 88 | 2 155 ms | 0.18 ms |
 * | 96 | 12 971 ms | 0.22 ms |
 * | 1 600 | never run — the extrapolation is past 10^100 ms | ~30 ms |
 *
 * `runTreeImports` (`gate/model/gate.ts`) is SYNCHRONOUS and Task 14 calls it once per turn, so
 * before this fix a 104-character page body would have blocked the event loop for about half a
 * minute with no timeout, no cancellation and no error to report.
 *
 * THE MECHANISM, confirmed rather than assumed. `attemptElement` rewinds a failed attempt to
 * `start + 1` and the caller resumes scanning the SAME characters as ordinary code, so a failed
 * element at offset p is re-attempted at every `<` inside the region it just walked. Each of
 * those retries recurses the same way, so the attempt at nesting level i costs
 * `A(i) = A(i+1) + A(i+2) + …`, i.e. exactly `2·A(i+1)` — the measured ~1.9-2.4x per level. The
 * retries are not redundant in themselves (they are what finds a well-formed element inside a
 * malformed wrapper, see `attemptElement`'s doc), but re-DERIVING the same element read at the
 * same offset is: {@link readElementUncached} is a pure function of (source, offset), because
 * the only state it reads is the scanner's text and position, and its `<` token is always
 * exactly one character wide (`<=`/`<<` lex as their own kinds). So the second read cannot
 * differ from the first, and replaying the first is not an approximation of it.
 *
 * A MEMO, NOT A LIMITER, on purpose. A depth/iteration cap would silently return a PARTIAL scan
 * on legitimate input — the one failure mode this module must not have (`scannerStalled`'s doc
 * makes the same argument for the same reason). The memo changes no verdict on any input: `ok`,
 * the scanner position and the collector delta are all replayed (see {@link ElementRead}), and
 * that equivalence is executed, not argued — a byte copy of the pre-memo reader against this one
 * over 888 real repository sources, 30 000 seeded fuzz strings and 144 backtracking-heavy shapes,
 * zero divergences.
 *
 * WHAT IT DOES NOT FIX, stated here rather than only in a report, because the sentence above
 * reads as reassurance otherwise. The memo bounds how often one element is DERIVED; it does not
 * make the read linear, and it does not bound the recursion. Measured through `scanTreeImports`,
 * same shape: 16 000 chars 1 541 ms, 24 000 chars 3 774 ms — seconds of SYNCHRONOUS event-loop
 * time on a page an agent could produce by running away, with zero errors to show for it. Beyond
 * that the recursive descent exhausts the JS stack outright (32 000 chars unterminated, 99 996
 * well-formed). Neither is a regression — the pre-memo reader overflows at the same order of
 * magnitude on well-formed input, and merely hung before reaching it on unterminated input — but
 * neither is harmless: `gate/model/gate.ts`'s `runTreeImports` is synchronous and Task 14 gives
 * it its first caller. `tree-scan.ts`'s `TreeFileUnscannableError` converts the throw into a
 * fail-closed fatal so it cannot crash that caller; the seconds of blocking are NOT bounded and
 * are recorded in task-12b's report as an open residual with an owner.
 */
function readElement(scanner: Scanner, collector: Collector): boolean {
  const start = scanner.getTokenStart();
  const cached = collector.reads.get(start);
  if (cached !== undefined) {
    for (const element of cached.elements) collector.elements.push(element);
    for (const range of cached.textRanges) collector.textRanges.push(range);
    scanner.resetTokenState(cached.end);
    return cached.ok;
  }
  collector.depth += 1;
  if (collector.depth > MAX_JSX_NESTING_DEPTH)
    throw new JsxNestingTooDeepError({ limit: MAX_JSX_NESTING_DEPTH, pos: start });
  const elemStart = collector.elements.length;
  const textStart = collector.textRanges.length;
  const ok = readElementUncached(scanner, collector);
  // No `finally`: `readElementUncached` returns a boolean on every path it controls, and the
  // one path it does not — this ceiling throwing from a deeper frame — abandons the whole scan,
  // so there is no read left to keep the counter honest for.
  collector.depth -= 1;
  collector.reads.set(start, {
    ok,
    end: scanner.getTokenEnd(),
    elements: collector.elements.slice(elemStart),
    textRanges: collector.textRanges.slice(textStart),
  });
  return ok;
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
 *
 * Called ONLY through {@link readElement} above, which memoizes it. This body must therefore
 * stay a pure function of (the source text, the offset of the `<` the scanner is parked on):
 * anything it read from ambient state would let two reads of the same offset differ, and the
 * memo would then change the scan's own result rather than only its cost.
 */
function readElementUncached(scanner: Scanner, collector: Collector): boolean {
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
 * Still NOT claimed: that this read is linear in the source. `attemptElement`
 * re-lexes a failed attempt's whole region, so a source region can be walked
 * more than once. What IS now bounded is how often any ONE element is
 * DERIVED: {@link readElement} memoizes each `<` offset for the duration of
 * this call, so the compounding that made `"<a>{".repeat(k)` cost roughly 2x
 * per extra nesting level — 96 chars took 13 seconds, 8 more chars would have
 * taken a minute — is gone (96 chars: 0.2ms; 1600 chars: ~30ms). The residual
 * growth is polynomial, not exponential, and still real: 24 000 chars costs
 * ~3.8s, and deeper still exhausts the stack. See {@link readElement} for the
 * measurement, the mechanism, why a memo rather than a limiter, and what the
 * memo does NOT fix. The memo costs nothing measurable on ordinary input —
 * the whole repository corpus through this reader ran 148.0ms before and
 * 147.3ms after (median of 5 warmed passes; the corpus was 888 files when
 * that was taken).
 *
 * Two callers build on this single result: `readJsxTextRanges` (which
 * `./lexer`'s `tokenize` uses to lex AROUND a page's prose rather than
 * through it — task 14b) and `lintUnpointedElements` (`lints.ts` needs every
 * real element's tag name/id/position) — one notion of JSX, not two.
 */
export function scanJsx(source: string): JsxScan {
  const scanner = createScanner(true, LanguageVariant.JSX);
  scanner.setText(source);
  const collector: Collector = { elements: [], textRanges: [], reads: new Map(), depth: 0 };
  const braces: BraceContext[] = [];

  let previous: SyntaxKind = SK.EndOfFile;
  // True only while the previous token is JSX punctuation this reader re-lexed out of a FAILED
  // element attempt (`attemptElement`), where `</tag>` puts a `/` right after a `<`.
  let jsxPunctuation = false;
  for (;;) {
    const kind = scanCode(scanner, braces, previous, jsxPunctuation);
    if (kind === SK.EndOfFile) break;
    // A stalled scanner (see `scannerStalled`) ends the read here. Whatever follows is simply
    // never recognized as JSX, so `import-scan.ts` keeps treating it as ordinary code — the
    // fail-closed direction, and the same one every malformed shape already takes.
    if (scannerStalled(scanner, kind)) break;
    if (kind === SK.LessThanToken && !endsExpression(previous)) {
      const read = attemptElement(scanner, collector);
      previous = read ? SK.GreaterThanToken : SK.LessThanToken;
      jsxPunctuation = !read;
      continue;
    }
    previous = kind;
    jsxPunctuation = false;
  }

  return { elements: normalizeElements(collector.elements), textRanges: collector.textRanges };
}

/**
 * Every genuine JSX children-TEXT range of one source, sorted and with touching or overlapping
 * pairs fused — {@link scanJsx}'s `textRanges` in the shape a positional walk can consume.
 *
 * THIS IS WHAT `./lexer`'s `tokenize` LEXES AROUND (task 14b). Inside these ranges the runtime
 * runs no code at all: `scanJsxToken` reads children text as text, so an apostrophe is not a
 * string opener, `//` is not a comment, `/*` is not a comment, `#7ad7ff` is not a private
 * identifier and a backtick is not a template literal. A CODE-mode lexer started inside one of
 * them reads all five as code and swallows whatever real code follows — measured through the
 * real perimeter as 94 differential divergences before this was threaded into `tokenize`.
 *
 * FAIL-CLOSED, unchanged: a region {@link scanJsx} could not confirm as a real element
 * contributes NO range, so `tokenize` keeps lexing it as ordinary code. Under-reporting text
 * costs precision (a page's prose is scanned as code and can trip a false `eval` fatal);
 * over-reporting it would cost a bypass. Only the first direction is possible here.
 */
export function readJsxTextRanges(source: string): readonly JsxTextRange[] {
  return normalizeRanges(scanJsx(source).textRanges);
}

/**
 * The same text ranges, sorted by start and with any touching or overlapping
 * pair fused into one — the shape {@link readJsxTextRanges}'s consumers need. `scanJsx` emits its ranges in source order and disjoint already
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
