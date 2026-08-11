import { SK, tokenize } from "./lexer";
import type { SourceStreamTruncatedError, SourceSyntax, SyntaxKind, Tok } from "./lexer";

/**
 * The keywords that begin a LOCAL declaration export. Mirrors `import-scan.ts`'s own
 * `DECLARATION_STARTS` — the same question, asked for a different purpose: that file asks
 * "does this `export` carry a module edge" (no, when the next token starts a local
 * declaration), this file asks "what NAME does this `export` bind". `DefaultKeyword` is
 * deliberately absent here (unlike `import-scan.ts`'s set) — a default export binds no named
 * export, so it is handled as its own branch below rather than folded into this set.
 */
const DECLARATION_STARTS: ReadonlySet<SyntaxKind> = new Set([
  SK.ConstKeyword,
  SK.LetKeyword,
  SK.VarKeyword,
  SK.FunctionKeyword,
  SK.ClassKeyword,
  SK.AsyncKeyword,
  SK.AbstractKeyword,
  SK.EnumKeyword,
  SK.InterfaceKeyword,
  SK.NamespaceKeyword,
  SK.ModuleKeyword,
  SK.TypeKeyword,
]);

/** Modifier keywords that may sit between a top-level `export` and the declaration keyword. */
const MODIFIER_KEYWORDS: ReadonlySet<SyntaxKind> = new Set([
  SK.AsyncKeyword,
  SK.AbstractKeyword,
  SK.DeclareKeyword,
]);

/** Kinds that close a `const`/`let`/`var` declarator list without opening a new one. */
function endsDeclaratorList(kind: SyntaxKind): boolean {
  return (
    kind === SK.SemicolonToken ||
    kind === SK.ExportKeyword ||
    kind === SK.ImportKeyword ||
    kind === SK.EndOfFile ||
    DECLARATION_STARTS.has(kind)
  );
}

/**
 * Every top-level NAMED export binding a module offers, read by tokenizing its source with the
 * SAME lexer (`./lexer`'s `tokenize`) `checkPageContract` and `scanImportAllowlist` use — so this
 * scan can never see a different program than the rest of the Gate does.
 *
 * WHY A TOKEN SCAN AND NOT THE TYPE CHECKER. The missing-binding fatal this scan feeds must work
 * with NO compiler available: `createGateRunnerAdapter`'s `tscExePath` is optional, so a
 * hermetic fixture can run the source-only Gate stages standalone. A fatal that silently
 * disappears whenever no compiler happens to be present is exactly the fabricated pass this
 * codebase keeps designing against — so the binding check has to be answerable from tokens alone.
 *
 * WHY `exhaustive` EXISTS, AND WHY FAIL-OPEN IS RIGHT HERE. This is not a security perimeter —
 * unlike `scanImportAllowlist`'s allowlist, nothing this scan reports blocks an import. It only
 * answers "does the module a manifest entry points at really offer the binding the entry names".
 * A scanner that FALSE-FATALED on a shape it merely could not read exhaustively — a destructuring
 * export (`export const { Button } = kit`) or a star re-export (`export * from "./kit"`) — would
 * reject a legal design-system component for a shape this scan cannot enumerate, not for anything
 * the author did wrong. Failing OPEN on that rare shape, loudly modelled in the return type as
 * `exhaustive: false`, beats a false fatal: a caller checks `exhaustive` and, when it is `false`,
 * MUST NOT report a missing name as a fatal. `exhaustive` goes `false` on THREE triggers: a
 * destructuring export target (`export const { … } = …` / `export const [ … ] = …`, in either a
 * `const`, `let` or `var` declaration); a star re-export (`export * from "…"`); and — the safety
 * net described below — a declarator initializer whose `function`/`class`/`async` shape this
 * scanner could not skip past cleanly (truncated/unbalanced brackets). The import allowlist,
 * which IS a perimeter, is untouched by this file — a `REEXPORT`/`DYNAMIC_IMPORT` violation this
 * scan happens to see through is still `scanImportAllowlist`'s call to make.
 *
 * A MULTI-DECLARATOR `const`/`let`/`var` LIST MAY HOLD A FUNCTION/CLASS/ASYNC-ARROW EXPRESSION
 * AS ANY DECLARATOR'S INITIALIZER (fix rounds 1 and 2, task review Important findings), e.g.
 * `export const a = function () {}, b = 2` or the common named-function-expression pattern
 * `export const Button = function Button() {}`. `function`, `class` and `async` are also
 * `DECLARATION_STARTS` members (they can start a top-level STATEMENT), so naively treating any
 * occurrence of one as "the declarator list ended" mis-happens twice over: round 1 fixed a
 * false-CLOSED failure — `b` silently lost while `exhaustive` stayed `true` — but only for the
 * FIRST declarator, which round 2's review then measured as (a) OVER-firing on a single-name
 * declaration with no sibling to lose (`export const a = function () {}` wrongly went
 * `exhaustive: false`) and (b) leaving the identical loss unfixed one declarator later
 * (`export const a = 1, b = function(){}, c = 2` still lost `c`). Both were the same root cause:
 * refusing to read PAST the keyword instead of reading THROUGH it.
 *
 * THE FIX: skip the initializer's own tokens (see {@link skipInitializerKeyword}) and keep
 * collecting — `function`'s optional name and parameter list, `class`'s optional name and
 * `extends <expr>` clause, `async`'s arrow parameter and `=>` — then let the ordinary depth-0 walk
 * (which already understands balanced brackets and a depth-0 comma) read the body/arrow-result
 * exactly as it reads any other initializer expression. THE SAFETY NET: when that skip cannot
 * find the shape it expects — a truncated source, an initializer this function does not
 * recognize — {@link skipInitializerKeyword} returns `null` and the caller stops collecting for
 * this declarator list and sets `exhaustive = false`, exactly like a destructuring target. It is
 * always acceptable for this scanner to say `exhaustive: false`; it is never acceptable for it to
 * omit a real export while claiming exhaustiveness — that invariant is the whole reason this type
 * exists, and both round-2 findings were breaches of it in opposite directions.
 *
 * SUPPORTED FORMS, each contributing zero or more names to `names`:
 * - `export const|let|var <name>[ = …][, <name>[ = …] …]` — every top-level declarator name in
 *   the list, `const`/`let`/`var` alike;
 * - `export function|function*|async function <name>(…) {…}`;
 * - `export class|abstract class <name> {…}`;
 * - `export interface <name> {…}` / `export type <name> = …` (type-only bindings — this scan
 *   makes no value/type distinction, mirroring the fact that a manifest entry names a binding,
 *   not a value specifically);
 * - `export { a, b as c, … }` (an export CLAUSE, local or re-exporting via a trailing
 *   `from "…"` — the exported-side identifier, i.e. after `as` when present, else the identifier
 *   itself);
 * - `export default …` — contributes NOTHING: a default export binds no NAMED export.
 *
 * Only a top-level `export` counts — depth tracking excludes `export` keywords nested inside a
 * function/class/block body, matching `import-scan.ts`'s own approach to "what counts as a module
 * edge" for the same structural reason.
 */
