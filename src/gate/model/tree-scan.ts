import type { ImportScanError } from "./import-scan";
import { scanImportAllowlist, scanModuleEdges } from "./import-scan";

export { scanModuleEdges };

/**
 * Run the AUTHORITATIVE allowlist ({@link scanImportAllowlist}) over every file of a tree,
 * tagging each error with the tree-relative path it came from (design §6, §8 step 4). This is
 * the point of the whole-tree scan, not merely a convenience: a forbidden import in a shared
 * module — `lib/theme.ts`, reached by every page that imports it — compromises every page that
 * reaches it, so it must be caught even when the file is scanned on its own, with no page ever
 * mentioned. `scanTreeImports` does no closure walking and does not care whether any entry
 * actually reaches a given file; it scans every file `input.files` names, unconditionally,
 * which is exactly the property that makes an orphaned shared module's own bad import
 * un-missable.
 *
 * INVARIANT this function ENFORCES, not merely assumes (task-11 review, Important 2): a
 * specifier may resolve only to a path THIS SAME PASS actually read the source of.
 * `input.has` is the caller's inventory check — it is allowed to be broader than `input.files`,
 * e.g. Task 12's own `runTreeImports` backs `has` with the WHOLE tree's file list
 * (`treePaths`) while `files` is whatever this particular pass was given source text for. If a
 * caller ever supplies a `files` narrower than what `has` affirms — `files` missing an entry
 * `has` still says exists, say because an upstream read step skipped it — trusting `has` alone
 * would let a specifier resolve to a real inventory entry this scan never itself read, exactly
 * the "a closure built from a different reading than the allowlist's is exactly the shape that
 * lets an unscanned module load" hazard `import-scan.ts`'s own module doc warns about, just at
 * this layer instead of the closure layer. `effectiveHas` below closes it by construction:
 * `input.has` is intersected with `input.files`'s own keys, so a resolution can only ever
 * succeed against a file this exact call scanned, never merely one the caller's separate
 * inventory happens to know about. TASK 12 MUST SATISFY THIS: its `runTreeImports` passes
 * `has` backed by the whole-tree `treePaths` and `files` populated by its own tree read — the
 * two must already agree in the well-formed case, so this enforcement is a safety net there,
 * not a behavior change, but it will silently downgrade a resolvable import to
 * `UNRESOLVED_IMPORT` the moment the two ever disagree, which is the correct, honest outcome.
 */
export function scanTreeImports(input: {
  readonly files: ReadonlyMap<string, string>;
  readonly has: (relPath: string) => boolean;
}): readonly (ImportScanError & { readonly file: string })[] {
  const effectiveHas = (relPath: string) => input.has(relPath) && input.files.has(relPath);
  const errors: (ImportScanError & { readonly file: string })[] = [];
  for (const [from, source] of input.files) {
    for (const error of scanImportAllowlist(source, { from, has: effectiveHas })) {
      errors.push({ ...error, file: from });
    }
  }
  return errors;
}
