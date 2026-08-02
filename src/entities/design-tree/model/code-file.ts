/**
 * The tree-relative path's own file extension — the substring from, and including, its LAST
 * `.` in the basename — lowercased, or `""` when the basename has no `.` at all. Hand-written
 * rather than `node:path`'s `extname` (task-12 review round 3, Minor — round 2 used it):
 * tree-relative paths are ALWAYS forward-slash, never an OS path (this plan's own vocabulary),
 * and `node:path`'s default export is platform-flavored (`path.win32` on Windows, whose
 * backslash handling differs from posix's `extname` on the same string). Not exploitable
 * today — `store/safe-fs`'s own path rules already reject an embedded backslash before this
 * module ever sees the path — but there is no reason to couple a forward-slash-only module to
 * platform behavior it does not need, and this module's sibling `specifier.ts` avoids
 * `node:path` for the identical reason.
 *
 * Deliberately NOT `node:path`'s own "dotfile" convention either, under which a name that is
 * ENTIRELY an extension (`.ts`) is treated as having NO extension at all
 * (`path.extname(".ts") === ""`, `path.extname("lib/.mjs") === ""`) — that convention is
 * exactly what let `design/.ts`/`lib/.mjs` sail through {@link isCodeFile} unscanned in round 2
 * (task-12 review round 3, Important). Here `.ts` gives back `.ts`, not `""`, and round 4's
 * import-path measurement (see {@link EXECUTED_AS_CODE_EXTENSIONS}) is what settles which
 * reading is correct rather than which is conventional: `await import()` on files literally
 * named `.ts` and `lib/.mjs` EXECUTED their bodies as TypeScript, while `.env` and `.gitignore`
 * — the same whole-name-is-an-extension shape, different extension — came back through the
 * text loader without executing. Treating all four as "no extension" would have been wrong in
 * both directions at once.
 *
 * The basename is taken FIRST, so a dot in a directory segment is never mistaken for the
 * file's own extension: `lib.d/README` has extension `""` (and measurably executes), not
 * `.d`.
 */
