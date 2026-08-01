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
 * (task-12 review round 3, Important: proven by running both names through Bun directly —
 * Bun executes each as TypeScript identically to `lib/mod.ts`). Here `.ts` gives back `.ts`,
 * not `""`.
 */
function extensionOf(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  const name = slash === -1 ? relPath : relPath.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/**
 * Known-DATA extensions — the ONLY extensions {@link isCodeFile} treats as non-code. This is a
 * DENYLIST, not an allowlist of known-code extensions (rounds 1 and 2's shape) — a deliberate
 * reversal (task-12 review round 3, Important). An allowlist's UNKNOWN case defaults to "not
 * code", and at both of this module's enforcement points that default points the UNSAFE way:
 * an extension nobody thought to add (round 2's own `.mts`/`.cts` gap), a dotfile whose whole
 * name IS an extension (`.ts`), or a file with no extension at all (`lib/README`, which Bun
 * also executes as TypeScript when run directly) would each silently escape both the scan
 * loop (its own forbidden import/`eval` never seen — a SILENT bypass) and `effectiveHas` (an
 * unscanned resolution target treated as safe — also SILENT). A denylist's unknown case
 * defaults to "code" instead, so the exact same three gaps become: the scan loop tokenizes a
 * file that turns out to hold no import syntax at all (a no-op — nothing fires), or
 * `effectiveHas` demands the file's own text be present in `files` before a relative import
 * may resolve to it (a LOUD, fixable `UNRESOLVED_IMPORT`). Both of those are a refusal an
 * author can see and correct (rename the file, or extend this list); neither is a bypass
 * nobody is ever told about.
 *
 * This is weighed directly against the false-fatal risk the flip reopens: a genuine data
 * asset whose extension is absent from this list gets tokenized as JS/TS, so content that
 * merely happens to spell `eval`/`require`/an import keyword could trip a false violation
 * (exactly the class round 1 closed for `.md`/`.json`, but only for extensions ON this list).
 * That risk is accepted deliberately — a loud, wrong refusal on an asset is recoverable; a
 * silent pass on a real forbidden import is not recoverable at all, because nothing ever told
 * anyone it happened. THIS LIST IS NOT EXHAUSTIVE BY DESIGN: anything absent from it defaults
 * to "code", which is the safe direction here, so completeness of this list only affects how
 * much ordinary, legitimate asset content gets needlessly tokenized — never whether a real
 * violation goes unseen. Extend it as real, false-fatal-prone asset types are found; there is
 * no requirement to enumerate every possible non-code extension up front.
 */
const DATA_EXTENSIONS = new Set([
  ".json",
  ".md",
  ".markdown",
  ".txt",
  ".yml",
  ".yaml",
  ".toml",
  ".lock",
  ".css",
  ".html",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".map",
]);

/**
 * True for a tree-relative path this module treats as potentially holding executable JS/TS
 * syntax — imports, `eval`/`Function`, `require`, re-exports — i.e. every path whose own
 * extension ({@link extensionOf}) is NOT in {@link DATA_EXTENSIONS}. Used at BOTH of this
 * module's enforcement points (rounds 1 through 3 — one predicate, so none of them can ever
 * disagree about what "code" means):
 *
 * 1. the scan loop below must SKIP a non-code file even when its text sits in `input.files`,
 *    because feeding prose or JSON through a JS/TS tokenizer risks a false fatal on content
 *    that merely happens to spell a banned identifier (round 1's `.md`/`.json` fix);
 * 2. `effectiveHas` below must REQUIRE a code file's presence in `files` before trusting a
 *    resolution to it, because any file this predicate calls "code" can itself hide a further
 *    forbidden import this pass never read (task-11 review, Important 2's hazard).
 *
 * A genuinely non-code target (anything {@link DATA_EXTENSIONS} names) needs neither: it
 * carries no import syntax to miss, so requiring its presence in `files` (point 2) or
 * scanning its bytes as if it were code (point 1) would each manufacture a fatal out of a
 * file's mere existence or content, never out of anything actually wrong with it.
 */
function isCodeFile(relPath: string): boolean {
  return !DATA_EXTENSIONS.has(extensionOf(relPath));
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
 * THE CONTRACT (task-12 review — see the plan's red-debt ledger, item 3, and rounds 1-3's own
 * findings): `input.has` is the caller's whole-tree inventory — it is legitimately broader
 * than `input.files`, whose keys are only the files THIS pass was given source text for.
 * `store`'s `listTree` enumerates every file under `design/` regardless of extension, so a
 * real tree legitimately contains `.json`/`.md`/`.svg` files a page may resolve a relative
 * import to (design §6 places no extension restriction on a resolution TARGET, only on the
 * extensionless PROBE) without ever needing their text scanned — {@link isCodeFile} draws that
 * line on extension, not on presence. Only a CODE resolution target is held to the stricter
 * "must also be a key in `files`" bar, because only that kind of file could itself hide a
 * further forbidden import this pass never read. A caller that narrows `has` down to exactly
 * `files`'s own keys (Task 11's original, since-revised draft) would turn every legitimate
 * cross-file import of a non-code tree file into a fatal purely because of its presence in the
 * tree, unrelated to anything wrong with it — the same class of defect as Task 9's
 * byte-comparison, which bricked two user commands by rejecting valid input. `effectiveHas`
 * below is the enforcement of this narrower, honest invariant: a code resolution target absent
 * from `files` still reports `UNRESOLVED_IMPORT` (Important 2's hazard stays fatal for every
 * extension NOT in {@link DATA_EXTENSIONS}, matched case-insensitively and including dotfiles
 * and extensionless names — round 3 closed the gaps rounds 1 and 2 each left open), but
 * nothing else does. `runTreeImports` (`gate/model/gate.ts`) is the caller this was written
 * for: `has` is backed by the whole-tree `treePaths`, `files` by whatever text this particular
 * turn's Gate run actually holds.
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
