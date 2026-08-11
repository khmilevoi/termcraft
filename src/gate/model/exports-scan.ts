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

/**
 * `DECLARATION_STARTS` plus `export`/`import` — every keyword that can OPEN a new top-level
 * statement, and therefore the full set the declarator-list walk must run
 * {@link isStatementPosition} against before treating one as ending the current list (fix round
 * 4, task review Critical finding B). Every one of these is ALSO a legal token in the MIDDLE of
 * an expression — a property name after `.` (`props.type`), the right side of `as`
 * (`x as const`), the callee of a dynamic import (`import("x")`) — so which meaning applies can
 * only be decided by where the token sits, never by its kind alone.
 */
const STATEMENT_START_KEYWORDS: ReadonlySet<SyntaxKind> = new Set([
  ...DECLARATION_STARTS,
  SK.ExportKeyword,
  SK.ImportKeyword,
]);

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
 * A scanner that FALSE-FATALED on a shape it merely could not read exhaustively would reject a
 * legal design-system component for a shape this scan cannot enumerate, not for anything the
 * author did wrong. Failing OPEN on that shape, loudly modelled in the return type as
 * `exhaustive: false`, beats a false fatal: a caller checks `exhaustive` and, when it is `false`,
 * MUST NOT report a missing name as a fatal.
 *
 * THE GOVERNING INVARIANT (unchanged since task 3, restated after three rounds each closed one
 * hole and opened another): it is ALWAYS fine to report `exhaustive: false`. It is NEVER fine,
 * while reporting `exhaustive: true`, to omit a real export or to invent a name that is not one.
 *
 * THE DESIGN (fix round 4, task review Critical findings A and B — a full rewrite of the
 * declarator-list walk, not another special case bolted onto rounds 1–3's). Rounds 1–3 each
 * decided "does this token end the declarator list?" by PATTERN-MATCHING its kind — `function`,
 * `class`, `async`, a bracket, a comma — so every shape nobody had pattern-matched yet was a
 * silent wrong answer: `<`/`>` are not in the walk's bracket alphabet, so a comma between generic
 * type arguments (`new Map<string, T>()`) sat at the walk's top level and got read as a
 * declarator separator, INVENTING a phantom export from the type argument that followed it
 * (Critical A); and `endsDeclaratorList` matched `DECLARATION_STARTS` members with no check on
 * WHERE they sat, so a contextual keyword used mid-expression (`props.type`, `x as const`,
 * `import("x")`, `await import("x")`) was mistaken for the start of a new statement, silently
 * DROPPING every declarator after it (Critical B).
 *
 * The fix inverts the decision: a token only ends the list, or opens a sub-scan, when the walk
 * can PROVE its role from its own kind or its PROVEN position — never from a kind-only guess.
 * At the walk's own top level (brackets consumed whole by {@link skipBalanced}, template
 * literals whole by {@link skipTemplateLiteral} — both already opaque units, not read into):
 *
 * - `;` or end of stream ends the list normally, `exhaustive` unchanged;
 * - `,` opens the NEXT declarator: the token immediately after it is required to be an
 *   `Identifier` (the only legal shape per the grammar, since a declarator name is either an
 *   identifier or a binding pattern) — collected as a name — or the list goes `exhaustive: false`
 *   (a destructuring pattern, or a shape this scan does not expect there);
 * - `<` is UNREADABLE: a token walk cannot tell a generic argument list from the less-than
 *   operator (`a < b, c > d` is a valid comparison, so angle brackets cannot be balanced by
 *   counting) — but WHETHER that unreadability could have hidden a declarator IS decidable (fix
 *   round 5, task review Critical finding): {@link scanPastAngleBracket} reads ahead to the
 *   statement's own boundary and only sets `exhaustive: false` if a depth-0 comma — the one thing
 *   a `<` could actually have hidden a separator behind — turned up before it. Failing the WHOLE
 *   FILE open on every `<` (round 4's answer) made `exhaustive: false` the default outcome for a
 *   `.tsx` component's dominant idiom, `export const Button = () => <box .../>`, whose JSX markup
 *   tokenizes as a bare `<` plus ordinary tokens (no distinct JSX token kind exists — see
 *   {@link scanPastAngleBracket}'s doc comment) — silencing the missing-binding fatal on exactly
 *   the modules it exists to police;
 * - a member of {@link STATEMENT_START_KEYWORDS} (`DECLARATION_STARTS`, `export`, `import`) ends
 *   the list ONLY when {@link isStatementPosition} proves it sits where a new statement may
 *   legally begin — otherwise it is consumed as ONE token, exactly like any other piece of the
 *   current initializer expression, and the walk reads straight through it. This alone closes
 *   Critical B: `props.type`, `x as const`, `import("x")` and `await import("x")` all consume the
 *   contextual keyword and continue, because none of them sit at statement position;
 * - a bare `function`/`class`/`async` initializer (`export const a = function () {}, b = 2`) is
 *   just an instance of the rule above — `function`/`class`/`async` ARE `DECLARATION_STARTS`
 *   members, and right after `=` they are never at statement position, so the same one-token
 *   consumption applies, and the parameter list / body / arrow result that follows is read by
 *   this SAME walk's ordinary bracket handling. No separate "skip this initializer's head"
 *   machinery is needed — the position check already tells the walk not to stop there, and the
 *   generic opener handling already knows how to read through what comes next;
 * - an unmatched closer (`}`/`)`/`]` reached directly, not via {@link skipBalanced}) or an
 *   orphaned `TemplateMiddle`/`TemplateTail` (reached without the matching `TemplateHead` this
 *   walk went through {@link skipTemplateLiteral} for) is a shape the walk cannot prove anything
 *   about — `exhaustive: false`, stop, never a guess;
 * - anything else — a literal, an operator, a property name, `as`, … — is ordinary expression
 *   content: neither a separator nor a boundary. It can never invent a name (only the `,` branch
 *   above ever adds one) and it can never hide a real statement boundary (fully covered by the
 *   branches above), so reading past it one token at a time is safe.
 *
 * `exhaustive` therefore goes `false` on exactly these triggers: a destructuring declarator
 * target (`export const { … } = …` / `export const [ … ] = …`, first declarator or a later one);
 * a star re-export (`export * from "…"`); a `<` at the walk's own top level whose statement, read
 * ahead to its own boundary, turns out to contain a depth-0 comma (or an unbalanced/unterminated
 * bracket or template along the way — see {@link scanPastAngleBracket}); an unmatched/truncated
 * bracket run, template literal, or closer; or a declaration/declarator whose OWN binding name is
 * a contextual keyword (`export const type = 1`) rather than a plain Identifier — this scan can
 * prove such a name exists but, per `Tok`'s own shape, cannot read what it is (see the
 * `first?.kind !== SK.Identifier` branch below).
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
   * False when a form this scanner cannot read exhaustively was seen: a destructuring export
   * target (`export const { a } = x` / `export const [a] = x`), an `export * from`, a `<` at a
   * declarator's own top level whose statement provably contains a depth-0 comma after it (see
   * {@link scanNamedExports}'s doc comment and {@link scanPastAngleBracket} — a `<` with NO comma
   * after it, e.g. JSX markup, leaves `exhaustive` unchanged), an unmatched/truncated bracket run,
   * template literal, or closer, or a binding name this scan proved exists but could not read (a
   * contextual keyword, e.g. `export const type = 1`). A caller must then NOT report a missing
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
    if (first?.kind !== SK.Identifier) {
      // The declaration's own binding name failed to read as a plain Identifier — most likely a
      // TypeScript contextual keyword (`type`, `async`, `abstract`, `namespace`, `module`, …)
      // legally used AS a name (`export const type = 1` is valid TypeScript), whose actual
      // spelling this scan cannot recover: `Tok.value` is populated only for literal/Identifier
      // kinds (see `./scanner.ts`'s `Tok` and `./lexer.ts`'s token-push site), so a keyword-kind
      // token here carries no readable text to add to `names`. Silently moving on — every prior
      // round's behavior, inherited from the original brief's own algorithm — would leave a real
      // export invisible while `exhaustive` stayed whatever it already was, an unadvertised
      // Critical-B-shaped hole found in this round's own adversarial pass (see the task-3 report,
      // round 4). Fail open instead: `exhaustive` MUST go `false` whenever a name might exist that
      // this scan could not read, never stay silently `true`.
      exhaustive = false;
      continue;
    }
    names.add(first.value);

    if (!isDeclaratorForm) continue;

    // `const`/`let`/`var` may declare more than one binding: keep collecting names at this
    // declaration's own top level until the list ends. See this module's doc comment for the
    // full rule set; in short, every branch below either PROVES it may stop (`;`, end of stream,
    // an unreadable `<`, a statement-start keyword actually AT statement position) or PROVES it
    // may safely read past the current token without collecting a name (a balanced bracket run,
    // a whole template literal, a statement-start keyword NOT at statement position, or ordinary
    // expression content) — nothing here is a guess.
    let k = nameIdx + 1;
    while (k < toks.length) {
      const kind = toks[k]!.kind;

      if (kind === SK.SemicolonToken) break; // the list ends normally

      if (kind === SK.TemplateHead) {
        const after = skipTemplateLiteral(toks, k);
        if (after === null) {
          exhaustive = false; // the template never closes — the stream ran out before it did
          break;
        }
        k = after;
        continue;
      }

      if (isOpener(kind)) {
        const after = skipBalanced(toks, k);
        if (after === null) {
          exhaustive = false; // unbalanced brackets — the stream ran out before this closed
          break;
        }
        k = after;
        continue;
      }

      if (isCloser(kind) || kind === SK.TemplateMiddle || kind === SK.TemplateTail) {
        // An unmatched closer, or a template continuation this walk never entered through a
        // `TemplateHead` of its own — a shape the walk cannot prove anything about. Fail open
        // rather than guess what it means.
        exhaustive = false;
        break;
      }

      if (kind === SK.LessThanToken) {
        // Generic type arguments and the less-than operator are not distinguishable by a token
        // walk (`a < b, c > d` is a valid comparison expression, so angle brackets cannot be
        // balanced by counting) — see {@link scanPastAngleBracket}'s doc comment. Rather than
        // failing the WHOLE FILE open the instant any `<` is seen (round 4's answer, which made
        // `exhaustive: false` the default outcome for the dominant JSX-arrow component idiom —
        // fix round 5, task review Critical finding), scan ahead to the current statement's own
        // boundary and only fail open if a depth-0 comma — the one thing a `<` could actually
        // have hidden a declarator behind — turned up before it.
        const scan = scanPastAngleBracket(toks, k, source);
        if (scan.hadComma) exhaustive = false;
        k = scan.boundary;
        continue;
      }

      if (kind === SK.CommaToken) {
        // The grammar allows nothing but an Identifier or a BindingPattern right after a
        // declarator-list comma. An Identifier is collected; anything else — a destructuring
        // pattern this scan cannot enumerate, or a shape that should not be there at all — fails
        // open rather than guessing which.
        const afterComma = toks[k + 1];
        if (afterComma?.kind === SK.Identifier) {
          names.add(afterComma.value);
          k += 2;
          continue;
        }
        exhaustive = false;
        break;
      }

      if (STATEMENT_START_KEYWORDS.has(kind)) {
        if (isStatementPosition(toks, k, source)) break; // a NEW statement begins here — stop
        // Every member of this set — `const`, `let`, `type`, `function`, `class`, `async`,
        // `import`, `export`, … — is ALSO a legal token in the middle of an expression: a
        // property name after `.` (`props.type`), the right side of `as` (`x as const`), the
        // callee of a dynamic import (`import("x")`), or the start of a bare function/class/
        // async initializer right after `=`. None of those are statement position, so this token
        // is consumed like any other piece of the current initializer and the walk reads on —
        // the fix for Critical B.
        k += 1;
        continue;
      }

      // Ordinary expression content — a literal, an operator, a property name, `as`, … — that is
      // neither a separator nor a boundary. It cannot invent a name (only the CommaToken branch
      // above ever adds one) and it cannot hide a real statement boundary (fully covered by the
      // branches above), so reading past it one token at a time is safe.
      k += 1;
    }
  }

  return { names, exhaustive };
}

