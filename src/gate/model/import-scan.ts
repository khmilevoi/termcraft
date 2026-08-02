import { resolveDesignSpecifier } from "entities/design-tree";

import { SK, lineColOf, tokenize } from "./lexer";
import type { SourceStreamTruncatedError, SourceSyntax, SyntaxKind, Tok } from "./lexer";

/**
 * A fatal import-allowlist violation the gate rejects the candidate for (§3.1),
 * plus the two dynamic-code forms banned by the same design-code-rules bullet
 * (design §5.8: "`eval` and `new Function` are also forbidden"). `specifier` is
 * empty for the dynamic-code codes — they name no module edge.
 *
 * `UNRESOLVED_IMPORT` (design §6, Task 11) is a static import whose specifier has a LEGAL
 * shape — the bare runtime root, or a relative specifier — but that {@link resolveDesignSpecifier}
 * could not resolve inside the tree (a typo, a missing file, a path that escapes `design/`, a
 * query string, a backslash, or a symlink the resolver's own `has` refuses). It is reported
 * under a code distinct from `FORBIDDEN_IMPORT` deliberately: telling an author "you may only
 * import @termcraft/runtime" when they wrote a legal relative import with a typo would be a
 * false diagnosis (see this file's `scanImportAllowlist` doc comment for the full rationale).
 *
 * `UNSCANNED_IMPORT` (task-12b fix round 1) is the third outcome, and it exists because the other
 * two were both false about it. The specifier RESOLVED, to a real file that IS in the tree — but
 * this pass was never given that file's source, so nothing here has checked it for a further
 * forbidden import, `eval` or `new Function`. Reporting it as `UNRESOLVED_IMPORT` (what
 * `scanTreeImports` used to force by answering `false` from its own `has`) made the resolver emit
 * `no file at "lib/foo"` about a file the author can see sitting in the tree — unactionable, and
 * simply untrue; reporting it as `FORBIDDEN_IMPORT` would claim the author broke a rule they did
 * not. See {@link scanImportAllowlist}'s `isScanned` parameter.
 *
 * `UNSCANNABLE_SOURCE` (task-12b fix round 1) is not a violation the author committed — it is
 * this scan admitting it could not read the file at all, so nothing about it may be trusted.
 * `scanTreeImports` raises it, not this function; see its own doc for the one measured cause
 * (stack exhaustion on absurdly deep JSX nesting) and for why a fatal is the only honest outcome.
 */
