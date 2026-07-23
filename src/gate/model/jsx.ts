import { SK } from "./lexer";
import type { Tok } from "./lexer";

/**
 * One scanned JSX opening tag: its full (possibly hyphenated) name, whether it
 * carries an `id` prop, the token index of its own terminator (the `>` in
 * `<tag ...>` or `<tag .../>`), and whether it is self-closing (opens no
 * children region). Shared by `lints.ts`'s `lintUnpointedElements` (which only
 * needs `tagName`/`hasId`) and `import-scan.ts`'s dynamic-code check (which
 * additionally needs `terminatorIndex`/`selfClosing` to locate the children
 * region that follows a non-self-closing tag) — the single place both scans
 * agree on what counts as a real JSX open tag (WP-6a fix-pass-2, Important 1).
 */
export interface OpenTagScan {
  readonly tagName: string;
  readonly hasId: boolean;
  readonly terminatorIndex: number;
  readonly selfClosing: boolean;
}

/**
 * Read a (possibly hyphenated) name starting at `start`: `id`, but also
 * `data-id`, `aria-label`, `my-widget`, etc. — the lexer sees each hyphen as
 * its own `MinusToken`, so a tag/prop name spanning one is only complete once
 * the merge stops (§6.3 Also-fix: this is what keeps `data-id`/`aria-id` from
 * being counted as the `id` prop — the merged name is compared for equality
 * as a whole, never a single identifier segment in isolation). Returns `null`
 * when `start` isn't an Identifier at all. `next` is the token index right
 * after the merged name.
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
 * Scan one JSX opening tag starting at its `<` token (`start`): the (possibly
 * hyphenated) tag name, then its prop list up to the tag's own closing `>`/`/>` —
 * tracking brace depth so an expression-container prop value (e.g.
 * `color={x > y ? "a" : "b"}`) never terminates the scan early on the `>` inside
 * it. Returns `null` when `start` is not a real element's opening tag:
 *
 * - a closing `</...>` or a bare `<>` Fragment start, neither of which names
 *   an element (`first` isn't an Identifier);
 * - the tag name doesn't sit directly against `<` — no line break between them
 *   (Important 1) — so a `<` used as a relational operator with its right-hand
 *   operand pushed to a later line is never mistaken for a tag start;
 * - the walk hits a token that can never appear at depth 0 inside a JSX
 *   attribute list — `;`, a depth-0 `)`/`,`, another `<`, any keyword, a bare
 *   number, … (Important 1) — before it ever finds a closing `>`. The lexer is
 *   `LanguageVariant.Standard` (`lexer.ts`), so `<` is indistinguishable from
 *   `LessThanToken`-the-operator; without this abort the walk would happily
 *   cross statement/expression boundaries (`a < b`, `i < len` in a `for`
 *   condition) hunting for *some* later `>`, however unrelated;
 * - the walk runs off the end of the token stream without ever finding a
 *   closing `>` at all (Important 1) — the exact shape `a < b` and
 *   `rows.length < max` leave behind: a tag name with nothing after it that
 *   could possibly close a tag;
 * - the found closing `>` is immediately followed by a call's `(` (Important
 *   1) — `Identifier<Type>(...)` (a generic type-argument list, e.g.
 *   `useRef<T>()`) is lexically identical to a childless open tag up to this
 *   point, and the one shape a *real* element's `>` is never followed by is a
 *   call paren (you cannot invoke a rendered element), so that shape is
 *   rejected here instead of trying to tell "generic call" from "JSX" earlier.
 *
 * A generic type-argument list with no following call (`Array<Foo>`) is not
 * separately special-cased here: an uppercase argument is already exempt as a
 * Kit component by `lintUnpointedElements`, and a lowercase one violates
 * TypeScript's near-universal PascalCase type-naming convention — an accepted,
 * narrow residual gap for THAT lint. `computeJsxTextTokenIndices` below closes
 * this same gap for its own, higher-stakes purpose by requiring a genuine
 * matching close tag before it trusts anything as children text, rather than
 * tightening this function (which would be a second, redundant guard doing the
 * same job worse — see that function's doc comment).
 */