/**
 * Whether `toks[idx]` sits where a new STATEMENT may legally begin, as opposed to inside the
 * expression the declarator walk is already reading (fix round 4, task review Critical finding
 * B). JavaScript/TypeScript settle exactly this question with Automatic Semicolon Insertion: a
 * new statement is legal to start where the previous one is known to have ended.
 *
 * - the FIRST token of the whole stream is always statement position;
 * - the previous token being `;` ends any statement unconditionally;
 * - the previous token being `}` is also treated as ending one. This is deliberately NOT
 *   narrowed to "only a block's `}`, never an object literal's or a type literal's" — telling
 *   those apart needs a parser, which is exactly the guessing this rewrite exists to stop doing.
 *   It is safe anyway: a `}` this walk sees directly (not swallowed whole by
 *   {@link skipBalanced}/{@link skipTemplateLiteral}) is the token right after a bracket run the
 *   SAME walk just finished reading — i.e. exactly "an initializer's own block just closed" — and
 *   for a `const`/`let`/`var` declaration, which the grammar always terminates with a real `;` or
 *   ASI (unlike a `function`/`class` DECLARATION, which needs no terminator at all), a `}`
 *   immediately followed — same source line, no real line break — by a new statement-starting
 *   keyword can only happen in source that was already invalid before this scanner saw it, so
 *   treating it as a boundary here costs nothing on any source `tsc`/Bun would accept;
 * - otherwise (ASI): is there a line break in the source between where the PREVIOUS token began
 *   and where this one begins? `Tok` carries only a start offset (`pos`), never an end — see
 *   `./scanner.ts`'s `Tok` — so there is no exact end-of-previous-token offset to measure from,
 *   and the previous token's OWN span is folded into the scanned range too. That is provably safe
 *   here: the only token kinds whose own text can contain a raw newline are a template literal or
 *   a line-continued string, and in EITHER case a value token immediately (same line, no
 *   operator) followed by a bare statement-starting keyword is not parseable JavaScript at all —
 *   valid source always puts an operator, a `.`, or a real line break between them — so the one
 *   shape this approximation could get wrong is already invalid input, and this scanner is free
 *   to fail open on it exactly as it does on any other shape it cannot read.
 */
