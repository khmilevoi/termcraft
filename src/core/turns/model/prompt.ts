import * as errore from "errore";

import type { TurnAttempt } from "core/machines";
import type { EventPayloadByKindV1 } from "core/protocol";
import { DESIGN_DIRNAME } from "entities/design-tree";
import type { PageSlug } from "entities/page";

/**
 * Folding a rejected attempt's Gate diagnostics into the RETRY attempt's prompt
 * (kernel-command-contract §7.2's retry arc; master §6.3's determinism-warning vocabulary).
 *
 * Pure and port-free: `validation.ts` decides WHETHER a retry happens (Gate rejection,
 * `attempt < 4`) and hands this module exactly the diagnostics it emitted on
 * `turn.gateRejected` — this module only turns them into prompt text, and never re-derives
 * the retry decision itself.
 *
 * THE FRESHNESS BARRIER: diagnostics are meaningful ONLY for the attempt immediately after
 * the one Gate rejected — `nextAttempt === rejectedAttempt + 1`, §7.2's own increment rule
 * for a retry ("increments `attempt`"). Anything else (the same attempt again, a skipped
 * attempt, or a caller accidentally re-folding stale diagnostics from an earlier rejection
 * into a LATER attempt's prompt) is refused rather than silently rendered — a stale fold
 * would tell the agent to fix a problem in the wrong attempt's context.
 *
 * DETERMINISM WARNINGS: of Gate's ORIGINAL six warning kinds, exactly two are about
 * non-determinism (`nondeterministic-time`, `nondeterministic-randomness` — code that would
 * break Export/replay by depending on wall-clock time or unseeded randomness). The other four
 * (`dropped-id`, `unpointed-element`, `unlisted-navigation`, `silencing-any`) are UI-contract/
 * type-suppression warnings with no bearing on a Gate REJECTION retry, so they are
 * deliberately excluded from the fold entirely — not rendered under any header.
 *
 * RENAMED from `unguarded-timer`/`unguarded-randomness` (design-agent-feedback-loop repair,
 * Task 4, 2026-08-09): the old names promised a guard (an `isExport()` wrapper) that
 * `gate/model/lints.ts`'s `lintDeterminism` — a token scan with no scope analysis — has no way
 * to ever observe clearing. See that function's own doc comment for the measured turn this
 * fixes.
 *
 * GRAPH WARNINGS (design-tree phase 2 Task 4): `import-cycle`/`dead-module` are NEITHER
 * determinism warnings NOR one of the four excluded above — `DETERMINISM_WARNING_KINDS` stays
 * exactly the two kinds it always named, unchanged by this addition, per this file's own
 * name for that set. But unlike the excluded four, a cycle or an unreached module IS worth the
 * agent's attention on a retry, and neither is derivable from the source the agent already has
 * (an import graph is exactly what the agent lacks) — so both render under their own header.
 *
 * ONE PATH VOCABULARY IN THE RENDERED PROMPT (design-tree feedback-loop repair, Task 3):
 * `GateError.file`/`GateWarning.file` are TREE-relative (relative to `design/`) throughout
 * Gate's own vocabulary — the closure index, the inventory, the manifest's own `entry` values
 * all correctly stay that way. But the AGENT reads THIS prompt and types paths into its own
 * tools, which are WORKSPACE-relative (its cwd is the turn workspace root; the tree is staged
 * one level down, under `design/`). `formatGateError`/`formatGateWarning` are the one place a
 * diagnostic stops being a DTO and becomes prose the agent will act on, so `toWorkspacePath` is
 * routed through both of them, right there — see that function's own doc for the measured
 * defect this fixes.
 *
 * `blockedPages` is deliberately UNTOUCHED by this translation (see `formatBlockedPages`'s own
 * doc): it renders PAGE SLUGS, not file paths, and prefixing a slug with `design/` would
 * fabricate a path that names nothing real.
 */

export type TurnGateDiagnosticsV1 = EventPayloadByKindV1["turn.gateRejected"]["diagnostics"];
type TurnGateErrorDtoV1 = TurnGateDiagnosticsV1["errors"][number];
type TurnGateWarningDtoV1 = TurnGateDiagnosticsV1["warnings"][number];
type GateWarningKindV1 = TurnGateWarningDtoV1["kind"];

