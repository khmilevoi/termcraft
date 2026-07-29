import { RESOLUTION_EXTENSIONS } from "entities/design-tree";

import type { ImportScanError } from "./import-scan";
import { scanImportAllowlist, scanModuleEdges } from "./import-scan";

export { scanModuleEdges };

/**
 * True for a tree-relative path this scan can only vouch for by having actually READ its
 * source: a `.ts`/`.tsx` file (design §6's own {@link RESOLUTION_EXTENSIONS} — the only two
 * extensions the tree treats as a probeable module) can itself contain further imports, so
 * resolving to one WITHOUT having scanned it would let its own forbidden imports load
 * unnoticed (task-11 review, Important 2's own hazard). Every other extension — `.json`,
 * `.md`, `.svg`, anything `store`'s `listTree` enumerates under `design/` — carries no import
 * syntax this scan would ever parse, so there is nothing of its own left unverified by not
 * having its text; requiring its presence in `files` too would only manufacture a fatal out of
 * a file's mere existence in the tree, never out of anything actually wrong with it.
 */
function isPotentialModule(relPath: string): boolean {
  return RESOLUTION_EXTENSIONS.some((extension) => relPath.endsWith(extension));
}

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
 * THE CONTRACT (task-12 review of the prior draft — see the plan's red-debt ledger, item 3):
 * `input.has` is the caller's whole-tree inventory — it is legitimately broader than
 * `input.files`, whose keys are only the files THIS pass was given source text for. `store`'s
 * `listTree` enumerates every file under `design/` regardless of extension, so a real tree
 * legitimately contains `.json`/`.md`/`.svg` files a page may resolve a relative import to
 * (design §6 places no extension restriction on a resolution TARGET, only on the extensionless
 * PROBE) without ever needing their text scanned — `isPotentialModule` above draws that line on
 * extension, not on presence. Only a `.ts`/`.tsx` resolution target is held to the stricter
 * "must also be a key in `files`" bar, because only that kind of file could itself hide a
 * further forbidden import this pass never read. A caller that narrows `has` down to exactly
 * `files`'s own keys (Task 11's original, since-revised draft) would turn every legitimate
 * cross-file import of a non-module tree file into a fatal purely because of its presence in
 * the tree, unrelated to anything wrong with it — the same class of defect as Task 9's
 * byte-comparison, which bricked two user commands by rejecting valid input. `effectiveHas`
 * below is the enforcement of this narrower, honest invariant: a `.ts`/`.tsx` resolution target
 * absent from `files` still reports `UNRESOLVED_IMPORT` (Important 2's hazard stays fatal), but
 * nothing else does. `runTreeImports` (`gate/model/gate.ts`) is the caller this was written
 * for: `has` is backed by the whole-tree `treePaths`, `files` by whatever text this particular
 * turn's Gate run actually holds.
 */
export function scanTreeImports(input: {
  readonly files: ReadonlyMap<string, string>;
  readonly has: (relPath: string) => boolean;
}): readonly (ImportScanError & { readonly file: string })[] {
  const effectiveHas = (relPath: string) =>
    input.has(relPath) && (input.files.has(relPath) || !isPotentialModule(relPath));
  const errors: (ImportScanError & { readonly file: string })[] = [];
  for (const [from, source] of input.files) {
    for (const error of scanImportAllowlist(source, { from, has: effectiveHas })) {
      errors.push({ ...error, file: from });
    }
  }
  return errors;
}