export interface ImportScanError {
  readonly code:
    | "FORBIDDEN_IMPORT"
    | "UNRESOLVED_IMPORT"
    | "UNSCANNED_IMPORT"
    | "UNSCANNABLE_SOURCE"
    | "DYNAMIC_IMPORT"
    | "REEXPORT"
    | "REQUIRE_CALL"
    | "EVAL_CALL"
    | "FUNCTION_CALL";
  readonly specifier: string;
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

/** The keywords that begin a LOCAL declaration export (never a re-export). */
const DECLARATION_STARTS = new Set<SyntaxKind>([
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
  SK.DefaultKeyword,
]);

/** Tokens that end the search for an import specifier / an export `from` clause. */
function isEdgeBoundary(kind: SyntaxKind): boolean {
  return kind === SK.SemicolonToken || kind === SK.ImportKeyword || kind === SK.ExportKeyword;
}

/** The first StringLiteral value at or after `from`, or null if none before an edge boundary. */
function firstStringFrom(toks: Tok[], from: number): { value: string; pos: number } | null {
  for (let j = from; j < toks.length; j += 1) {
    const t = toks[j]!;
    if (t.kind === SK.StringLiteral) return { value: t.value, pos: t.pos };
    if (isEdgeBoundary(t.kind)) return null;
  }
  return null;
}

/**
 * The specifier of the STATIC import statement beginning at `toks[importIndex]`, or `null`
 * when that statement carries none. Takes the token array rather than the source so both
 * callers tokenize exactly once and keep their own single pass: {@link scanImportAllowlist}
 * judges each specifier in source order alongside its other checks, {@link scanModuleEdges}
 * turns the same specifiers into closure edges. One implementation, so the two can never
 * disagree about what a file imports — a closure built from a different reading than the
 * allowlist's is exactly the shape that lets an unscanned module load.
 *
 * The caller has already established that `toks[importIndex]` is an `ImportKeyword` and that
 * it is neither `import.meta` nor a dynamic `import(`. An `import x = require(...)` returns
 * `null` here and is left to the require handler.
 */
export function readStaticImportSpecifier(toks: Tok[], importIndex: number): string | null {
  for (let j = importIndex + 1; j < toks.length; j += 1) {
    const tj = toks[j]!;
    if (tj.kind === SK.RequireKeyword) return null;
    if (tj.kind === SK.StringLiteral) return tj.value;
    if (isEdgeBoundary(tj.kind)) return null;
  }
  return null;
}

/** A `.`/`?.` immediately before an identifier — the member-access shape. */
function isMemberAccess(previous: Tok | undefined): boolean {
  return previous?.kind === SK.DotToken || previous?.kind === SK.QuestionDotToken;
}

/**
 * The identifiers that name the GLOBAL object, so `<receiver>.eval(...)` is the global `eval`
 * rather than a method on some unrelated object — plus `)`, which is what a parenthesised or
 * cast receiver leaves behind (`(globalThis as any).eval("x")`).
 *
 * ADDED in task 14b fix round 1 (Important 4). The `eval` check excluded EVERY `.`-prefixed
 * occurrence, so `globalThis.eval("55")` — the most obvious spelling of indirect eval — was never
 * caught. Measured: `Bun.Transpiler` accepts it and `await import()` executes it while the whole
 * perimeter reported nothing. It needs no alias tracking and no constant folding, so it was
 * inside this layer's reach all along and the escalation that called the whole family unclosable
 * was wider than what had been proved.
 *
 * The `)` arm is an accepted OVER-approximation, in the same spirit as flagging
 * `{ eval() { return 1 } }`: `someCall().eval(x)` — a method genuinely named `eval` on an
 * unrelated object — is flagged too. A page defining such a method is unusual enough that the
 * catch is worth more than the exemption.
 */
function isGlobalReceiver(receiver: Tok | undefined): boolean {
  if (receiver === undefined) return false;
  if (receiver.kind === SK.CloseParenToken) return true;
  // `global` is NOT an identifier to the TypeScript scanner — it answers `GlobalKeyword`, the
  // one it uses for `declare global {}`. Measured, not assumed: without this arm
  // `global.eval("1")` was the single spelling of the four that slipped through, found by the
  // test that sweeps all four rather than by inspection.
  if (receiver.kind === SK.GlobalKeyword) return true;
  if (receiver.kind !== SK.Identifier) return false;
  return GLOBAL_OBJECT_NAMES.has(receiver.value);
}

/** The names a page can reach the global object through, in every runtime this host may use. */
const GLOBAL_OBJECT_NAMES = new Set(["globalThis", "window", "self", "global"]);

/**
 * True when `toks[index]` is a bare reference wrapped in parentheses that are then CALLED —
 * `(Function)("x")`, `(0, Function)("x")`, `new (Function)("x")`.
 *
 * ADDED in task 14b fix round 1 (Important 4). The `Function` check fired only when the very NEXT
 * token was `(`, so one pair of parentheses walked straight past it. All three spellings were
 * measured: `Bun.Transpiler` accepts them, `await import()` executes them, the perimeter reported
 * nothing. Recognising them needs no binder — the closing `)` is the token right after the
 * reference, and the call `(` is the token right after that.
 *
 * Deliberately NOT a general expression matcher: it looks exactly one `)` ahead and requires the
 * call parenthesis immediately behind it, which is the whole of the measured shape. A reference
 * wrapped twice (`((Function))("x")`) is not caught and is pinned as a KNOWN GAP, because
 * following an arbitrary parenthesis nest is the constant-folding job this scan does not do.
 */
function isParenthesisedValue(toks: Tok[], index: number): boolean {
  return (
    toks[index + 1]?.kind === SK.CloseParenToken && toks[index + 2]?.kind === SK.OpenParenToken
  );
}

/**
 * The AUTHORITATIVE static-import allowlist scan (design §6; runtime-api §3.1). Tokenizes the
 * page source with the TypeScript lexer and classifies EVERY module edge the author
 * wrote — value + type-only imports, side-effect imports, `export … from`
 * re-exports, `import(...)` dynamic imports, and CJS `require(...)` — plus, per the
 * same design §5.8 rule, dynamic-code forms centered on the `eval`/`Function`
 * globals, fatal violations rather than module edges. Exactly two edges are legal
 * anywhere in the tree (design §6): a static `import … from "@termcraft/runtime"`
 * (bare root, no subpath), and a RELATIVE specifier (`./…`, `../…`) that resolves to a
 * real file inside `design/`, per the `context` parameter below. A dynamic
 * import, a re-export, or a require is rejected even when it names the runtime,
 * because one page is one independently-renderable file with no runtime-selected
 * loading. Because this scans the SOURCE tokens (not the transform output), the
 * compiler-injected JSX-helper edges never appear — no exemption is needed, and an
 * author-written `require("react")` (a real source token) is caught, unlike the
 * host's `Bun.Transpiler.scanImports` (2C residual gap).
 *
 * `context` is what makes relative resolution possible: `from` is the importer's tree-relative
 * path, `has` answers whether a tree-relative path names a real file. Resolution itself is
 * entirely {@link resolveDesignSpecifier}'s job (`entities/design-tree`, Task 2) — this scan
 * re-implements NONE of its rules (path normalization, the `.tsx`/`.ts` extension probe, the
 * `ESCAPES_TREE`/`QUERY_OR_FRAGMENT`/`BACKSLASH`/`BARE_SPECIFIER` shape checks), it only maps
 * the resolver's own outcome onto an `ImportScanError`. A specifier the resolver could not
 * resolve (`resolved.code === "UNRESOLVED"`) is reported as `UNRESOLVED_IMPORT`, distinct from
 * every other rejection's `FORBIDDEN_IMPORT`: the first is usually a typo or a missing file,
 * the second is a rule violation, and telling an author "you may only import
 * `@termcraft/runtime`" when they wrote a legal relative import with a typo would be a false
 * diagnosis.
 *
 * `context` is REQUIRED (Task 12: `gate/model/gate.ts`'s `runGate` no longer calls this function
 * at all — the whole-tree scan moved to `runTreeImports`/`scanTreeImports`, which always
 * threads a real, closure-backed `{ from, has, isScanned }` — so there is no production caller
 * left with nothing to resolve against, and no honest default to fall back to on its behalf). A
 * caller with genuinely no tree to check against — a hermetic unit test, say — passes its own
 * explicit empty context (`{ from: "", has: () => false, isScanned: () => true }`) rather than
 * relying on one baked in here; the bare runtime root still resolves regardless, and every
 * relative specifier is reported `UNRESOLVED_IMPORT`/`FORBIDDEN_IMPORT` exactly as it would
 * against a real but empty tree — an honest "cannot resolve without a tree", never a silently
 * fabricated pass.
 *
 * `isScanned` is the SECOND, separate question `has` used to be overloaded with, and separating
 * them is what closes task-12b's Defect B. `has` answers "does the tree hold a file at this
 * path" — the only question {@link resolveDesignSpecifier} is asking, and the only one whose
 * `false` it may safely read as "try the next probe candidate". `isScanned` answers "has THIS
 * pass read that file's source", and it is asked ONCE, about the path resolution actually
 * settled on. Merging them is a real bypass, not a style point: `scanTreeImports` used to answer
 * `false` from `has` for a present-but-unscanned file, the resolver read that as "no such file"
 * and ADVANCED to the next candidate, and a different, scanned sibling then satisfied the import
 * while Bun loaded the unscanned one (measured on the real mount path — see `tree-scan.ts`'s
 * `scanTreeImports` doc for the table). A resolution is trustworthy only when the file the
 * loader will actually run is the file this scan actually read, and only a post-resolution
 * question can express that.
 *
 * `isScanned` is REQUIRED for the same reason `context` is: an optional one would default to
 * "vouch for everything", a fail-open default on a security perimeter. A caller that genuinely
 * scans nothing and resolves against nothing passes `() => true` alongside `has: () => false`,
 * where it can never fire.
 *
 * Dynamic-code detection (§5.8, Important 2/3 of the WP-6a fix pass) is
 * token-level, not a constant-folding evaluator, so it is deliberately not
 * exhaustive — but it must not be *silently* incomplete. Forms it catches:
 * a direct call (`eval("x")`, `new Function(...)`); a bare reference with no
 * immediate call, reached through any indirection (`const e = eval`, the
 * comma-operator trick `(0, eval)(...)`), because once the reference exists
 * the capability is already reachable; `Function` called with or without
 * `new` (`Function(...)` constructs a Function object exactly like
 * `new Function(...)` per the spec, so both share one check — a *bare*
 * `Function` reference is deliberately NOT flagged the way a bare `eval` is,
 * because `Function` is also TypeScript's built-in callback type and a bare
 * reference is common, legitimate authored code); and a computed-member
 * access whose bracket holds exactly the literal string `"eval"`/`"Function"`
 * (`globalThis["eval"]`, `g["Function"]`).
 *
 * Forms it knowingly does NOT catch, each pinned by a "KNOWN GAP" test in
 * `import-scan.test.ts`. Every one of them was RE-TESTED against Bun in task 14b — transpiled
 * with `Bun.Transpiler` and run through this whole perimeter — and the verdict is recorded
 * beside it, because "documented gap" is not a resting place for a shape the runtime executes:
 *
 * 1. a bare `Function` reference aliased to another name and invoked through
 *    that alias later (`const F = Function; new F(...)`) — LIVE, and inherent to a token-level
 *    scan: closing it needs alias tracking, i.e. a binder. Escalated in task 14b's report;
 * 2. a computed-member key held in a variable rather than written as a literal
 *    (`const key = "eval"; g[key](...)`) — LIVE, same reason: constant propagation;
 * 3. a computed-member key built by concatenation (`g["ev" + "al"](...)`) —
 *    LIVE, same reason one step earlier: this scan folds no constants;
 * 4. indirect access that never writes the token `eval`/`Function` at all,
 *    e.g. the classic `[].constructor.constructor("return this")()`
 *    sandbox-escape chain — LIVE, and unreachable by ANY token-level rule, since the source
 *    contains neither identifier;
 * 5. a real call sitting after a regular-expression literal whose immediately
 *    preceding token is `)` (in STATEMENT position), `<`, or `}`, inside a JSX
 *    expression container — `./jsx`'s reader read that `/` as division in all three cases (see
 *    `scanCode`'s own note there), so the regex's own `}` closed the container early and
 *    everything after it was recorded as children text. **RE-TESTED AND LARGELY CLOSED in task
 *    14b**, one predecessor at a time rather than as one row:
 *    - `<` — was LIVE. Measured: `<box id="b">a{0 < /[}]/.test("s") && eval(…)}b</box>`
 *      transpiled under Bun, `await import()` ran the `eval`, and this perimeter reported
 *      nothing. CLOSED — `scanCode` now separates a relational `<` from re-lexed JSX
 *      punctuation (`jsxPunctuation`), so the regular expression is lexed as one;
 *    - `)` — CLOSED, and now for a structural reason rather than a lucky one: this scan applies
 *      NO prose suppression at all (see "NO PROSE SUPPRESSION" below), so a call the reader
 *      mislabels as children text is still checked as the code token it is, whatever spelling
 *      it uses. Measured caught through the real perimeter;
 *    - `}` — still read as division, and measured NOT to be a live bypass: only a block or an
 *      object literal can put a `}` immediately before a `/` in expression position, and a JSX
 *      expression container holds neither — `Bun.Transpiler` refuses every spelling tried
 *      (`Unexpected }`), so the runtime never executes such a file;
 * 6. **CLOSED in task 14b.** A `{` or `}` inside a regular-expression CHARACTER CLASS used to
 *    defeat the `{`/template brace-tracking in `./lexer`'s `tokenize` itself, swallowing every
 *    later statement into unparsed template text — measured LIVE through the real perimeter
 *    (`` const s = `${/[{]/.test('x')}` `` followed by `import "node:fs"` and `eval("1")`:
 *    Bun transpiled and executed it, this scan reported nothing). `tokenize` now re-scans `/`
 *    as a regular expression through `./jsx`'s `scanCode`, so the class's braces are inside one
 *    literal token and the stack never desynchronises. Both shapes are pinned as CLOSED in
 *    `import-scan.test.ts`;
 * 7. the same desync with a genuinely UNTERMINATED template literal (no closing backtick
 *    anywhere in the file) — the resumed tail runs through EOF and swallows the rest of the
 *    file as one token. NOT a live bypass: measured, `Bun.Transpiler` REJECTS every spelling of
 *    it (`Unterminated string literal`), so the runtime never executes such a file. It stays
 *    pinned because the scan still owes it a documented outcome.
 *
 * Accepted OVER-approximation, pinned the same way: a page that merely
 * defines a property/method literally named `eval` (`{ eval() { return 1 } }`)
 * is flagged. (A regular-expression literal whose body spells the word — `/eval/` — used to be
 * flagged for the same reason and no longer is: task 14b made `tokenize` lex it as one
 * `RegularExpressionLiteral`, so the identifier token is gone. That removes a FALSE positive,
 * not a catch — a regex body cannot execute anything.)
 *
 * NO PROSE SUPPRESSION (task 14b fix round 2, Critical 1) — a deliberate trade, not an
 * oversight. Three earlier rounds each tried to keep a page's own display copy from tripping
 * these checks: by filtering out tokens a JSX reader called children TEXT, then by skipping
 * those spans in the lexer, then by filtering again but only when a call parenthesis was
 * immediately adjacent. Every one was a SUPPRESSION RULE, and each produced a FALSE NEGATIVE
 * the moment the reader's classification was wrong — which it is whenever it confirms an
 * element the runtime does not see (`let f: <T>(x: T) => T` closed by a `</T>` in a later
 * comment). Measured live through the real perimeter, every one executed by Bun: `eval ("1")`,
 * `eval` + newline + `("1")`, a bare `eval` reference, `globalThis["eval"]` and
 * `new Function ("…")` all reported NOTHING while the adjacency rule was in place.
 *
 * A suppression rule that cannot be proved sound is worth less than the over-approximation it
 * saves, so there is none. §5.8 now over-approximates UNIFORMLY: an `eval`/`Function` reference
 * is flagged wherever it appears, prose included.
 *
 * THE COST, stated plainly because a real page hits it: display copy containing the word `eval`,
 * or `Function` immediately before a `(`, is REFUSED. `<Text id="t">Never use eval here</Text>`
 * is rejected and the author rephrases ("the eval capability", "dynamic evaluation"). That is a
 * loud, correctable, one-line fix; the alternative was a silent bypass of the whole §5.8 ban.
 * `import-scan.test.ts` pins BOTH directions so neither can drift unnoticed.
 *
 * The structural protection those suppression rules were reaching for is still there, in the
 * right place: `./lexer`'s `tokenize` lexes in WINDOWS bounded by the JSX reader's text runs, so
 * a page's prose can never swallow the code after it. That is a boundary guarantee, it costs no
 * detection, and it does not depend on the classification being right.
 */
export function scanImportAllowlist(
  source: string,
  context: {
    readonly from: string;
    readonly has: (relPath: string) => boolean;
    readonly isScanned: (relPath: string) => boolean;
    readonly syntax: SourceSyntax;
  },
): SourceStreamTruncatedError | ImportScanError[] {
  const toks = tokenize(source, context.syntax);
  // A stream that does not cover the source cannot be scanned for anything — see
  // `lexer.ts`'s own completeness invariant. Propagated, never treated as "no findings".
  if (toks instanceof Error) return toks;
  const errors: ImportScanError[] = [];
  const at = (pos: number) => lineColOf(source, pos);

  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    const next = toks[i + 1];

    if (t.kind === SK.ImportKeyword) {
      if (next?.kind === SK.DotToken) continue; // import.meta — not a module edge
      if (next?.kind === SK.OpenParenToken) {
        const spec = firstStringFrom(toks, i + 2);
        const where = at(t.pos);
        errors.push({
          code: "DYNAMIC_IMPORT",
          specifier: spec?.value ?? "",
          message: `dynamic import("${spec?.value ?? ""}") is not allowed — a page loads no runtime-selected code`,
          line: where.line,
          column: where.column,
        });
        continue;
      }
      // static import (side-effect, default, named, namespace, or type-only).
      const specifier = readStaticImportSpecifier(toks, i);
      if (specifier !== null) {
        const resolved = resolveDesignSpecifier({
          from: context.from,
          specifier,
          has: context.has,
        });
        if (resolved instanceof Error) {
          const where = at(t.pos);
          errors.push({
            // A specifier the resolver could not resolve inside the tree is reported
            // separately from one that is not even a legal SHAPE: the first is usually a typo
            // or a missing file, the second is a rule violation, and telling a user "you may
            // only import @termcraft/runtime" when they wrote a perfectly legal relative
            // import with a typo would be a false diagnosis.
            code: resolved.code === "UNRESOLVED" ? "UNRESOLVED_IMPORT" : "FORBIDDEN_IMPORT",
            specifier,
            message: resolved.message,
            line: where.line,
            column: where.column,
          });
        } else if (resolved.kind === "file" && !context.isScanned(resolved.relPath)) {
          // The resolution succeeded and named a real tree file — the very file the loader will
          // run — but the caller never read that file's source, so this pass cannot say whether
          // it hides a further forbidden import, `eval` or `new Function`. Its own code, not the
          // resolver's: the resolver was right, and saying `no file at "…"` here would be a
          // false claim about a file the author can see in the tree.
          const where = at(t.pos);
          errors.push({
            code: "UNSCANNED_IMPORT",
            specifier,
            message: `"${specifier}" resolves to "${resolved.relPath}", which the loader executes but this scan was never given the source of — it cannot be checked for a forbidden import, \`eval\` or \`new Function\``,
            line: where.line,
            column: where.column,
          });
        }
      }
      continue;
    }

    if (t.kind === SK.ExportKeyword) {
      // A local declaration export (`export const/function/class/default/type X = …`)
      // is not a module edge. Only `export {…} from`, `export * from`, and
      // `export type {…} from` carry a specifier.
      if (next !== undefined && DECLARATION_STARTS.has(next.kind)) continue;
      if (next?.kind === SK.TypeKeyword) {
        const afterType = toks[i + 2];
        // `export type X = …` (local) vs `export type { … } from …` / `export type * from …`
        if (
          afterType !== undefined &&
          afterType.kind !== SK.OpenBraceToken &&
          afterType.kind !== SK.AsteriskToken
        )
          continue;
      }
      let specifier: string | null = null;
      for (let j = i + 1; j < toks.length; j += 1) {
        const tj = toks[j]!;
        if (tj.kind === SK.FromKeyword) {
          specifier = firstStringFrom(toks, j + 1)?.value ?? null;
          break;
        }
        if (isEdgeBoundary(tj.kind)) break;
      }
      if (specifier !== null) {
        const where = at(t.pos);
        errors.push({
          code: "REEXPORT",
          specifier,
          message: `re-export from "${specifier}" is not allowed — a page exports no module edge`,
          line: where.line,
          column: where.column,
        });
      }
      continue;
    }

    if (t.kind === SK.RequireKeyword && next?.kind === SK.OpenParenToken) {
      const spec = firstStringFrom(toks, i + 2);
      if (spec !== null) {
        const where = at(t.pos);
        errors.push({
          code: "REQUIRE_CALL",
          specifier: spec.value,
          message: `require("${spec.value}") is not allowed — a page uses no CommonJS load`,
          line: where.line,
          column: where.column,
        });
      }
      continue;
    }

    // `eval` (design §5.8, Important 3) — a bare REFERENCE is flagged, not just
    // a call: assigning it (`const e = eval`), smuggling it through the comma
    // operator (`(0, eval)("x")`), or any other indirection all reach the same
    // dynamic-eval capability the moment the reference exists, so no immediate
    // `(` is required. A `.eval(...)`/`?.eval(...)` method call on some OTHER
    // object is not the global — only a bare `eval` not immediately preceded
    // by `.`/`?.` counts (Important 2 folds the `?.` guard in here). This also
    // flags a page that merely defines a property/method literally named
    // `eval` (e.g. `{ eval() { return 1 } }`) — an accepted over-approximation
    // (see the module doc comment above), AND a page whose display copy contains
    // the word — `<Text id="t">Never use eval here</Text>` — which is the trade
    // task 14b fix round 2 took deliberately; see the module doc comment's
    // "NO PROSE SUPPRESSION" section for why the alternative was worse.
    if (
      t.kind === SK.Identifier &&
      t.value === "eval" &&
      (!isMemberAccess(toks[i - 1]) || isGlobalReceiver(toks[i - 2]))
    ) {
      const where = at(t.pos);
      errors.push({
        code: "EVAL_CALL",
        specifier: "",
        message: "`eval` is not allowed — a page executes no dynamic code",
        line: where.line,
        column: where.column,
      });
      continue;
    }

    // `Function(...)` / `new Function(...)` (design §5.8, Important 3) — a
    // dynamic-code construction. Only the CALLED form is flagged, unlike bare
    // `eval` above: `Function` alone is also TypeScript's built-in callback
    // type (`onClick: Function`, `Map<string, Function>`), so a bare
    // reference is common, legitimate authored code and must not be flagged —
    // only an actual invocation reaches the dynamic-construction capability.
    // `new` is optional (`Function(...)` without it constructs a Function
    // object exactly like `new Function(...)` does per the spec), so one
    // check covers both forms; a `.Function(...)`/`?.Function(...)` method
    // call on some other object is, symmetrically with `eval`, not the global.
    // Display copy that reads as a call — `<Text id="t">Function (beta)</Text>`,
    // which lexes as the adjacent tokens `Function`, `(`, `beta`, `)` — is
    // FLAGGED, the accepted trade described in the module doc comment.
    if (
      t.kind === SK.Identifier &&
      t.value === "Function" &&
      (next?.kind === SK.OpenParenToken || isParenthesisedValue(toks, i)) &&
      !isMemberAccess(toks[i - 1])
    ) {
      const where = at(t.pos);
      errors.push({
        code: "FUNCTION_CALL",
        specifier: "",
        message: "Function(...) is not allowed — a page executes no dynamic code",
        line: where.line,
        column: where.column,
      });
      continue;
    }

    // Computed-string evasion (design §5.8, Important 3): `globalThis["eval"]`
    // / `g["Function"]` reach the same globals without ever writing the
    // `eval`/`Function` IDENTIFIER token. Flagged only when the bracket is a
    // MEMBER access — preceded by a value (an identifier, `this`, or a prior
    // call/index result) — not a bare array literal (`["eval"]` sitting on its
    // own, e.g. in a word list, is not evasion and must not be flagged). A key
    // built through concatenation or held in a variable first
    // (`"ev" + "al"`, `const k = "eval"; g[k]`) is NOT caught — this is a
    // token-level scan, not a constant-folding evaluator (see the module doc
    // comment's pinned "KNOWN GAP" list). Display copy spelling this shape is
    // flagged too, on the same trade as the two checks above.
    if (
      t.kind === SK.OpenBracketToken &&
      (toks[i - 1]?.kind === SK.Identifier ||
        toks[i - 1]?.kind === SK.CloseParenToken ||
        toks[i - 1]?.kind === SK.CloseBracketToken ||
        toks[i - 1]?.kind === SK.ThisKeyword) &&
      next !== undefined &&
      next.kind === SK.StringLiteral &&
      (next.value === "eval" || next.value === "Function") &&
      toks[i + 2]?.kind === SK.CloseBracketToken
    ) {
      const where = at(t.pos);
      errors.push({
        code: next.value === "eval" ? "EVAL_CALL" : "FUNCTION_CALL",
        specifier: "",
        message: `computed access to "${next.value}" is not allowed — a page executes no dynamic code`,
        line: where.line,
        column: where.column,
      });
      continue;
    }
  }

