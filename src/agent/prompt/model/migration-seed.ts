/**
 * The synthesized first message of track 2 (design-tree design §12.2): "an ordinary turn seeded
 * with a synthesized message asking the agent to factor duplicated markup and logic into shared
 * modules". It runs through the same admission, staging, Gate, retry and apply path as any other
 * turn, so this file authors text and nothing else.
 *
 * Three properties the wording carries deliberately:
 *   - it states that the pages ALREADY WORK, so "nothing worth sharing" is a correct answer and
 *     the agent does not manufacture an abstraction to look useful;
 *   - it forbids a visual change, because the user asked to migrate a project, not to redesign it,
 *     and a turn that alters the rendering is one the user has to review and undo;
 *   - it names `design/` explicitly, because after the migration that is where every page lives
 *     and a shared module has nowhere else to go.
 *
 * Best-effort by design: if this turn fails, terminalizes, or produces something the user dislikes,
 * the project is exactly as track 1 left it — every page is still a self-contained file that is
 * valid under §5 and §6.
 */
export function migrationRefactorSeed(input: { readonly pageCount: number }): string {
  const pages = `${input.pageCount} page${input.pageCount === 1 ? "" : "s"}`;
  return [
    `This project was just migrated to the multi-file design tree. Its ${pages} now live under`,
    "design/ as self-contained files, exactly as they were before — nothing about them is broken.",
    "",
    "Read them and factor genuinely duplicated markup and logic into shared modules under design/",
    "(for example design/components/ or design/lib/), then import those modules from the pages.",
    "",
    "Keep every page's rendered output identical. Do not add, remove or rename a page, and do not",
    "change any page's visual design. If there is nothing worth sharing, say so and change nothing.",
  ].join("\n");
}
