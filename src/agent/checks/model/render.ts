import { DESIGN_DIRNAME } from "entities/design-tree";
import type { PageSlug } from "entities/page";

import type { DesignCheckErrorV1, DesignCheckReportV1, DesignCheckWarningV1 } from "../types";

/**
 * Rendering one design check as the text `check_design` hands back to the agent.
 *
 * AN EXPLICITLY DUPLICATED RENDERER, AND HERE IS WHY (Task 12, Step 4's own instruction to say
 * which and why, at the site). The retry fold — `core/turns/model/prompt.ts`'s
 * `formatGateError`/`formatGateWarning`/`formatBlockedPages`/`toWorkspacePath` — is the one
 * existing place a Gate diagnostic becomes prose an agent will act on, and its line format is
 * what this module reproduces CHARACTER FOR CHARACTER:
 *
 *     - [kind/code] in design/pages/home.tsx line 7:22 [blocks: home]: message
 *     - [nondeterministic-time] in design/lib/elapsed.ts line 3: message
 *
 * It cannot be REUSED from here. Those functions are module-private to
 * `core/turns/model/prompt.ts` and, even if they were exported, they live under `core`'s
 * INTERNALS — and `agent` reaches `core` only through `core/ports`, never past it. The shared
 * tier this module belongs to (`checks`, `confinement`, `session`, `health`, `run`) goes further
 * and imports no `core` at all, which is the same wall that makes `../types.ts` declare its own
 * port. The alternative to duplicating the format would be inventing a THIRD vocabulary for the
 * same diagnostics, which is strictly worse: the agent would read one shape mid-attempt and a
 * different shape in the retry prompt for the identical fact.
 *
 * WHAT IS SHARED RATHER THAN COPIED: `DESIGN_DIRNAME`, imported from `entities/design-tree`
 * exactly as `prompt.ts` imports it, so the tree-relative -> workspace-relative translation
 * cannot drift by a renamed directory. `entities` is a ring both `core` and `agent` may import.
 *
 * WHAT DELIBERATELY DIFFERS, AND IS NOT DRIFT: the SECTION HEADERS. The retry fold's headers
 * say "Gate rejected the previous attempt" — which would be a lie here, because nothing has
 * been rejected: this is a check the agent chose to run mid-attempt. The same reasoning
 * `foldSurvivingWarnings` applies to its own header ("a survivor is not a rejection") applies
 * here, one step further: a self-check is not a verdict at all.
 *
 * WHICH WARNINGS RENDER, taken from the retry fold rather than re-decided:
 * `nondeterministic-time`/`nondeterministic-randomness` under one header, `import-cycle`/
 * `dead-module` under another, and `dropped-id`/`unpointed-element`/`unlisted-navigation` not
 * rendered at all — they are UI-contract advisories with no bearing on whether the Gate would
 * reject. Read `core/turns/model/prompt.ts`'s header for the full account; this file follows it
 * rather than restating the argument.
 *
 * ONE DELIBERATE DIVERGENCE, AND IT IS AN ADDITION RATHER THAN A REWORDING: `silencing-any`
 * DOES render here, under its own header, although the retry fold excludes it alongside the
 * three above. The fold's reason for excluding it — "no bearing on a Gate REJECTION retry" — is
 * true of the fold and false of this tool, because the two are read at different moments. The
 * fold is post-hoc: the turn was already rejected, and nothing the agent does next can change
 * that verdict. THIS tool is a target the agent optimizes against before finishing, and the
 * cheapest way to make a `TS7006` disappear from its output is to write `: any` — which
 * converts "a diagnostic the Gate DID catch" into "a crash it cannot" (`gate/model/lints.ts`'s
 * `lintSilencingAny`, quoted in `core/ports/gate-runner.ts`'s own kind list). Reporting the
 * type error and then calling the laundered version clean would make this tool actively teach
 * the laundering. The LINE FORMAT is identical to every other warning; only the selection
 * differs, so this is not a third vocabulary.
 */

/** The two non-determinism kinds — `core/turns/model/prompt.ts`'s `DETERMINISM_WARNING_KINDS`. */
const DETERMINISM_WARNING_KINDS: ReadonlySet<string> = new Set([
  "nondeterministic-time",
  "nondeterministic-randomness",
]);