export function scanOpenTag(
  toks: readonly Tok[],
  start: number,
  source: string,
): OpenTagScan | null {
  const first = toks[start + 1];
  if (first === undefined || first.kind !== SK.Identifier) return null;

  const openTok = toks[start]!;
  if (source.slice(openTok.pos + 1, first.pos).includes("\n")) return null;

  const tagRead = readHyphenatedName(toks, start + 1)!;
  const tagName = tagRead.name;

  let hasId = false;
  let depth = 0;
  let foundTerminator = false;
  let j = tagRead.next;
  for (; j < toks.length; j += 1) {
    const t = toks[j]!;
    if (t.kind === SK.OpenBraceToken) {
      depth += 1;
      continue;
    }
    if (t.kind === SK.CloseBraceToken) {
      depth -= 1;
      continue;
    }
    if (depth > 0) continue;
    if (t.kind === SK.GreaterThanToken) {
      foundTerminator = true;
      break;
    }
    if (t.kind === SK.SlashToken) continue; // the self-closing `/>` marker
    if (t.kind === SK.EqualsToken || t.kind === SK.StringLiteral) continue;
    if (t.kind === SK.Identifier) {
      const prop = readHyphenatedName(toks, j)!;
      if (prop.name === "id") hasId = true;
      j = prop.next - 1; // the loop's own `j += 1` lands exactly on `prop.next`
      continue;
    }
    // Impossible inside a JSX attribute list at depth 0 — this `<` was never
    // a real tag start. See the exit-condition list in the doc comment above.
    return null;
  }
  if (!foundTerminator) return null;
  if (toks[j + 1]?.kind === SK.OpenParenToken) return null; // `Identifier<Type>(...)` generic call

  const selfClosing = toks[j - 1]?.kind === SK.SlashToken;
  return { tagName, hasId, terminatorIndex: j, selfClosing };
}

/** One JSX element the matching-close walk below has confirmed is real. */
interface ConsumedElement {
  /** Token index right after this element as a whole (past its own terminator
   * when self-closing, or past its matched closing tag's `>`). */
  readonly next: number;
  /** Token indices, anywhere inside this element (including nested children),
   * that are JSX children TEXT rather than code. */
  readonly textIndices: readonly number[];
}

/**
 * Consume one candidate JSX element starting at its `<` token (`start`),
 * confirming it is REAL by requiring a genuine matching closing tag — not just
 * a plausible-looking open tag (`scanOpenTag`'s own job) — before trusting
 * anything between them as children text. Returns `null`, marking nothing,
 * when no matching close is ever found: this is what keeps `scanOpenTag`'s
 * accepted `Array<Foo>` generic-type-argument gap from becoming a FATAL-check
 * false negative (see `computeJsxTextTokenIndices`'s doc comment for why the
 * stakes differ from `lintUnpointedElements`'s).
 *
 * An expression container (`{...}`) inside the children is real code, tracked
 * only by brace depth here — never added to `textIndices` — but any JSX
 * element nested inside it is still found and its own text still marked,
 * because `computeJsxTextTokenIndices`'s driver tries every `<` in the whole
 * token stream independently, including ones this function's own brace-depth
 * walk skips straight over. That redundancy is deliberate: it is what lets
 * this function stay a plain forward walk with no recursion into `{}`.
 *
 * A bare Fragment (`<>...</>`) is the one open-tag shape `scanOpenTag` itself
 * never recognizes (it requires an Identifier right after `<`) — handled here
 * directly as a nameless element whose matching close is a bare `</>` (no name
 * to compare), so Fragment children text is not missed the same way a named
 * tag's would be.
 */
