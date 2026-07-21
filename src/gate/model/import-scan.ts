import { SK, lineColOf, tokenize } from "./lexer";
import type { Tok } from "./lexer";

/** The one legal authored module specifier — the bare runtime root (runtime-api §3.1). */
const RUNTIME_ROOT = "@termcraft/runtime";

/** A fatal import-allowlist violation the gate rejects the candidate for (§3.1). */
export interface ImportScanError {
  readonly code: "FORBIDDEN_IMPORT" | "DYNAMIC_IMPORT" | "REEXPORT" | "REQUIRE_CALL";
  readonly specifier: string;
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

/** The keywords that begin a LOCAL declaration export (never a re-export). */
const DECLARATION_STARTS = new Set<number>(
  [
    "ConstKeyword",
    "LetKeyword",
    "VarKeyword",
    "FunctionKeyword",
    "ClassKeyword",
    "AsyncKeyword",
    "AbstractKeyword",
    "EnumKeyword",
    "InterfaceKeyword",
    "NamespaceKeyword",
    "ModuleKeyword",
    "DefaultKeyword",
  ]
    .map((name) => SK[name])
    .filter((k): k is number => k !== undefined),
);

/** Tokens that end the search for an import specifier / an export `from` clause. */
function isEdgeBoundary(kind: number): boolean {
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
 * re-exports, `import(...)` dynamic imports, and CJS `require(...)`. Only a static
 * `import … from "@termcraft/runtime"` (bare root, no subpath) is legal; a dynamic
 * import, a re-export, or a require is rejected even when it names the runtime,
 * because one page is one independently-renderable file with no runtime-selected
 * loading. Because this scans the SOURCE tokens (not the transform output), the
 * compiler-injected JSX-helper edges never appear — no exemption is needed, and an
 * author-written `require("react")` (a real source token) is caught, unlike the
 * host's `Bun.Transpiler.scanImports` (2C residual gap).
 */
export function scanImportAllowlist(source: string): ImportScanError[] {
  const toks = tokenize(source);
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
  }

  return errors;
}
