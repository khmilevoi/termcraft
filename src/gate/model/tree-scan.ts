import type { ImportScanError } from "./import-scan";
import { scanImportAllowlist, scanModuleEdges } from "./import-scan";

export { scanModuleEdges };

/**
 * Every extension design §6's import surface treats as executable JS/TS syntax — deliberately
 * BROADER than `entities/design-tree`'s `RESOLUTION_EXTENSIONS` (design §6's PROBE list for an
 * EXTENSIONLESS specifier, `.tsx`/`.ts` only, and stops there): an explicit-extension specifier
 * legally resolves to any real tree file "as written" (design §6), including a `.js`/`.jsx`/
 * `.mjs`/`.cjs` module the probe would never reach on its own, and every one of those can carry
 * a forbidden import, a re-export, a `require`, or an `eval`/`new Function` call exactly like a
 * `.ts`/`.tsx` file can (task-12 review round 1, Important 3 — the prior draft used
 * `RESOLUTION_EXTENSIONS` here directly, which silently re-opened the `.js` hole Important 2 of
 * the task-11 review had closed: `RESOLUTION_EXTENSIONS` answers "what does the PROBE try",
 * not "what counts as code", and conflating the two let `../lib/legacy.js` resolve cleanly
 * without ever being scanned).
 */
const CODE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"] as const;

/**
 * True for a tree-relative path that can itself contain executable JS/TS syntax — imports,
 * `eval`/`Function`, `require`, re-exports. Used at BOTH of this module's enforcement points
 * (task-12 review round 1, Importants 2 and 3 — one predicate, so the two can never disagree
 * about what "code" means):
 *
 * 1. the scan loop below must SKIP a non-code file even when its text sits in `input.files`,
 *    because feeding prose or JSON through a JS/TS tokenizer risks a false fatal on content
 *    that merely happens to spell a banned identifier (`"Do not use eval in pages."` inside a
 *    `.md` file tripped `EVAL_CALL` before this fix — the same class of defect as Task 9's
 *    byte-comparison, a guard rejecting valid input);
 * 2. `effectiveHas` below must REQUIRE a code file's presence in `files` before trusting a
 *    resolution to it, because a `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs` target can itself hide
 *    a further forbidden import this pass never read (task-11 review, Important 2's hazard).
 *
 * A non-code target (`.json`, `.md`, `.svg`, anything else `store`'s `listTree` enumerates
 * under `design/`) needs neither: it carries no import syntax to miss, so requiring its
 * presence in `files` (point 2) or scanning its bytes as if it were code (point 1) would each
 * manufacture a fatal out of a file's mere existence or content, never out of anything actually
 * wrong with it.
 */
function isCodeFile(relPath: string): boolean {
  return CODE_EXTENSIONS.some((extension) => relPath.endsWith(extension));
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
 * THE CONTRACT (task-12 review — see the plan's red-debt ledger, item 3, and round 1's
 * Importants 2/3): `input.has` is the caller's whole-tree inventory — it is legitimately
 * broader than `input.files`, whose keys are only the files THIS pass was given source text
 * for. `store`'s `listTree` enumerates every file under `design/` regardless of extension, so a
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
 * from `files` still reports `UNRESOLVED_IMPORT` (Important 2's hazard stays fatal — including
 * `.js`/`.jsx`/`.mjs`/`.cjs`, not only `.ts`/`.tsx`), but nothing else does. `runTreeImports`
 * (`gate/model/gate.ts`) is the caller this was written for: `has` is backed by the whole-tree
 * `treePaths`, `files` by whatever text this particular turn's Gate run actually holds.
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