function isStatementPosition(toks: readonly Tok[], idx: number, source: string): boolean {
  if (idx === 0) return true;
  const prev = toks[idx - 1]!;
  if (prev.kind === SK.SemicolonToken || prev.kind === SK.CloseBraceToken) return true;
  return /\n/.test(source.slice(prev.pos, toks[idx]!.pos));
}

/**
 * Scans forward from a `<` reached at the declarator walk's own top level to find where the
 * CURRENT statement actually ends, and whether a depth-0 comma appeared anywhere between the `<`
 * and that boundary (fix round 5, task review Critical finding).
 *
 * WHY THIS EXISTS. Round 4's `<` rule set `exhaustive = false` for the WHOLE FILE the instant a
 * `<` was seen, on the sound reasoning that a comma between generic type arguments cannot be told
 * apart from a declarator separator (`a < b, c > d` is a valid comparison, so `<`/`>` cannot be
 * balanced by counting). That reasoning is correct, but its BLAST RADIUS was wrong: a design-
 * system component module is a `.tsx` file whose dominant idiom is
 * `export const Button = () => <box .../>`, and `<box .../>` is JSX markup — confirmed by
 * tokenizing it: the scanner emits no distinct JSX token kind at all (`./scanner.ts`'s
 * `scanCodeToken` never produces one), so a JSX element surfaces as a bare `LessThanToken`
 * followed by ordinary `Identifier`/`StringLiteral`/`GreaterThanToken`/`SlashToken` tokens, no
 * different from `Map<string, T>`'s. Round 4 could not tell these apart and failed BOTH open for
 * the whole file — silencing `DESIGN_SYSTEM_COMPONENT_EXPORT_MISSING` on exactly the modules it
 * exists to police, the same "present, tested, green, and inert on real input" failure mode this
 * codebase already designs against elsewhere.
 *
 * THE NARROWER QUESTION THIS FUNCTION ANSWERS. Whether a `<` opens a real generic argument list is
 * undecidable by a token walk — that has not changed. But whether that undecidability could have
 * hidden anything IS decidable: nothing after a `<` can defeat this scan unless a depth-0 comma
 * sits somewhere between it and the statement's own end, because that comma is the ONLY token
 * shape that could have been a missed declarator separator. `<box id="b" />` has no comma at all;
 * `<box a={1} b={2} />`'s only commas (if any) would sit inside a JSX attribute expression's own
 * brackets, not bare; `Map<string, T>` always does, right there at depth 0. So: scan to the
 * boundary, watch for a depth-0 comma along the way (bracket runs skipped whole via
 * {@link skipBalanced}, template literals whole via {@link skipTemplateLiteral} — exactly like the
 * main walk, so `xs.map((i, k) => i)`'s own comma, sitting inside real parentheses, never counts),
 * and only fail open when one turns up.
 *
 * `boundary` is deliberately the SAME index {@link isStatementPosition} (or a depth-0 `;`, or
 * end of stream) would independently produce — this function does not itself decide "the list
 * ends here"; it only locates where the caller's OWN ordinary per-kind dispatch will make that
 * decision, so `exhaustive = false` vs. unchanged is the only new judgment call, not a second copy
 * of the boundary logic. An unmatched closer, an orphaned template continuation, or an unbalanced/
 * unterminated bracket run or template encountered along the way is a shape this function cannot
 * prove anything about either — treated exactly like finding a comma (fail open), since a
 * truncated source could just as easily have hidden a declarator as an unread comma could.
 */