export interface NamedExportScanV1 {
  /** Every top-level NAMED export binding this scan is confident about. */
  readonly names: ReadonlySet<string>;
  /**
   * False when a form this scanner cannot read exhaustively was seen — a destructuring export
   * (`export const { a } = x`), an `export * from`, or a declarator initializer whose
   * `function`/`class`/`async` shape this scanner could not skip past (a truncated source, or an
   * initializer shape it does not recognize). A caller must then NOT report a missing name as a
   * fatal.
   */
  readonly exhaustive: boolean;
}

export function scanNamedExports(
  source: string,
  syntax: SourceSyntax,
): SourceStreamTruncatedError | NamedExportScanV1 {
  const toks = tokenize(source, syntax);
  if (toks instanceof Error) return toks;

  const names = new Set<string>();
  let exhaustive = true;
  let depth = 0;

  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (isOpener(t.kind)) {
      depth += 1;
      continue;
    }
    if (isCloser(t.kind)) {
      depth -= 1;
      continue;
    }
    if (t.kind !== SK.ExportKeyword || depth !== 0) continue;

    let j = i + 1;
    const next = toks[j];

    if (next?.kind === SK.DefaultKeyword) continue; // default export — no named binding

    if (next?.kind === SK.AsteriskToken) {
      exhaustive = false; // `export * from "…"` — cannot enumerate what it re-exports
      continue;
    }

    if (next?.kind === SK.OpenBraceToken) {
      j = readExportClause(toks, j + 1, names);
      continue;
    }

    // Skip a modifier run (`async`, `abstract`, `declare`) and a generator function's `*`.
    while (
      toks[j] !== undefined &&
      (MODIFIER_KEYWORDS.has(toks[j]!.kind) || toks[j]!.kind === SK.AsteriskToken)
    )
      j += 1;

    const decl = toks[j];
    if (decl === undefined || !DECLARATION_STARTS.has(decl.kind)) continue;

    // `export function*` — skip the generator `*` if it sits after the keyword instead of
    // before it (`export function* Button() {}` lexes `function` then `*` then the name).
    let nameIdx = j + 1;
    if (toks[nameIdx]?.kind === SK.AsteriskToken) nameIdx += 1;

    const isDeclaratorForm =
      decl.kind === SK.ConstKeyword || decl.kind === SK.LetKeyword || decl.kind === SK.VarKeyword;

    if (
      isDeclaratorForm &&
      (toks[nameIdx]?.kind === SK.OpenBraceToken || toks[nameIdx]?.kind === SK.OpenBracketToken)
    ) {
      exhaustive = false; // a destructuring declarator target — cannot enumerate its names
      continue;
    }

    const first = toks[nameIdx];
    if (first?.kind !== SK.Identifier) continue;
    names.add(first.value);

    if (!isDeclaratorForm) continue;

    // `const`/`let`/`var` may declare more than one binding: keep collecting names at this
    // declaration's own top level until the declarator list ends. A bare `function`/`class`/
    // `async` keyword — on ANY declarator, not only the first — is not itself an end: it is
    // skipped past (see `skipInitializerKeyword`) so the walk keeps reading past it exactly as
    // it already reads past a bracketed initializer.
    let k = nameIdx + 1;
    while (k < toks.length) {
      const kind = toks[k]!.kind;

      if (kind === SK.FunctionKeyword || kind === SK.ClassKeyword || kind === SK.AsyncKeyword) {
        const after = skipInitializerKeyword(toks, k);
        if (after === null) {
          exhaustive = false; // an initializer shape this scan does not recognize — fail open
          break;
        }
        k = after;
        continue;
      }

      if (endsDeclaratorList(kind)) break;

      if (isOpener(kind)) {
        const after = skipBalanced(toks, k);
        if (after === null) {
          exhaustive = false; // unbalanced brackets — the stream ran out before this closed
          break;
        }
        k = after;
        continue;
      }

      if (kind === SK.CommaToken) {
        const afterComma = toks[k + 1];
        if (afterComma?.kind === SK.OpenBraceToken || afterComma?.kind === SK.OpenBracketToken) {
          exhaustive = false; // a later destructuring declarator in the same list
          k += 1;
          continue;
        }
        if (afterComma?.kind === SK.Identifier) names.add(afterComma.value);
        k += 2;
        continue;
      }

      k += 1;
    }
  }

  return { names, exhaustive };
}