export class StaleGateDiagnosticsError extends errore.createTaggedError({
  name: "StaleGateDiagnosticsError",
  message:
    "diagnostics from rejected attempt $rejectedAttempt cannot fold into attempt $nextAttempt's prompt — only attempt $rejectedAttempt + 1 may consume them",
}) {}

export interface TurnGateFoldInputV1 {
  /** The attempt Gate rejected — whose diagnostics these are. */
  readonly rejectedAttempt: TurnAttempt;
  /** The attempt this fold is FOR. */
  readonly nextAttempt: TurnAttempt;
  readonly diagnostics: TurnGateDiagnosticsV1;
}

/** Gate's own two non-determinism warning kinds (master §6.3) — see this file's header. */
const DETERMINISM_WARNING_KINDS: ReadonlySet<GateWarningKindV1> = new Set([
  "nondeterministic-time",
  "nondeterministic-randomness",
]);

/** Design-tree phase 2 Task 4's two whole-tree graph warnings — see this file's header. */
const GRAPH_WARNING_KINDS: ReadonlySet<GateWarningKindV1> = new Set([
  "import-cycle",
  "dead-module",
]);

function isDeterminismWarning(warning: TurnGateWarningDtoV1): boolean {
  return DETERMINISM_WARNING_KINDS.has(warning.kind);
}

function isGraphWarning(warning: TurnGateWarningDtoV1): boolean {
  return GRAPH_WARNING_KINDS.has(warning.kind);
}

function formatPosition(line: number | null, column: number | null): string {
  if (line === null) return "";
  return column === null ? ` line ${line}` : ` line ${line}:${column}`;
}

const DESIGN_TREE_PREFIX = `${DESIGN_DIRNAME}/`;

/**
 * A Gate diagnostic's TREE-relative `file` as the agent must type it: workspace-relative.
 * The one translation point between the two vocabularies (see this file's header).
 *
 * THE ONE PLACE THE TWO PATH VOCABULARIES MEET (defect fix, 2026-08-09).
 *
 * Gate speaks TREE-relative throughout: `GateError.file`/`GateWarning.file` carry
 * `entryRelPath` (`gate/adapters/gate-runner.ts`'s display name), which is relative to
 * `design/`. The AGENT's tools take WORKSPACE-relative paths — its cwd is the turn workspace
 * root (`agent/claude/query/model/query-options.ts` passes `cwd: task.workspacePath`), and the
 * tree is staged one level down under `design/` (`store/sandbox/model/staging-store.ts`).
 *
 * MEASURED: a retry prompt rendered `in pages/alarm.tsx`; the agent typed exactly that into
 * `Read` and got ENOENT, then recovered with `Glob **\/*`. Three of the run's five ENOENTs came
 * from this one line of text.
 *
 * The translation happens HERE, at the boundary where a diagnostic stops being a DTO and
 * becomes something the agent will type — not in the Gate, whose own tree-relative vocabulary
 * is correct for every other consumer (the closure index, the inventory, the manifest's own
 * `entry` values). `DESIGN_DIRNAME` is imported rather than duplicated: `core` imports
 * `entities/` (`candidate.ts` already imports this exact constant), so there is no pair to
 * keep in sync and no drift test to write.
 *
 * Guarded against double-prefixing: nothing produces an already-prefixed `file` today, but a
 * silent `design/design/pages/a.tsx` would be a worse failure than this `startsWith` check.
 */
function toWorkspacePath(file: string): string {
  return file.startsWith(DESIGN_TREE_PREFIX) ? file : `${DESIGN_TREE_PREFIX}${file}`;
}

/**
 * Which pages a whole-tree diagnostic is attributed to, rendered for the agent.
 *
 * ADDED (task-14 review round 1, Important 2). `blockedPages` was carried across the DTO and
 * the wire schema so it could reach the agent's retry prompt — and then this renderer, which
 * IS that prompt, listed fields by name and dropped it, so the stated purpose was never
 * achieved and two comments claimed it was. Measured before the fix: the folded prompt for a
 * `FORBIDDEN_IMPORT` in `lib/theme.ts` mentioned none of `home`/`about`/`calendar`.
 *
 * It is exactly the fact the agent cannot derive for itself: a diagnostic names the MODULE
 * (`lib/theme.ts`), and the agent has no import graph with which to work out which pages that
 * module broke. Absent (or empty) when the diagnostic names no page, in which case the clause is
 * omitted rather than rendered as an empty list.
 *
 * The field's meaning WIDENED (design-tree phase 2 Task 3) from "the pages whose closure the pass
 * could not complete here" to "the pages whose closure contains this file", so a shared module's
 * TYPE error now renders the same clause a forbidden import already did. The renderer needed no
 * change for that, and the wording here is corrected so it does not go on describing only half of
 * what it prints — `core/ports/gate-runner.ts`'s `GateErrorV1.blockedPages` is the full account.
 */
