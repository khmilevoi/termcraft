import { designSystemMigrationSeed } from "./design-system-seed";
import { migrationRefactorSeed } from "./migration-seed";

/**
 * The format-1 origin's combined migration seed (design-tree §12.2 track 2 + design-systems §9).
 * A format-1 project's migration carries TWO tracks — the shared-module refactor
 * ({@link migrationRefactorSeed}) and the design-system rewrite ({@link designSystemMigrationSeed})
 * — and `bootstrap.ts` seeds the composer with both, since a format-2 origin never sees the
 * refactor seed at all (it already has the multi-file tree).
 *
 * THE BRIDGE SENTENCE IS LOAD-BEARING, not decoration. Concatenated bare, the two seeds
 * contradict each other: `migrationRefactorSeed` tells the agent to factor duplicated markup INTO
 * `design/components/`, while `designSystemMigrationSeed`'s instruction 2 tells it to move a
 * shared component OUT of `design/components/` and into `design/system/components/`. A literal
 * reading of the unjoined text extracts to the first location, then relocates to the second — a
 * needless two-step detour with no textual signal that the two instructions are talking about the
 * SAME move. The bridge below names the single real destination up front so the agent does the
 * extraction and the relocation as one move, never two.
 */
export function formatOneMigrationSeed(input: { readonly pageCount: number }): string {
  return [migrationRefactorSeed(input), "", BRIDGE, "", designSystemMigrationSeed(input)].join(
    "\n",
  );
}

const BRIDGE = [
  "Do the sharing above and the design-system rewrite below as ONE move, not two: if a component",
  "you are factoring out turns out to be shared between pages, put it directly in",
  "design/system/components/ and declare it in design-system.json — never extract it into",
  "design/components/ first and relocate it there afterward.",
].join("\n");