export function extensionOf(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  const name = slash === -1 ? relPath : relPath.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/**
 * The file extensions Bun's module loader EXECUTES as JS/TS. An extensionless name is NOT
 * listed here and is handled separately by {@link isCodeFile} — Bun executes those too, and a
 * `Set` keyed on `""` would read as if `""` were an extension.
 *
 * THE CRITERION, and why it is this one. Rounds 1-3 of task 12 each picked their list by asking
 * "does this look like code", and each shipped a different wrong answer. The question this list
 * actually answers is narrower and measurable: **when the host imports this file, does Bun run
 * its text as JS/TS?** That is the only property either consumer depends on — a file whose text
 * is never executed can neither carry a module edge nor reach `eval`, no matter what its bytes
 * spell. The real import happens at `host/session/model/source-mount.ts`'s `await import(...)`.
 *
 * MEASURED on that path, not reasoned about, and specifically NOT with `bun run <file>` — the
 * CLI entrypoint picks a loader differently from the module graph, and the two disagree (which
 * is what made round 3's list wrong in both directions). 72 fixtures, each holding a real side
 * effect plus an export, each `await import()`ed by absolute path under Bun 1.3.14 (the version
 * `package.json`'s `engines` pins as the floor). 17 executed the side effect; 55 did not. The
 * 17: exactly the eight extensions below, plus every EXTENSIONLESS name (`README`,
 * `Dockerfile`, `Makefile`, `lib.d/README`), plus a name that IS entirely an extension (`.ts`,
 * `lib/.mjs`), plus the uppercase spellings (`mod.TS`, `mod.JSX`). The 55 came back through a
 * non-executing loader instead — `{ default: string }` from the text/file loader for `.md`,
 * `.png`, `.csv`, `.svg`, `.sh`, `.py`, `.ini`, `.mdx`, `.avif`, `.woff`; a JSON parse error
 * for `.json`; a TOML parse error for `.toml`; `{ default: string }` for the whole-name
 * dotfiles `.env` and `.gitignore`. Under this criterion a `.png` or a `.csv` genuinely cannot
 * hide a forbidden import, and an extensionless file genuinely can.
 *
 * RESIDUAL 1 — this list tracks Bun's loader map, so it goes stale if that map gains a new
 * JS/TS extension. A newly-executable extension absent from this list would be classified data
 * and silently skipped by every consumer. This is a real fail-open direction and it is
 * accepted knowingly, because the alternative measured worse: round 3 defaulted the unknown
 * case to "code" and that produced a permanent hang and mass false rejection on ordinary asset
 * content. The mitigation is that the criterion is re-runnable rather than a matter of
 * judgement — re-measure against the import path when the pinned Bun floor moves.
 *
 * RESIDUAL 2 — a Bun plugin can override the loader for an extension, which would make a file
 * this list calls data execute after all. Checked, not assumed: this project registers exactly
 * one plugin, `host/session/model/resolver.ts`'s `registerRuntimeResolver`, and it uses only
 * `build.module(...)` for three fixed BARE specifiers (`@termcraft/runtime`,
 * `react/jsx-runtime`, `react/jsx-dev-runtime`). It installs no `onLoad`/`onResolve` filter, so
 * it changes no extension's loader, and the repository has no `bunfig.toml` at any level. If a
 * loader/plugin is ever registered for the design-tree mount, this list must be re-derived
 * against it.
 *
 * RESIDUAL 3 — the criterion makes extensionless files code, so an extensionless PROSE file in
 * the tree (`LICENSE`, `CHANGELOG`) is tokenized as JS/TS and its text can trip a false
 * `EVAL_CALL` on a bare `eval` word. That is the honest consequence of the measurement rather
 * than a guess: such a file really would execute if imported. It is a loud, correctable
 * refusal (give the file an extension), and it is a far smaller surface than round 3's
 * "everything except 24 names", which false-fatal'd `.csv`, `.sql`, `.log`, `.tex` and random
 * `.mp4`/`.pdf` bytes as well.
 */
const EXECUTED_AS_CODE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

/**
 * True for a tree-relative path whose text Bun's module loader would EXECUTE as JS/TS — its
 * own extension ({@link extensionOf}) is one of {@link EXECUTED_AS_CODE_EXTENSIONS}, or it has
 * no extension at all (measured: Bun executes an extensionless file as TypeScript). Matching is
 * case-insensitive because {@link extensionOf} lowercases: `mod.TS` measurably executes, and on
 * a case-insensitive filesystem it is reachable as `mod.ts` regardless.
 *
 * WHY IT LIVES IN `entities/design-tree` AND NOT IN ITS FIRST CONSUMER (task 15). It began in
 * `gate/model/tree-scan.ts`, where it serves two enforcement points at once — the scan loop
 * SKIPS a file this returns false for even when its text is present (feeding prose, JSON or
 * image bytes through a JS/TS tokenizer manufactures a fatal out of content the loader would
 * never have run), and `isTrustedTarget` REQUIRES a file this returns true for to have been
 * scanned before a resolved import to it is trusted. Task 15 gave the predicate a THIRD
 * consumer in a different ring: `host/session/model/source-mount.ts`'s pre-mount closure walk
 * must scan exactly the closure members Bun would execute and must not tokenize the rest. The
 * module DAG forbids `host` importing `gate`, so leaving it in `gate` would have meant a
 * SECOND, independently derived reading of "is this code" — the precise failure mode task 12's
 * controller ruling #9 was written about, where two readings of one question disagreed and the
 * disagreement was a security hole. `entities/design-tree` is the one place both rings may
 * import, so the predicate moved here and `gate/model/tree-scan.ts` re-exports it unchanged.
 */
export function isCodeFile(relPath: string): boolean {
  const extension = extensionOf(relPath);
  return extension === "" || EXECUTED_AS_CODE_EXTENSIONS.has(extension);
}

/**
 * Whether Bun's parser reads a source's text as JSX. Consumers pick a tokenizer/transpiler
 * mode from it — `gate/model/lexer.ts` re-declares the identical union as its own
 * `SourceSyntax`, which is why both spell the members the same way.
 */
export type SourceSyntaxV1 = "jsx" | "no-jsx";

/**
 * The file extensions whose text Bun's parser reads as JSX. A source outside this set is parsed
 * with NO JSX at all, so `<` there is always a relational operator or a type-argument opener,
 * and any JSX "element" a scanner thinks it sees in one is fiction.
 *
 * MEASURED, not inherited from the loader table above, because the two questions are different:
 * {@link EXECUTED_AS_CODE_EXTENSIONS} asks whether Bun RUNS the file, this asks whether Bun's
 * parser accepts JSX SYNTAX in it, and `.ts` answers yes to the first and no to the second. The
 * measurement is the same shape — `await import(<absolute path>)`, one directory per fixture,
 * Bun 1.3.14 — with two sources, one valid ONLY as JSX (`export const a = <p>hi</p>`) and one
 * valid ONLY as non-JSX (the `<string>v` type assertion, which a JSX parser reads as an unclosed
 * element):
 *
 * ```
 * .tsx  .jsx  .js  <extensionless>   JSX runs, the type assertion is a Syntax Error   -> JSX
 * .ts   .mts  .cts                   the element is a Syntax Error, the assertion runs -> no JSX
 * .mjs  .cjs                         NEITHER runs — plain JS, so no JSX and no types   -> no JSX
 * ```
 *
 * WHY THIS EXISTS AT ALL (task 14b fix round 1, Critical 1). `gate/model/lexer.ts`'s `tokenize`
 * used to ask the JSX reader for children-text ranges unconditionally and skip them. In a `.ts`
 * file every such range is invented, and the code inside it disappeared from the token stream:
 * measured, `let a: <T>(x: T) => T;` followed by `eval("1")`, `import "node:fs"` and a `// </T>`
 * comment transpiled under Bun, EXECUTED under `await import()`, and produced ZERO findings
 * through the real perimeter — while the previous commit had reported the import.
 *
 * It sits here, beside {@link isCodeFile}, for the same reason that predicate does (task 15):
 * `host/session/model/source-mount.ts` picks its `Bun.Transpiler` loader from exactly this
 * question, and `host` may not import `gate`. One measured answer, asked by the whole-tree scan,
 * the closure walk and the pre-mount rescan alike.
 */
const JSX_PARSED_EXTENSIONS = new Set([".tsx", ".jsx", ".js"]);

/**
 * True when Bun parses this tree-relative path's text as JSX ({@link JSX_PARSED_EXTENSIONS}), or
 * when it has no extension at all — measured: an extensionless file runs as TypeScript WITH JSX.
 * Matching is case-insensitive because {@link extensionOf} lowercases.
 */
export function parsesJsx(relPath: string): SourceSyntaxV1 {
  const extension = extensionOf(relPath);
  return extension === "" || JSX_PARSED_EXTENSIONS.has(extension) ? "jsx" : "no-jsx";
}
