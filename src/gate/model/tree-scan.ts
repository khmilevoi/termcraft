import * as errore from "errore";

import type { ImportScanError } from "./import-scan";
import { scanImportAllowlist, scanModuleEdges } from "./import-scan";

export { scanModuleEdges };

/**
 * One tree file the allowlist scan could not read to the end. Carried as a value (never thrown
 * on) so {@link scanTreeImports} can report it as a fatal like any other finding.
 *
 * THE ONE MEASURED CAUSE, and why this exists at all. `./jsx`'s reader is recursive descent, so
 * absurdly deep JSX nesting exhausts the JS stack and the engine throws `RangeError: Maximum call
 * stack size exceeded`. Measured through this very function under Bun 1.3.14: `"<a>{".repeat(k)`
 * returns normally at 24 000 characters (3 375 ms, zero errors) and THROWS at 32 000; well-formed
 * `"<a>".repeat(k) + "x" + "</a>".repeat(k)` returns at 59 998 characters (140 ms) and throws at
 * 99 996. This is NOT introduced by the element memo — the same shapes overflow at the same order
 * of magnitude on the pre-memo reader, which simply never got that far on the unterminated one
 * because it hung first.
 *
 * `runTreeImports` (`gate/model/gate.ts`) is SYNCHRONOUS and Task 14 calls it once per turn with
 * no `try` of its own, so an escaping throw would crash the turn pipeline rather than reject a
 * page. Converting it here is the fail-closed outcome and the only honest one: the file was not
 * scanned, so it cannot be vouched for.
 *
 * DELIBERATELY NOT discriminated by error type. An earlier draft caught only `RangeError` and
 * rethrew everything else; that puts this module in the business of deciding which internal
 * failures are "expected", and a rethrow from here lands in exactly the caller that cannot handle
 * it. Every throw becomes this fatal instead, with the original attached as `cause` and its name
 * and message reproduced in the diagnostic, so a genuine bug surfaces as a loud rejected page
 * naming itself rather than as a silently swallowed error or a crashed turn.
 */