function formatBlockedPages(blockedPages: readonly PageSlug[] | null): string {
  if (blockedPages === null || blockedPages.length === 0) return "";
  return ` [blocks: ${blockedPages.join(", ")}]`;
}

function formatGateError(error: TurnGateErrorDtoV1): string {
  const location = error.file === null ? "" : ` in ${toWorkspacePath(error.file)}`;
  return `- [${error.kind}/${error.code}]${location}${formatPosition(error.line, error.column)}${formatBlockedPages(error.blockedPages)}: ${error.message}`;
}

/**
 * `file` renders the same way {@link formatGateError}'s `location` does — an unnamed warning
 * omits the clause entirely rather than printing an empty `in `. Absence is now the RARE case
 * (`gate/types.ts`'s `GateWarning.file` doc, `core/ports/gate-runner.ts`'s `GateWarningV1.file`
 * doc): a statement about the TREE, not about a file, the same distinction
 * {@link formatBlockedPages} draws for a file-less `GateErrorV1`. Every warning a per-page run
 * (`gate/model/gate.ts`) or the whole-tree pass (`gate/adapters/gate-runner.ts`) actually
 * produces today carries one — this guard exists for the producer that legitimately does not,
 * not because omission is expected of the ones that do.
 */
function formatGateWarning(warning: TurnGateWarningDtoV1): string {
  const location = warning.file === null ? "" : ` in ${toWorkspacePath(warning.file)}`;
  return `- [${warning.kind}]${location}${formatPosition(warning.line, warning.column)}: ${warning.message}`;
}

const GATE_ERRORS_HEADER =
  "Gate rejected the previous attempt with the following errors. Fix every one before anything else:";
const DETERMINISM_WARNINGS_HEADER =
  "Gate also flagged non-deterministic code (breaks Export/replay). Remove the wall-clock/randomness dependency:";
/** Design-tree phase 2 Task 4 — see this file's header for why these two render separately from the determinism section above rather than folding into it or being dropped like the other four. */
const GRAPH_WARNINGS_HEADER =
  "Gate also flagged the following import-graph issues. A cycle is legal but risky; an unreached module is never auto-deleted, but check whether it should still exist:";

/**
 * Renders `input.diagnostics` into prompt text for `input.nextAttempt`, or refuses with
 * {@link StaleGateDiagnosticsError} when the freshness barrier does not hold. An empty
 * result (`""`) means there is nothing worth folding — the caller should not append a blank
 * section (see {@link appendPromptFold}).
 */
export function foldGateDiagnosticsIntoPrompt(
  input: TurnGateFoldInputV1,
): StaleGateDiagnosticsError | string {
  if (input.nextAttempt !== input.rejectedAttempt + 1) {
    return new StaleGateDiagnosticsError({
      rejectedAttempt: input.rejectedAttempt,
      nextAttempt: input.nextAttempt,
    });
  }

  const sections: string[] = [];

  if (input.diagnostics.errors.length > 0) {
    sections.push(
      [GATE_ERRORS_HEADER, ...input.diagnostics.errors.map(formatGateError)].join("\n"),
    );
  }

  const determinismWarnings = input.diagnostics.warnings.filter(isDeterminismWarning);
  if (determinismWarnings.length > 0) {
    sections.push(
      [DETERMINISM_WARNINGS_HEADER, ...determinismWarnings.map(formatGateWarning)].join("\n"),
    );
  }

  const graphWarnings = input.diagnostics.warnings.filter(isGraphWarning);
  if (graphWarnings.length > 0) {
    sections.push([GRAPH_WARNINGS_HEADER, ...graphWarnings.map(formatGateWarning)].join("\n"));
  }

  return sections.join("\n\n");
}

/** Appends a non-empty fold to `baseUserMessage`, separated by a blank line; an empty fold leaves the message untouched. */
export function appendPromptFold(baseUserMessage: string, fold: string): string {
  if (fold.length === 0) return baseUserMessage;
  return `${baseUserMessage}\n\n${fold}`;
}