/** `{`/`(`/`[` — every opener the depth counter tracks. */
function isOpener(kind: SyntaxKind): boolean {
  return kind === SK.OpenBraceToken || kind === SK.OpenParenToken || kind === SK.OpenBracketToken;
}

/** `}`/`)`/`]` — every closer the depth counter tracks. */
function isCloser(kind: SyntaxKind): boolean {
  return (
    kind === SK.CloseBraceToken || kind === SK.CloseParenToken || kind === SK.CloseBracketToken
  );
}

/**
 * Skip one balanced `{…}`/`(…)`/`[…]` run starting at an opener, returning the index one past
 * its matching closer, or `null` when the stream ends before it closes. Used to step over a
 * destructuring pattern's own interior once it has already made the scan non-exhaustive (a brace
 * inside it must not be mistaken for the declarator list's own end), and by
 * {@link skipInitializerKeyword} to step over a function/class/async initializer's own brackets.
 *
 * `null` ON AN UNBALANCED RUN (fix round 2, task review Important finding), not the index the
 * stream happened to stop at. A caller that treated a stalled scan as "closed here" would silently
 * accept a truncated source as complete — exactly the kind of false exhaustiveness this whole
 * scanner exists to avoid. Every caller must fail open (`exhaustive = false`, stop collecting)
 * rather than guess where an unterminated bracket run was "meant" to end.
 */
function skipBalanced(toks: Tok[], openerIdx: number): number | null {
  let depth = 0;
  let k = openerIdx;
  for (; k < toks.length; k += 1) {
    if (isOpener(toks[k]!.kind)) depth += 1;
    else if (isCloser(toks[k]!.kind)) {
      depth -= 1;
      if (depth === 0) return k + 1;
    }
  }
  return null;
}