  return errors;
}

/**
 * The raw static-import specifiers of one file, in source order, for `entities/design-tree`'s
 * `resolveClosure`'s `edgesOf` (design §7, Task 3). Shares `readStaticImportSpecifier` with
 * {@link scanImportAllowlist} so the closure walk and the allowlist scan can never disagree
 * about what a file imports — legality aside, this is a raw edge list: a `require(...)`, a
 * dynamic `import(...)`, and an `export … from` re-export are deliberately NOT edges here (a
 * cycle through one of those is not a module edge to walk), matching `scanImportAllowlist`'s
 * own DYNAMIC_IMPORT/REEXPORT/REQUIRE_CALL branches, which never touch a closure either — the
 * allowlist scan still catches all three as fatal on its own pass over the same file.
 */
export function scanModuleEdges(
  source: string,
  syntax: SourceSyntax,
): SourceStreamTruncatedError | readonly string[] {
  const toks = tokenize(source, syntax);
  if (toks instanceof Error) return toks;
  const edges: string[] = [];
  for (let i = 0; i < toks.length; i += 1) {
    if (toks[i]?.kind !== SK.ImportKeyword) continue;
    const next = toks[i + 1];
    if (next?.kind === SK.DotToken || next?.kind === SK.OpenParenToken) continue;
    const specifier = readStaticImportSpecifier(toks, i);
    if (specifier !== null) edges.push(specifier);
  }
  return edges;
}
