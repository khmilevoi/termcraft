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
 */
export function scanTreeImports(input: {
  readonly files: ReadonlyMap<string, string>;
  readonly has: (relPath: string) => boolean;
}): readonly (ImportScanError & { readonly file: string })[] {
  const errors: (ImportScanError & { readonly file: string })[] = [];
  for (const [from, source] of input.files) {
    for (const error of scanImportAllowlist(source, { from, has: input.has })) {
      errors.push({ ...error, file: from });
    }
  }
  return errors;
}