/** The two whole-tree graph kinds — `core/turns/model/prompt.ts`'s `GRAPH_WARNING_KINDS`. */
const GRAPH_WARNING_KINDS: ReadonlySet<string> = new Set(["import-cycle", "dead-module"]);

/** The one kind this renderer shows and the retry fold does not — see this file's header. */
const SILENCING_WARNING_KINDS: ReadonlySet<string> = new Set(["silencing-any"]);

/**
 * Every warning kind this renderer puts under a header, and every kind it deliberately drops.
 *
 * EXPORTED SO THE OMISSION CANNOT GO SILENT. These sets are keyed by STRING, not by
 * `GateWarningKindV1` — this shared-tier module imports no `core`, so the union is not in scope
 * here (see `../types.ts`). A rename like Task 4's own `unguarded-timer` ->
 * `nondeterministic-time` would therefore leave a stale literal below and quietly drop a whole
 * section, with no type error anywhere.
 *
 * `entrypoint/model/design-checker.test.ts` closes that gap from the one place that CAN see both
 * rings: it enumerates `GateWarningKindV1` exhaustively (a `Record<GateWarningKindV1, true>`, so
 * an added or renamed kind fails the typecheck there) and asserts every kind is in exactly one of
 * these two sets, and that neither set names a kind the Gate does not produce.
 */
export const DESIGN_CHECK_RENDERED_WARNING_KINDS: ReadonlySet<string> = new Set([
  ...DETERMINISM_WARNING_KINDS,
  ...GRAPH_WARNING_KINDS,
  ...SILENCING_WARNING_KINDS,
]);

/**
 * The retry fold's own UI-contract exclusions, carried verbatim — see this file's header — plus
 * `module-scope-tokens` (design-systems §4.5, added alongside Task 8): a token-read-placement
 * advisory in the same family as `dropped-id`/`unpointed-element`/`unlisted-navigation`, not a
 * determinism/graph finding and not the specific type-suppression escape hatch `silencing-any`
 * was added here to catch. No incident drove giving it its own header, so it follows the retry
 * fold's own implicit treatment (neither `DETERMINISM_WARNING_KINDS` nor `GRAPH_WARNING_KINDS`
 * names it in `core/turns/model/prompt.ts` either) rather than inventing one.
 */
export const DESIGN_CHECK_EXCLUDED_WARNING_KINDS: ReadonlySet<string> = new Set([
  "dropped-id",
  "unpointed-element",
  "unlisted-navigation",
  "module-scope-tokens",
]);

const DESIGN_TREE_PREFIX = `${DESIGN_DIRNAME}/`;

/**
 * A Gate diagnostic's TREE-relative `file` as the agent must type it: WORKSPACE-relative. The
 * agent's cwd is the turn workspace root and the tree is staged one level down under `design/`,
 * so a bare `pages/alarm.tsx` typed into `Read` is an ENOENT — measured, and the reason
 * `core/turns/model/prompt.ts`'s own `toWorkspacePath` exists. Same guard against
 * double-prefixing, for the same reason: a silent `design/design/…` would be worse than the
 * check.
 */
function toWorkspacePath(file: string): string {
  return file.startsWith(DESIGN_TREE_PREFIX) ? file : `${DESIGN_TREE_PREFIX}${file}`;
}

function formatPosition(line: number | undefined, column: number | undefined): string {
  if (line === undefined) return "";
  return column === undefined ? ` line ${line}` : ` line ${line}:${column}`;
}

/** The pages a whole-tree diagnostic is attributed to — the one fact the agent cannot derive,
 *  having no import graph. Omitted entirely when the set is empty, never printed as `[]`. */
function formatBlockedPages(blockedPages: readonly PageSlug[] | undefined): string {
  if (blockedPages === undefined || blockedPages.length === 0) return "";
  return ` [blocks: ${blockedPages.join(", ")}]`;
}

function formatLocation(file: string | undefined): string {
  return file === undefined ? "" : ` in ${toWorkspacePath(file)}`;
}

