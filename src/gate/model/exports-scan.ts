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
 * MUST NOT report a missing name as a fatal. `exhaustive` goes `false` on exactly two triggers:
 * a destructuring export target (`export const { … } = …` / `export const [ … ] = …`, in either
 * a `const`, `let` or `var` declaration), and a star re-export (`export * from "…"`). The import
 * allowlist, which IS a perimeter, is untouched by this file — a `REEXPORT`/`DYNAMIC_IMPORT`
 * violation this scan happens to see through is still `scanImportAllowlist`'s call to make.
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
 *
 * KNOWN LIMITATION, inherited directly from the brief's stated stopping rule for a multi-name
 * declarator list: a `const`/`let`/`var` list stops collecting names at ANY token whose kind is a
 * `DECLARATION_STARTS` member, `ExportKeyword` or `ImportKeyword` — wherever it sits, not only at
 * the list's own top level. `export const a = function () {}, b = 2` therefore stops at the
 * inline function expression's own `function` keyword and never collects `b`, silently
 * under-reporting rather than setting `exhaustive: false`. Not pinned by a test here because the
 * brief's own algorithm calls for this exact stopping condition and no test exercises the shape;
 * recorded so a future reader does not mistake the gap for an oversight.
 */
export interface NamedExportScanV1 {
  /** Every top-level NAMED export binding this scan is confident about. */
  readonly names: ReadonlySet<string>;
  /**
   * False when a form this scanner cannot read exhaustively was seen — a destructuring export
   * (`export const { a } = x`), or `export * from`. A caller must then NOT report a missing
   * name as a fatal.
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
    // declaration's own top level until the declarator list ends.
    let k = nameIdx + 1;
    while (k < toks.length && !endsDeclaratorList(toks[k]!.kind)) {
      if (isOpener(toks[k]!.kind)) {
        k = skipBalanced(toks, k);
        continue;
      }
      if (toks[k]!.kind === SK.CommaToken) {
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
 * its matching closer (or `toks.length` if the stream ends first). Used only to step over a
 * destructuring pattern's own interior once it has already made the scan non-exhaustive, so a
 * brace inside it cannot be mistaken for the declarator list's own end.
 */
function skipBalanced(toks: Tok[], openerIdx: number): number {
  let depth = 0;
  let k = openerIdx;
  for (; k < toks.length; k += 1) {
    if (isOpener(toks[k]!.kind)) depth += 1;
    else if (isCloser(toks[k]!.kind)) {
      depth -= 1;
      if (depth === 0) return k + 1;
    }
  }
  return k;
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