function scanPastAngleBracket(
  toks: readonly Tok[],
  ltIdx: number,
  source: string,
): { boundary: number; hadComma: boolean } {
  let k = ltIdx + 1;
  let hadComma = false;
  while (k < toks.length) {
    const kind = toks[k]!.kind;

    if (kind === SK.SemicolonToken) return { boundary: k, hadComma };

    if (STATEMENT_START_KEYWORDS.has(kind) && isStatementPosition(toks, k, source)) {
      return { boundary: k, hadComma };
    }

    if (kind === SK.TemplateHead) {
      const after = skipTemplateLiteral(toks, k);
      if (after === null) return { boundary: toks.length, hadComma: true };
      k = after;
      continue;
    }

    if (isOpener(kind)) {
      const after = skipBalanced(toks, k);
      if (after === null) return { boundary: toks.length, hadComma: true };
      k = after;
      continue;
    }

    if (isCloser(kind) || kind === SK.TemplateMiddle || kind === SK.TemplateTail) {
      return { boundary: k, hadComma: true };
    }

    if (kind === SK.CommaToken) hadComma = true;
    k += 1;
  }
  return { boundary: toks.length, hadComma };
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
 * inside it must not be mistaken for the declarator list's own end), and, since fix round 4, as
 * the ONLY mechanism that reads through a bracketed initializer of any shape — a function's
 * parameter list and body, a class's body, an arrow's parameter list and block result, an object
 * or array literal, a parenthesised expression — none of which need their own dedicated skip
 * logic once the declarator walk stops mistaking their head keyword for a list terminator (see
 * this module's doc comment).
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
 * Skip one whole template literal starting at its `TemplateHead`, returning the index one past
 * the matching `TemplateTail`, or `null` when the stream ends before one is found (fix round 3,
 * task review Critical finding).
 *
 * WHY THIS EXISTS AT ALL: the lexer never emits `OpenBraceToken`/`CloseBraceToken` for a
 * template's own `${ … }` — `./scanner.ts`'s `scanCodeToken` produces `TemplateHead`, then the
 * interpolation's own tokens (which may include perfectly ordinary `OpenBraceToken`s and
 * commas), then `TemplateMiddle` (if another `${` follows) or `TemplateTail` (once the literal
 * closes). `isOpener`/`isCloser` are therefore structurally blind to an interpolation's own
 * boundary, so without this function the declarator walk would read STRAIGHT INTO a template's
 * interior as if it were ordinary top-level declarator syntax.
 *
 * COUNTING, NOT BALANCING BRACKETS. `TemplateHead` increments a depth counter, `TemplateTail`
 * decrements it, and the function returns the moment depth reaches `0` — the same shape as
 * `skipBalanced`, but over template nesting rather than bracket nesting (a template can nest
 * inside its own interpolation, e.g. `` `${`${a}`}` ``). `TemplateMiddle` changes nothing: it
 * continues the SAME template whose `TemplateHead` already opened the current depth level. Any
 * REAL bracket run inside the interpolation (`` `${ {a: 1} }` ``, `` `${fn(a, b)}` ``) is not
 * inspected here at all — it does not need to be, because the underlying tokenizer already
 * resolves the one genuine ambiguity (whether a `}` closes a real brace or resumes the template)
 * via its own brace-context stack (`./scanner.ts`'s `scanCodeToken`), so a real `{`/`}` pair
 * inside an interpolation is always tokenized as `OpenBraceToken`/`CloseBraceToken`, never
 * mistaken for the template's own boundary, and a `}` INSIDE A STRING (`` `${ "}" }` ``) is part
 * of that string's own `StringLiteral` token and never a bare token at all. This function simply
 * never looks at what is between a `TemplateHead` and its `TemplateTail` — the whole span,
 * including any comma, `import`, or identifier in it, is opaque initializer content that
 * contributes no declarator name and ends no declarator list.
 *
 * `null` ON AN UNTERMINATED TEMPLATE, exactly like {@link skipBalanced} on an unbalanced bracket
 * run: running off the end of the token stream without depth returning to `0` means a
 * `TemplateHead` was found with no matching `TemplateTail` anywhere after it (the interpolation's
 * own expression ran to end-of-file without ever closing back into template mode). The caller
 * fails open — `exhaustive = false`, stop collecting — rather than guess where it was "meant" to
 * end.
 */
function skipTemplateLiteral(toks: Tok[], headIdx: number): number | null {
  let depth = 0;
  let j = headIdx;
  for (; j < toks.length; j += 1) {
    const kind = toks[j]!.kind;
    if (kind === SK.TemplateHead) depth += 1;
    else if (kind === SK.TemplateTail) {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return null;
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