function formatError(error: DesignCheckErrorV1): string {
  return `- [${error.kind}/${error.code}]${formatLocation(error.file)}${formatPosition(error.line, error.column)}${formatBlockedPages(error.blockedPages)}: ${error.message}`;
}

function formatWarning(warning: DesignCheckWarningV1): string {
  return `- [${warning.kind}]${formatLocation(warning.file)}${formatPosition(warning.line, warning.column)}${formatBlockedPages(warning.blockedPages)}: ${warning.message}`;
}

const ERRORS_HEADER =
  "The Gate would REJECT this design tree as it stands. Fix every one of these before you finish:";
const DETERMINISM_WARNINGS_HEADER =
  "Non-deterministic code (breaks Export/replay). Remove the wall-clock/randomness dependency:";
const GRAPH_WARNINGS_HEADER =
  "Import-graph findings. A cycle is legal but risky; an unreached module is never auto-deleted, but check whether it should still exist:";
const SILENCING_WARNINGS_HEADER =
  "These `any`s suppress the type checker rather than satisfying it — a diagnostic the Gate would have caught becomes a crash it cannot. Type them properly instead:";

/** The one sentence a caller may test for to mean "this check found nothing fatal". Exported so
 *  no test has to re-spell it, and so a reworded clean answer fails loudly. */
export const DESIGN_CHECK_CLEAN_HEADLINE = "No problems found in the design tree.";

/**
 * WHAT A CLEAN CHECK DOES AND DOES NOT PROVE, stated to the agent every time it gets one.
 * The check runs the manifest slice and the whole-tree pass; it does not run the per-page
 * pipeline, whose smoke render spawns a host child process per page. Selling a clean check as
 * "the Gate will accept this" would be the second-worst lie this tool could tell, right behind
 * rendering a `TYPE_CHECK_UNAVAILABLE` fatal as a pass.
 */
const CLEAN_SCOPE_NOTE =
  "This check ran the manifest, the import allowlist, the import graph, every page's closure, " +
  "and one TypeScript program over the whole tree. It did NOT run the page contract or the " +
  "smoke render, so a clean check is strong evidence, not a guaranteed Gate pass.";

/** Renders one report as the tool's reply. A report with nothing fatal AND nothing worth
 *  reporting renders as {@link DESIGN_CHECK_CLEAN_HEADLINE} plus its scope note, and nothing
 *  else — never an empty section header the agent would read as a truncated list. */
export function renderDesignCheckReport(report: DesignCheckReportV1): string {
  const sections: string[] = [];

  if (report.errors.length > 0) {
    sections.push([ERRORS_HEADER, ...report.errors.map(formatError)].join("\n"));
  }

  const determinism = report.warnings.filter((w) => DETERMINISM_WARNING_KINDS.has(w.kind));
  if (determinism.length > 0) {
    sections.push([DETERMINISM_WARNINGS_HEADER, ...determinism.map(formatWarning)].join("\n"));
  }

  const graph = report.warnings.filter((w) => GRAPH_WARNING_KINDS.has(w.kind));
  if (graph.length > 0) {
    sections.push([GRAPH_WARNINGS_HEADER, ...graph.map(formatWarning)].join("\n"));
  }

  const silencing = report.warnings.filter((w) => SILENCING_WARNING_KINDS.has(w.kind));
  if (silencing.length > 0) {
    sections.push([SILENCING_WARNINGS_HEADER, ...silencing.map(formatWarning)].join("\n"));
  }

  if (sections.length === 0) return `${DESIGN_CHECK_CLEAN_HEADLINE}\n\n${CLEAN_SCOPE_NOTE}`;
  return sections.join("\n\n");
}

/**
 * Renders a check that could not run AT ALL. Deliberately loud about not being a pass: the
 * failure mode this wording exists to prevent is an agent reading "no problems listed" as "no
 * problems", finishing on it, and being rejected by a Gate that did run.
 */
export function renderDesignCheckFailure(error: Error): string {
  return [
    `The design check could not run: ${error.message}`,
    "",
    "This is NOT a clean result — nothing about the design tree was verified. Fix whatever the " +
      "message names if it is yours to fix; otherwise finish on the evidence you have and say " +
      "in your reply that the self-check was unavailable.",
  ].join("\n");
}