class TreeFileUnscannableError extends errore.createTaggedError({
  name: "TreeFileUnscannableError",
  message: 'the import scan could not read "$file" to the end',
}) {}

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
 * 2. {@link isTrustedTarget} below REQUIRES a file this returns true for to be present in `files`
 *    before trusting a RESOLVED import to it, because a file the loader executes can itself hide
 *    a further forbidden import this pass never read (task-11 review, Important 2's hazard).
 *
 * Both follow from the same measured fact and would be wrong under any other reading of it: a
 * non-executed target carries no import syntax to miss, so demanding its text (point 2) or
 * tokenizing its bytes (point 1) could only ever produce a false diagnosis.
 *
 * Exported (task-13 review round 1, Critical C1) so `gate/adapters/gate-runner.ts`'s closure
 * resolution can reuse this SAME measured predicate for its own `edgesOf` — a file this
 * returns false for has no import syntax to walk either, and re-deriving a second "is this
 * code" test there would risk the two disagreeing about what counts as code.
 */
export function isCodeFile(relPath: string): boolean {
  const extension = extensionOf(relPath);
  return extension === "" || EXECUTED_AS_CODE_EXTENSIONS.has(extension);
}

/**
 * True when this pass may TRUST a resolution target: either the loader never executes it (so it
 * carries no import syntax to miss), or its source is a key in `files` and was therefore actually
 * scanned above. Handed to {@link scanImportAllowlist} as `isScanned` — asked ONCE, about the
 * path {@link resolveDesignSpecifier} settled on, never about a candidate on the way there.
 *
 * THE BUG THIS SHAPE CLOSES, and why the shape is the fix. Rounds 0 and 1 of task-12b both
 * answered this question through the resolver's own `has`, i.e. by claiming a present-but-
 * unscanned file did not exist. That merges two different questions into one boolean, and
 * `resolveDesignSpecifier` cannot tell them apart: it reads `false` as "no such file" and
 * ADVANCES to the next probe candidate. A different, scanned file then satisfies the import while
 * Bun loads the unscanned one. Two shapes of it were measured, and the second is why the second
 * round of latching was abandoned for this post-resolution question:
 *
 * ```
 * spec ../lib/foo   present [lib/foo(unscanned), lib/foo.tsx(scanned)]  Bun loads lib/foo
 * spec ../lib/foo   present [lib/foo.tsx(unscanned), lib/foo.ts(scanned)]  Bun loads lib/foo.tsx
 * ```
 *
 * Both were clean before; the first fell to a latch armed on the exact path, the second slipped
 * one probe step further down and needed a latch of its own. There is no bound on that game —
 * every candidate the resolver can advance past is another row — so the question is asked where
 * it actually belongs instead: after resolution, once, about the file the loader will run.
 *
 * WHY THE RESOLVED PATH IS THE FILE BUN RUNS. Measured on the real mount path (`await
 * import(<absolute path>)`, as `host/session/model/source-mount.ts:137` does), Bun 1.3.14, each
 * fixture in its OWN directory because Bun's module cache aliases paths across a case-insensitive
 * filesystem otherwise. All 32 present-subsets of `{foo, foo.tsx, foo.ts, foo.js, foo.json}`,
 * plus every explicit specifier, 160 fixtures: for `./lib/foo` Bun's order is
 *
 * ```
 * foo > foo.tsx > foo.ts > foo.js > foo.json > foo/index.tsx
 * ```
 *
 * of which `resolveDesignSpecifier`'s own `base > .tsx > .ts` is a strict PREFIX. So wherever the
 * design resolver resolves at all, it names exactly the file Bun loads; wherever it stops short
 * (only `.js`/`.json` or a directory index exists) it reports `UNRESOLVED_IMPORT`, which is fatal
 * — fail closed, never a wrong target. The explicit specifiers agree too: `./lib/foo.tsx` and
 * `./lib/foo.ts` load only their exact file, and `./lib/foo.js` loads `lib/foo.js` whenever it
 * exists (its `.ts`/`.tsx` fallback only fires when `lib/foo.js` does NOT exist, where the design
 * resolver refuses outright). The directory-index tail was measured separately — `foo.tsx`,
 * `foo.ts`, `foo.js` and `foo.json` each beat `foo/index.tsx`, and an extensionless `foo` cannot
 * be compared with it at all because one name cannot be both a file and a directory.
 *
 * NOT claimed: that Bun's map and §6's are the same map. They are not — Bun also serves
 * `.js`/`.jsx`/`.mjs`/`.cjs`, `.json` and a directory index for an extensionless specifier, and
 * §6 deliberately serves none of them. The claim is only the one soundness needs, and it is the
 * one the matrix checks: §6's order is a PREFIX of Bun's, so §6 never picks a DIFFERENT file than
 * Bun would — it either picks the same one or refuses. This lemma is executed, not asserted:
 * `tree-scan.test.ts`'s soundness-matrix test replays all 1215 (present x scanned x specifier)
 * rows against those measured loader outcomes.
 */
function isTrustedTarget(
  input: { readonly files: ReadonlyMap<string, string> },
  relPath: string,
): boolean {
  return !isCodeFile(relPath) || input.files.has(relPath);
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
 * valid input.
 *
 * WHAT THE CODE BELOW ACTUALLY DOES, stated so the next reader need not re-derive it. `has` is
 * passed through UNCHANGED — the resolver is answered honestly about what exists, so it resolves
 * to the file the loader will really run. {@link isTrustedTarget} is then asked ONCE, about that
 * resolved path, and a target the loader EXECUTES but `files` does not hold is reported
 * `UNSCANNED_IMPORT` (task-11 review's Important 2 hazard stays fatal for every extension in
 * {@link EXECUTED_AS_CODE_EXTENSIONS}, matched case-insensitively, and for dotfiles and
 * extensionless names). Nothing else is refused: a target the loader never executes needs no
 * source, and a specifier that does not resolve at all is still the resolver's own
 * `UNRESOLVED_IMPORT`, unchanged.
 *
 * That is a change of CODE, not only of wording, from task-12b's round 0, which forced
 * `UNRESOLVED_IMPORT` by answering `false` from `has` for a present-but-unscanned file. Two
 * things were wrong with that: the resolver then emitted `no file at "lib/foo"` about a file
 * sitting in the tree, and — because it reads that `false` as licence to try the NEXT probe
 * candidate — a scanned sibling could satisfy an import the loader would serve from the unscanned
 * file. See {@link isTrustedTarget} for the measurement and for why no amount of latching on the
 * `has` side closes it.
 *
 * `runTreeImports` (`gate/model/gate.ts`) is the caller this was written for: `has` is backed by
 * the whole-tree `treePaths`, `files` by whatever text this particular turn's Gate run actually
 * holds.
 */
export function scanTreeImports(input: {
  readonly files: ReadonlyMap<string, string>;
  readonly has: (relPath: string) => boolean;
}): readonly (ImportScanError & { readonly file: string })[] {
  const errors: (ImportScanError & { readonly file: string })[] = [];
  const isScanned = (relPath: string) => isTrustedTarget(input, relPath);
  for (const [from, source] of input.files) {
    if (!isCodeFile(from)) continue;
    // TWO WAYS THIS FILE CAN FAIL TO BE SCANNED, both fail-closed to the same code:
    //   - `scanImportAllowlist` RETURNS a `SourceStreamTruncatedError` when the token stream
    //     does not cover the source (`lexer.ts`'s completeness invariant). Controlled code,
    //     reported as a value — no `try` involved (task-14 review round 2, M6).
    //   - the ENGINE throws: `./jsx`'s reader is recursive descent and can overflow the stack
    //     on deep enough nesting. That is the one UNCONTROLLED boundary in this module, and
    //     the only thing `errore.try` is here for. See {@link TreeFileUnscannableError}.
    const scanned = errore.try({
      try: () => scanImportAllowlist(source, { from, has: input.has, isScanned }),
      catch: (cause) => new TreeFileUnscannableError({ file: from, cause }),
    });
    if (scanned instanceof Error) {
      // A wrapped engine throw carries `cause`; a returned truncation is already the reason.
      const cause = scanned.cause;
      const reason =
        cause === undefined
          ? scanned.message
          : cause instanceof Error
            ? `${cause.name}: ${cause.message}`
            : String(cause);
      errors.push({
        code: "UNSCANNABLE_SOURCE",
        specifier: "",
        message: cause === undefined ? `"${from}": ${reason}` : `${scanned.message} — ${reason}`,
        line: 1,
        column: 1,
        file: from,
      });
      continue;
    }
    for (const error of scanned) errors.push({ ...error, file: from });
  }
  return errors;
}
