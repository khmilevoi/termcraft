import type { ImportScanError } from "./import-scan";
import { scanImportAllowlist, scanModuleEdges } from "./import-scan";

export { scanModuleEdges };

/**
 * The tree-relative path's own file extension — the substring from, and including, its LAST
 * `.` in the basename — lowercased, or `""` when the basename has no `.` at all. Hand-written
 * rather than `node:path`'s `extname` (task-12 review round 3, Minor — round 2 used it):
 * tree-relative paths are ALWAYS forward-slash, never an OS path (this plan's own vocabulary),
 * and `node:path`'s default export is platform-flavored (`path.win32` on Windows, whose
 * backslash handling differs from posix's `extname` on the same string). Not exploitable
 * today — `store/safe-fs`'s own path rules already reject an embedded backslash before this
 * module ever sees the path — but there is no reason to couple a forward-slash-only module to
 * platform behavior it does not need, and `entities/design-tree`'s own `specifier.ts` avoids
 * `node:path` for the identical reason.
 *
 * Deliberately NOT `node:path`'s own "dotfile" convention either, under which a name that is
 * ENTIRELY an extension (`.ts`) is treated as having NO extension at all
 * (`path.extname(".ts") === ""`, `path.extname("lib/.mjs") === ""`) — that convention is
 * exactly what let `design/.ts`/`lib/.mjs` sail through `isCodeFile` unscanned in round 2
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
function extensionOf(relPath: string): string {
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
 * THE CRITERION, and why it is this one. Rounds 1-3 each picked their list by asking "does
 * this look like code", and each shipped a different wrong answer. The question this list
 * actually answers is narrower and measurable: **when the host imports this file, does Bun run
 * its text as JS/TS?** That is the only property either enforcement point below depends on — a
 * file whose text is never executed can neither carry a module edge nor reach `eval`, no
 * matter what its bytes spell. The real import happens at
 * `host/session/model/source-mount.ts`'s `await import(args.sourcePath)`.
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
 * and silently skipped at both points below. This is a real fail-open direction and it is
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
 * Used at BOTH of this module's enforcement points — one predicate, so the two can never
 * disagree about what "code" means:
 *
 * 1. the scan loop below SKIPS a file this returns false for even when its text sits in
 *    `input.files`: feeding prose, JSON or image bytes through a JS/TS tokenizer manufactures
 *    a fatal out of content that merely happens to spell a banned identifier, and the loader
 *    would never have run that content anyway;
 * 2. `effectiveHas` below REQUIRES a file this returns true for to be present in `files` before
 *    trusting a resolution to it, because a file the loader executes can itself hide a further
 *    forbidden import this pass never read (task-11 review, Important 2's hazard).
 *
 * Both follow from the same measured fact and would be wrong under any other reading of it: a
 * non-executed target carries no import syntax to miss, so demanding its text (point 2) or
 * tokenizing its bytes (point 1) could only ever produce a false diagnosis.
 */
function isCodeFile(relPath: string): boolean {
  const extension = extensionOf(relPath);
  return extension === "" || EXECUTED_AS_CODE_EXTENSIONS.has(extension);
}

/**
 * Run the AUTHORITATIVE allowlist ({@link scanImportAllowlist}) over every CODE file of a tree,
 * tagging each error with the tree-relative path it came from (design §6, §8 step 4). This is
 * the point of the whole-tree scan, not merely a convenience: a forbidden import in a shared
 * module — `lib/theme.ts`, reached by every page that imports it — compromises every page that
 * reaches it, so it must be caught even when the file is scanned on its own, with no page ever
 * mentioned. `scanTreeImports` does no closure walking and does not care whether any entry
 * actually reaches a given file; it scans every CODE file `input.files` names, unconditionally,
 * which is exactly the property that makes an orphaned shared module's own bad import
 * un-missable — a NON-code file in `input.files` is skipped outright ({@link isCodeFile}),
 * never tokenized as JS/TS.
 *
 * THE CONTRACT (task-12 review — see the plan's red-debt ledger, item 3, and rounds 1-4's own
 * findings): `input.has` is the caller's whole-tree inventory — it is legitimately broader
 * than `input.files`, whose keys are only the files THIS pass was given source text for.
 * `store`'s `listTree` enumerates every file under `design/` regardless of extension, so a
 * real tree legitimately contains `.json`/`.md`/`.svg`/`.avif` files a page may resolve a
 * relative import to (design §6 places no extension restriction on a resolution TARGET, only on
 * the extensionless PROBE) without ever needing their text scanned — {@link isCodeFile} draws
 * that line on whether Bun's loader would EXECUTE the target, not on presence. Only a target
 * the loader executes is held to the stricter "must also be a key in `files`" bar, because only
 * that kind of file could itself hide a further forbidden import this pass never read. A caller
 * that narrows `has` down to exactly `files`'s own keys (Task 11's original, since-revised
 * draft) would turn every legitimate cross-file import of a non-executed tree file into a fatal
 * purely because of its presence in the tree, unrelated to anything wrong with it — the same
 * class of defect as Task 9's byte-comparison, which bricked two user commands by rejecting
 * valid input. `effectiveHas` below is the enforcement of this narrower, honest invariant: an
 * EXECUTED resolution target absent from `files` still reports `UNRESOLVED_IMPORT` (task-11
 * review's Important 2 hazard stays fatal for every extension in
 * {@link EXECUTED_AS_CODE_EXTENSIONS}, matched case-insensitively, and for dotfiles and
 * extensionless names), but nothing else does. `runTreeImports` (`gate/model/gate.ts`) is the
 * caller this was written for: `has` is backed by the whole-tree `treePaths`, `files` by
 * whatever text this particular turn's Gate run actually holds.
 */
export function scanTreeImports(input: {
  readonly files: ReadonlyMap<string, string>;
  readonly has: (relPath: string) => boolean;
}): readonly (ImportScanError & { readonly file: string })[] {
  const effectiveHas = (relPath: string) =>
    input.has(relPath) && (input.files.has(relPath) || !isCodeFile(relPath));
  const errors: (ImportScanError & { readonly file: string })[] = [];
  for (const [from, source] of input.files) {
    if (!isCodeFile(from)) continue;
    for (const error of scanImportAllowlist(source, { from, has: effectiveHas })) {
      errors.push({ ...error, file: from });
    }
  }
  return errors;
}