function consumeJsxElement(
  toks: readonly Tok[],
  start: number,
  source: string,
): ConsumedElement | null {
  const isFragment = toks[start + 1]?.kind === SK.GreaterThanToken;
  const scan = isFragment ? null : scanOpenTag(toks, start, source);
  if (!isFragment && scan === null) return null;
  const tagName = isFragment ? "" : scan!.tagName;
  const terminatorIndex = isFragment ? start + 1 : scan!.terminatorIndex;
  if (!isFragment && scan!.selfClosing) return { next: terminatorIndex + 1, textIndices: [] };

  const textIndices: number[] = [];
  let j = terminatorIndex + 1;
  while (j < toks.length) {
    const t = toks[j]!;
    if (t.kind === SK.OpenBraceToken) {
      let depth = 1;
      j += 1;
      while (j < toks.length && depth > 0) {
        if (toks[j]!.kind === SK.OpenBraceToken) depth += 1;
        else if (toks[j]!.kind === SK.CloseBraceToken) depth -= 1;
        j += 1;
      }
      continue;
    }
    if (t.kind === SK.LessThanToken) {
      if (toks[j + 1]?.kind === SK.SlashToken) {
        if (tagName === "") {
          if (toks[j + 2]?.kind !== SK.GreaterThanToken) return null; // not a bare `</>`
          return { next: j + 3, textIndices };
        }
        const closeRead = readHyphenatedName(toks, j + 2);
        if (closeRead === null || closeRead.name !== tagName) return null;
        if (toks[closeRead.next]?.kind !== SK.GreaterThanToken) return null;
        return { next: closeRead.next + 1, textIndices };
      }
      const nested = consumeJsxElement(toks, j, source);
      if (nested === null) return null;
      textIndices.push(...nested.textIndices);
      j = nested.next;
      continue;
    }
    textIndices.push(j);
    j += 1;
  }
  return null; // ran off the end without a matching close -- not a real element
}

/**
 * The token indices, over a whole page source, that fall inside JSX children
 * TEXT — author-displayed prose between a real open tag's `>` and its matching
 * closing tag, never inside a `{}` expression container. Built for
 * `scanImportAllowlist`'s dynamic-code check (WP-6a fix-pass-2, Important 1):
 * before this helper, that scan had no notion of where JSX text ends and code
 * begins, so ordinary display copy containing the word "eval" or "Function"
 * tripped a FATAL rejection. Consuming this set lets the check skip identifier
 * tokens that are prose, while a real `eval(...)`/`Function(...)` reference
 * inside an expression container (`{eval("1")}`) stays visible, because that
 * span is never added here.
 *
 * Reuses `scanOpenTag` — the exact recognizer `lintUnpointedElements` already
 * uses — rather than teaching the import scan a second, independent notion of
 * what JSX looks like. The one place this helper is intentionally STRICTER
 * than `scanOpenTag` alone: it requires a genuine matching closing tag
 * (`consumeJsxElement`) before trusting anything as children text, so
 * `scanOpenTag`'s own accepted `Array<Foo>` gap (an uncalled generic
 * type-argument list parsed as a childless-looking open tag) cannot silently
 * swallow an arbitrary stretch of REAL code — including a real `eval`
 * reference — as bogus "text" all the way to the next incidental `<`/`{`.
 * `lintUnpointedElements` keeps using bare `scanOpenTag` unchanged: a spurious
 * warning from that same gap is a low-stakes, already-documented residual
 * (see `scanOpenTag`'s doc comment and the `unpointed-element` tests naming
 * it), nothing like the false negative a FATAL check would suffer from the
 * same imprecision — which is why this is a stricter SIBLING helper built on
 * the same primitive, not a change to `scanOpenTag` itself.
 *
 * Also recognizes a bare Fragment (`<>...</>`) as an element in its own right
 * (`consumeJsxElement`'s doc comment) — `scanOpenTag` alone does not, since a
 * Fragment names no tag — so `<>Never use eval here</>` is covered too, not
 * only the named-tag shape the observed false rejections happened to use.
 */
export function computeJsxTextTokenIndices(
  toks: readonly Tok[],
  source: string,
): ReadonlySet<number> {
  const textIdx = new Set<number>();
  for (let i = 0; i < toks.length; i += 1) {
    if (toks[i]!.kind !== SK.LessThanToken) continue;
    const consumed = consumeJsxElement(toks, i, source);
    if (consumed === null) continue;
    for (const idx of consumed.textIndices) textIdx.add(idx);
  }
  return textIdx;
}
