import { computeJsxTextTokenIndices } from "./jsx";
import { SK, lineColOf, tokenize } from "./lexer";
import type { SyntaxKind, Tok } from "./lexer";

/** The one legal authored module specifier — the bare runtime root (runtime-api §3.1). */
const RUNTIME_ROOT = "@termcraft/runtime";

/**
 * A fatal import-allowlist violation the gate rejects the candidate for (§3.1),
 * plus the two dynamic-code forms banned by the same design-code-rules bullet
 * (design §5.8: "`eval` and `new Function` are also forbidden"). `specifier` is
 * empty for the dynamic-code codes — they name no module edge.
 */
export interface ImportScanError {
  readonly code:
    | "FORBIDDEN_IMPORT"
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
 * The AUTHORITATIVE static-import allowlist scan (runtime-api §3.1). Tokenizes the
 * page source with the TypeScript lexer and classifies EVERY module edge the author
 * wrote — value + type-only imports, side-effect imports, `export … from`
 * re-exports, `import(...)` dynamic imports, and CJS `require(...)` — plus, per the
 * same design §5.8 rule, dynamic-code forms centered on the `eval`/`Function`
 * globals, fatal violations rather than module edges. Only a static
 * `import … from "@termcraft/runtime"` (bare root, no subpath) is legal; a
 * dynamic import, a re-export, or a require is rejected even when it names the
 * runtime, because one page is one independently-renderable file with no
 * runtime-selected loading. Because this scans the SOURCE tokens (not the
 * transform output), the compiler-injected JSX-helper edges never appear — no
 * exemption is needed, and an author-written `require("react")` (a real source
 * token) is caught, unlike the host's `Bun.Transpiler.scanImports` (2C residual gap).
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
 * (`globalThis["eval"]`, `g["Function"]`). Forms it knowingly does NOT catch,
 * each pinned by a "KNOWN GAP" test in `import-scan.test.ts`: a bare
 * `Function` reference aliased to another name and invoked through that
 * alias later; a computed-member key held in a variable rather than written
 * as a literal (`const key = "eval"; g[key](...)`); and indirect access that
 * never writes the token `eval`/`Function` at all, e.g. the classic
 * `[].constructor.constructor("return this")()` sandbox-escape chain. A page
 * that merely defines a property/method literally named `eval` (e.g.
 * `{ eval() { return 1 } }`) is flagged too — an accepted over-approximation:
 * a page naming something `eval` is unusual enough that it is not worth
 * carving out an exemption for.
 *
 * The three dynamic-code checks below skip any identifier/bracket token
 * `computeJsxTextTokenIndices` (`./jsx`) marks as JSX children TEXT (WP-6a
 * fix-pass-2, Important 1): without that guard, a page's own display copy —
 * `<Text id="t">Never use eval here</Text>`, `<Text id="t">Function (beta)</Text>`
 * — tripped a FATAL rejection on ordinary prose, which is worse than the gap
 * this check was written to close. A real `eval(...)`/`Function(...)`
 * reference inside a JSX expression container (`{eval("1")}`) is never marked
 * as text, so it stays caught. The other checks in this scan (import/export/
 * require) are not guarded the same way: each requires a `StringLiteral`
 * specifier immediately in scope, a shape prose essentially never produces,
 * and Important 1 named only `eval`/`Function` as observed false rejections.
 *
 * `computeJsxTextTokenIndices` itself is built on `scanJsx` (`./jsx`, WP-6a
 * fix-pass-3), a real recursive-descent reader over the TypeScript scanner's
 * own JSX mode — not the fix-pass-2 code-token heuristic it replaced. That
 * heuristic's premise (walking CODE-mode tokens to guess where JSX text
 * lives) was unsound: an apostrophe or `//` inside ordinary prose opened a
 * real string literal or line comment that could swallow a page's own
 * closing tag, fatally rejecting its display copy — and, the mirror image, a
 * dangling close tag left over from an unrelated, uncalled generic type
 * argument (`Array<Foo>` … `</Foo>`) could launder a real `eval(...)`
 * in between into "text", silently returning no errors at all. `scanJsx`
 * reads real JSX structure instead (`scanJsxToken`, matching close tags,
 * `{}` expression containers), so neither failure mode can occur here; see
 * its doc comment for the reader's own fail-closed discipline.
 */
export function scanImportAllowlist(source: string): ImportScanError[] {
  const toks = tokenize(source);
  const jsxText = computeJsxTextTokenIndices(toks, source);
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
      // static import (side-effect, default, named, namespace, or type-only). The
      // specifier is the first StringLiteral in the statement; a RequireKeyword
      // first means `import x = require(...)` — left for the require handler.
      let specifier: string | null = null;
      for (let j = i + 1; j < toks.length; j += 1) {
        const tj = toks[j]!;
        if (tj.kind === SK.RequireKeyword) break;
        if (tj.kind === SK.StringLiteral) {
          specifier = tj.value;
          break;
        }
        if (isEdgeBoundary(tj.kind)) break;
      }
      if (specifier !== null && specifier !== RUNTIME_ROOT) {
        const where = at(t.pos);
        errors.push({
          code: "FORBIDDEN_IMPORT",
          specifier,
          message: `import of "${specifier}" is not allowed — a page may only import "${RUNTIME_ROOT}"`,
          line: where.line,
          column: where.column,
        });
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
    // (see the module doc comment above). `!jsxText.has(i)` (Important 1) skips
    // this word when it is JSX children TEXT, not a reference.
    if (
      t.kind === SK.Identifier &&
      t.value === "eval" &&
      !jsxText.has(i) &&
      toks[i - 1]?.kind !== SK.DotToken &&
      toks[i - 1]?.kind !== SK.QuestionDotToken
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
    // `!jsxText.has(i)` (Important 1) skips this word when it is JSX children
    // TEXT — e.g. `<Text id="t">Function (beta)</Text>` — rather than a call;
    // note the space in "Function (beta)" still lexes as adjacent tokens
    // (`Function`, `(`, `beta`, `)`), so without the guard this shape would
    // still match `next?.kind === SK.OpenParenToken` and fatally reject prose.
    if (
      t.kind === SK.Identifier &&
      t.value === "Function" &&
      next?.kind === SK.OpenParenToken &&
      !jsxText.has(i) &&
      toks[i - 1]?.kind !== SK.DotToken &&
      toks[i - 1]?.kind !== SK.QuestionDotToken
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
    // comment's pinned "KNOWN GAP" list). `!jsxText.has(i)` (Important 1)
    // skips this shape inside JSX children text too, for the same reason.
    if (
      t.kind === SK.OpenBracketToken &&
      !jsxText.has(i) &&
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