/**
 * Skip past a bare `function`/`class`/`async` keyword sitting in a declarator's INITIALIZER
 * position (`toks[k]` is one of the three), returning the index of the first token the ordinary
 * depth-0 declarator walk should resume from — typically an opening bracket that walk already
 * knows how to skip (a parameter list, a class body) — or `null` when the shape that follows does
 * not match any of the three forms below, or a bracket run inside it never closes. `null` means
 * "fail open, exactly like a destructuring target" to every caller; see this module's doc comment
 * on `exhaustive` for why silence is never the alternative.
 *
 * The THREE forms, none of which this function reads further than the point where the ordinary
 * walk can safely take back over:
 * - `function`/`async function`, optionally generator (`function*`) and optionally named
 *   (`function foo() {}`, the named-function-expression pattern) — skipped up to and including
 *   the parameter list's own `(`, which the caller's depth-0 walk then balances itself, and whose
 *   matching `)` is immediately followed by the body's `{`, which the SAME walk balances next;
 * - `class`, optionally named and optionally followed by an `extends <expr>` clause — walked
 *   token by token (balancing any brackets the `extends` expression itself contains, e.g. a call
 *   `extends someMixin(Base)`) up to the class body's own `{`, left for the caller's walk;
 * - `async` NOT followed by `function` — an async arrow. Its parameter list (a bare identifier or
 *   a balanced `(…)`) and the mandatory `=>` are consumed here; the arrow's result — a balanced
 *   `{…}` block or a bare expression — is left for the caller's walk, which already stops
 *   correctly at a depth-0 comma or semicolon either way.
 */
function skipInitializerKeyword(toks: Tok[], k: number): number | null {
  const kind = toks[k]!.kind;
  if (kind === SK.AsyncKeyword) {
    if (toks[k + 1]?.kind === SK.FunctionKeyword) return skipFunctionHead(toks, k + 1);
    return skipAsyncArrowHead(toks, k + 1);
  }
  if (kind === SK.FunctionKeyword) return skipFunctionHead(toks, k);
  if (kind === SK.ClassKeyword) return skipClassHead(toks, k);
  return null;
}

/** `toks[k]` is `function`: skip an optional `*`, an optional name, to the parameter list `(`. */
function skipFunctionHead(toks: Tok[], k: number): number | null {
  let j = k + 1;
  if (toks[j]?.kind === SK.AsteriskToken) j += 1; // generator
  if (toks[j]?.kind === SK.Identifier) j += 1; // optional name
  if (toks[j]?.kind !== SK.OpenParenToken) return null;
  return j;
}

/** `toks[k]` is `class`: skip an optional name and an optional `extends <expr>`, to the body `{`. */
function skipClassHead(toks: Tok[], k: number): number | null {
  let j = k + 1;
  if (toks[j]?.kind === SK.Identifier) j += 1; // optional name
  if (toks[j]?.kind === SK.ExtendsKeyword) {
    j += 1;
    while (j < toks.length && toks[j]!.kind !== SK.OpenBraceToken) {
      if (isOpener(toks[j]!.kind)) {
        const after = skipBalanced(toks, j);
        if (after === null) return null;
        j = after;
        continue;
      }
      if (isCloser(toks[j]!.kind)) return null; // an unmatched closer — not a shape we recognize
      j += 1;
    }
  }
  if (toks[j]?.kind !== SK.OpenBraceToken) return null;
  return j;
}

/**
 * `toks[j]` is the token right after a bare `async` that is NOT followed by `function`: skip the
 * arrow's own parameter (a bare identifier, or a balanced `(…)` list) and its mandatory `=>`.
 */
function skipAsyncArrowHead(toks: Tok[], startJ: number): number | null {
  let j = startJ;
  if (toks[j]?.kind === SK.Identifier) {
    j += 1;
  } else if (toks[j]?.kind === SK.OpenParenToken) {
    const after = skipBalanced(toks, j);
    if (after === null) return null;
    j = after;
  } else {
    return null; // neither a bare param nor a parenthesised list — not a shape we recognize
  }
  if (toks[j]?.kind !== SK.EqualsGreaterThanToken) return null;
  return j + 1;
}

/**
 * Read an `export { … }` clause starting right after its `{`, adding each exported-side name to
 * `names`. Handles a trailing `from "…"` (a named re-export, itself a `REEXPORT` violation the
 * import allowlist already rejects — this scan simply reports the names it sees). Returns the
 * index of the token right after the clause (its `}`, or the specifier's closing token when a
 * `from` clause follows).
 */
function readExportClause(toks: Tok[], from: number, names: Set<string>): number {
  let k = from;
  while (k < toks.length && toks[k]!.kind !== SK.CloseBraceToken) {
    const t = toks[k]!;
    if (t.kind === SK.Identifier) {
      if (toks[k + 1]?.kind === SK.AsKeyword && toks[k + 2]?.kind === SK.Identifier) {
        names.add(toks[k + 2]!.value);
        k += 3;
        continue;
      }
      names.add(t.value);
      k += 1;
      continue;
    }
    k += 1;
  }
  // `k` now sits on the `}` (or at end of stream if unbalanced — tolerated, not a fatal here).
  if (k >= toks.length) return k;
  k += 1; // past `}`
  if (toks[k]?.kind === SK.FromKeyword) {
    k += 1;
    if (toks[k]?.kind === SK.StringLiteral) k += 1;
  }
  return k;
}
