import { wrap } from "@reatom/core";

import {
  MAX_TURN_ATTEMPT,
  type StateMachine,
  type TurnAction,
  type TurnAttempt,
  type TurnState,
  canRetryAfterGate,
} from "core/machines";
import type { PublishableEventV1 } from "core/mailbox";
import type {
  GateClosureV1,
  GateErrorV1,
  GatePageDescriptorV1,
  GateRunner,
  GateWarningKindV1,
  GateWarningV1,
  ManifestSliceV1,
} from "core/ports";
import type { EventPayloadByKindV1, FailureDtoV1, UUIDv7 } from "core/protocol";
import type { DesignFileEntryV1, DesignTreeInventoryV1 } from "entities/design-tree";
import { log, trace } from "infrastructure/debug-log";

import { selectChangedPages } from "./candidate";

/**
 * Gate validation over one frozen candidate — the `validating` sub-phase's own work
 * (kernel-command-contract §7.2 line 238 prose; master §6.3 step 1; §9 row for
 * `turn.gateRejected`, KCC:801).
 *
 * ENTRY ASSUMED, NOT DRIVEN: this file assumes the machine is already `validating`
 * (`candidate.ts`'s own `candidateCaptured` job) and drives only the ONE transition its own
 * outcome can legally require — `retryAfterGate` (`validating -> workspace-ready`), and only
 * while `attempt < 4` (`canRetryAfterGate`, `core/machines`). On a PASS or an EXHAUSTED
 * rejection it drives no transition at all: `beginFinalization` (pass) and
 * `beginTerminalization` (exhausted) both belong to "whichever caller decided" — the same
 * documented split `finalize.ts`/`terminalize.ts` use for the identical shape of decision.
 *
 * ORDER (design §8's own step numbering): the manifest-slice check (step 1) runs EXACTLY ONCE
 * PER TURN; the WHOLE-TREE PASS (`GateRunner.runTree` — the import allowlist of step 4, closure
 * resolution, and the one `tsc` program of step 5) runs EXACTLY ONCE PER TURN immediately after
 * it; only then does every manifest entry run the per-page `GateRunner.runPage` pipeline.
 * Neither once-per-turn stage is ever interleaved with, or repeated inside, the per-page loop.
 * Every entry then runs `runPage` regardless of whether an earlier one already failed, so a
 * rejection carries the COMPLETE set of diagnostics across every page in one report, not just
 * the first failure.
 *
 * ONE STAGE INSIDE THAT LOOP IS SCOPED, AND ONLY ONE (design §8 step 8): the SMOKE RENDER runs
 * for a page only when its closure hash differs from the turn's send-time read set — a host
 * child process per page per attempt is the Gate's real cost, and a shared-module edit would
 * otherwise pay it for every page reaching that module, four times a turn. The page contract and
 * the determinism lints still judge every listed page. The decision is `selectChangedPages`'
 * (`./candidate`), called here rather than restated, so it is literally the same rule that
 * produces the turn's own `changedPages` report — see the `changedSlugs` computation below.
 *
 * WHAT FOLLOWS DESCRIBES THE CALLER, not the perimeter: this module calls the Gate, it is not
 * the Gate. The scan's own source coverage — a separate problem this file used to say was still
 * open — is closed by `gate/model/lexer.ts`'s invariant (no classification uncertainty may make
 * executable code invisible), measured against Bun's own parse by
 * `gate/model/lexer.oracle.test.ts`. The residual is design §5.8's dynamic-code ban, whose
 * KNOWN GAPS 1-4 are registered in the plan's red-debt ledger.
 *
 * THE IMPORT PERIMETER IS WIRED HERE FOR THE TURN (red-debt.md's SECURITY-CRITICAL must-wire;
 * task-14-supplement §1). `GateRunner.runTree` — the import allowlist and, inside it, design
 * §5.8's `eval`/`new Function` ban — had NO production caller before task 14: `runPage`
 * deliberately stopped scanning imports in task 12 (a shared module belongs to no single page,
 * so scanning per page both misses a module no page's own source is run against and reports a
 * shared violation once per reaching page). Between those two changes a page importing `lodash`,
 * calling `require("fs")`, `eval(...)`, `new Function(...)` or a dynamic `import()` passed the
 * whole Gate and reached the smoke render. The `runTree` call below is the fix.
 * `src/entrypoint/model/turn-import-perimeter.test.ts` proves it end to end against the REAL
 * `gate` adapter for each of those six forms placed in a SHARED module no page names directly;
 * the tests beside this file prove the call shape and the verdict rule against the port fake.
 * (`core/kernel/model/handlers/page-descriptors.ts` calls the same method on its own path, for
 * its own reason — it needs the pass's TYPE diagnostics to mark a page `"invalid"`. Two callers,
 * one method, no second reading of the tree.)
 *
 * THE VERDICT IS WHOLE-TREE, DELIBERATELY (task-12b review round 1, Minor M4 — task 14 owns
 * the choice). `isTrustedTarget` (`gate/model/tree-scan.ts`) treats "the path is a key in
 * `files`" as "this pass read that file's source", which is false for a file whose own scan
 * threw: an importer of it is then vouched for by a file nothing read. That is harmless only
 * while every consumer decides on `errors.length === 0` over the WHOLE tree, and it becomes a
 * fail-open the moment a caller attributes rejections per page or per file. This function
 * therefore keeps one flat verdict: ANY error from ANY stage — manifest slice, whole-tree
 * scan, or any page — rejects the turn. Nothing here filters by `GateErrorV1.file`, by
 * `blockedPages`, or by which page a diagnostic names. `blockedPages` is carried across the
 * DTO boundary for the AGENT's benefit (which pages a shared-module blocker actually blocked)
 * and RENDERED into the retry prompt by `prompt.ts`'s `formatBlockedPages`; it is never
 * consulted to decide the verdict. (Task-14 review round 1, Important 2: it was carried but
 * not rendered, so this sentence described an intent rather than a fact.)
 */

export interface TurnValidationDeps {
  readonly machine: StateMachine<TurnState, TurnAction>;
  readonly gateRunner: GateRunner;
  readonly publish: (event: PublishableEventV1<"turn.gateRejected">) => void;
}

export interface RunTurnValidationInputV1 {
  readonly turnId: UUIDv7;
  readonly attempt: TurnAttempt;
  /** The frozen candidate's own `design/pages.json` text — the only page-identity authority. */
  readonly manifestText: string;
  /**
   * The candidate's COMPLETE design-tree inventory, TREE-relative (`pages/home.tsx`, never
   * `design/pages/home.tsx`). This is entry resolution's universe (design §4: an `entry` "must
   * resolve to a real file inside the tree") AND the allowlist's own `has` — never the turn's
   * page slugs, which cannot answer whether a path exists.
   */
  readonly treePaths: readonly string[];
  /**
   * The SAME inventory as {@link treePaths}, carrying each file's `sha256` alongside its
   * tree-relative path — the candidate's own `StagedFileV1` list, narrowed
   * (`core/turns/model/candidate.ts`'s `candidateTreeInventory`).
   *
   * WHY BOTH SHAPES ARE HERE, and why that is not two sources of truth. `treePaths` answers
   * entry resolution's only question ("does this `entry` name a real file"); this answers the
   * smoke stage's ("are the bytes on disk still the bytes this candidate froze"). They are the
   * same file set by construction — one builder produces both from one `candidate.treeFiles`
   * list — and `runTurnValidation` never derives one from the other, so neither can silently
   * become a filtered view of the other.
   */
  readonly treeInventory: readonly DesignFileEntryV1[];
  /**
   * The turn's OWN SEND-TIME design-tree inventory — the `before` side of design §8 step 8's
   * closure diff, against which {@link treeInventory} is the `after`. Built by
   * `core/turns/model/candidate.ts`'s `readSetTreeInventory` from the staged read set
   * (`core/kernel/model/handlers/turn.ts`'s `buildValidationInput`), the SAME helper
   * `buildFinalizeInput` already calls for the turn's own `changedPages` report — one
   * construction, read by both, so the Gate's smoke selection and the report the agent is shown
   * can never be built from two different readings of "what the tree looked like when this turn
   * was sent".
   *
   * AN EMPTY INVENTORY IS AN HONEST FIRST TURN, not a degraded input: with no send-time hashes
   * no closure hash can be computed on that side, so every page counts as changed and every
   * page smokes. That is exactly design §8 step 8's "a first turn … smokes everything", and it
   * is the fail-SAFE direction — the failure this ordering must never allow is skipping a smoke
   * render for a page nothing can prove unchanged.
   */
  readonly sendTimeInventory: DesignTreeInventoryV1;
  /**
   * Every tree file's source text, keyed by the SAME tree-relative path as `treePaths` —
   * complete, with no filter of this ring's own.
   *
   * WHY NO FILTER, AND WHY THAT IS THE POINT (task-14-supplement §2; Task 13's
   * closure-completeness contract on `GateRunner.runTree`). That contract requires
   * `files` to hold text for every CODE file any page's closure reaches, or the closure is
   * refused and the page reports "unchanged" forever. `core` may not import `gate`, so any
   * predicate here deciding "which files are code" would be a SECOND, independently derived
   * copy of `gate/model/tree-scan.ts`'s measured `isCodeFile` — exactly the divergence that
   * exported predicate exists to prevent, and exactly the class of second reading that
   * produced task 13's round-2 Critical. The only filter that cannot drift from `isCodeFile`
   * is no filter at all: the caller passes EVERY tree file and `gate` alone decides what to
   * scan (`scanTreeImports` skips a non-code file even when its text is present, so a `.png`'s
   * bytes cost nothing but the decode). Measured, not assumed, that this is affordable:
   * 2.3 MB of source across 128 files scans in 453 ms, and 2 MiB of ordinary page source in
   * one file in 295 ms (probe artifact `t14-budget-probe.ts`).
   */
  readonly files: ReadonlyMap<string, string>;
  /**
   * The candidate's `design/` directory, ABSOLUTE — the Gate smoke stage resolves
   * `<designRoot>/<entry>` via `Bun.file` from a fresh child-process cwd, so a tree-relative
   * path never resolves there (`core/ports/gate-runner.ts`'s `runPage.sourcePath` doc).
   * Deliberately separate from the short `fileName` this function passes for diagnostics:
   * conflating them would leak an absolute filesystem path into user-facing Gate messages.
   */
  readonly designRoot: string;
}

type TurnGateDiagnosticsV1 = EventPayloadByKindV1["turn.gateRejected"]["diagnostics"];

export type TurnValidationResultV1 =
  | {
      readonly kind: "passed";
      readonly slice: ManifestSliceV1;
      readonly descriptors: readonly GatePageDescriptorV1[];
      readonly warnings: readonly GateWarningV1[];
      /**
       * Every manifest entry's PROVEN-COMPLETE closure, straight from `runTree`
       * (design §7) — `core/turns/model/candidate.ts`'s `selectChangedPages` input, and the
       * only thing that makes "an edit to `lib/theme.ts` changed these pages" answerable at
       * all. A slug missing here on a PASSED validation is impossible by that method's own
       * CONTRACT: an unprovable closure always carries at least one `errors` entry, and any
       * error at all means this function never returns `"passed"`.
       */
      readonly closures: readonly GateClosureV1[];
    }
  | {
      readonly kind: "retry";
      readonly nextAttempt: TurnAttempt;
      readonly diagnostics: TurnGateDiagnosticsV1;
    }
  | {
      readonly kind: "exhausted";
      readonly failure: FailureDtoV1;
      readonly diagnostics: TurnGateDiagnosticsV1;
    };

/** §7.2: "Attempts are integers 1 through 4"; `canRetryAfterGate` already excludes `MAX_TURN_ATTEMPT` from calling this. */
function nextAttemptAfter(attempt: TurnAttempt): TurnAttempt {
  if (attempt === 1) return 2;
  if (attempt === 2) return 3;
  return 4; // attempt === 3 (MAX_TURN_ATTEMPT - 1)
}

/**
 * `gate/types.ts`'s `GateErrorKind`/`GateWarningKind` mark `file`/`line`/`column` OPTIONAL
 * (`?`) — `core/ports/gate-runner.ts`'s narrow redraw keeps that shape verbatim, since it is
 * not itself a Kernel protocol DTO. The Kernel wire DTO (`event-payload.ts`'s
 * `TurnGateDiagnosticsV1`) is strict and NULLABLE for the same fields (this file's own
 * binding rule: "the Kernel-side echo widens them to `.nullable()`"), so an explicit
 * `undefined -> null` conversion sits at exactly this one boundary, never leaking the gap
 * to either side.
 */
function toGateErrorDto(error: GateErrorV1): TurnGateDiagnosticsV1["errors"][number] {
  return {
    kind: error.kind,
    code: error.code,
    message: error.message,
    file: error.file ?? null,
    line: error.line ?? null,
    column: error.column ?? null,
    // CARRIED, NOT DERIVED (task-13 review round 4, M-4 — task 14's own decision, and the
    // producer's recommendation, reached independently here for the same reason). Attribution
    // is a fact about the closure WALK: which file a page's resolution stopped at. A blocked
    // page is by construction ABSENT from `closures`, so the boundary sees only a set of
    // diagnostics and a set of resolved pages — the blocked ones are precisely those neither
    // structure names, and "which diagnostic blocked page X" is not recoverable from that.
    // Re-deriving it here would mean re-keying on `file`, a second independent reading of the
    // import graph inside a ring that cannot even see it. So the field crosses verbatim, and
    // `turnGateErrorV1Schema` (`core/protocol/model/event-payload.ts`) was widened to accept
    // it. `?? null` follows this file's own `undefined -> null` convention for the widened
    // echo, so an unattributed diagnostic still reaches the agent — DROPPING one would be the
    // silent fail-open the field exists to close, since the page is already missing from
    // `closures` and its diagnostic is the only remaining signal that it was excluded.
    blockedPages: error.blockedPages ?? null,
  };
}
function toGateWarningDto(warning: GateWarningV1): TurnGateDiagnosticsV1["warnings"][number] {
  return {
    kind: warning.kind,
    message: warning.message,
    line: warning.line ?? null,
    column: warning.column ?? null,
    // `?? null` follows this file's own `undefined -> null` convention (see `toGateErrorDto`
    // just above). Every per-page lint stamps `file` at its one call site in
    // `gate/model/gate.ts` (defect fix, 2026-08-09); `import-cycle`/`dead-module` are no
    // longer the exception, just one more producer of the same field.
    file: warning.file ?? null,
    // CARRIED, NOT DERIVED (design-agent-feedback-loop repair, Task 5) — the identical
    // `?? null` echo `toGateErrorDto` above already applies to `GateErrorV1.blockedPages`.
    // `GateWarningV1.blockedPages` is populated only by `GateRunner.runTree`'s closure-wide
    // determinism/`silencing-any` lint; every other producer leaves it `undefined`, which
    // becomes an honest `null` here rather than a dropped field.
    blockedPages: warning.blockedPages ?? null,
  };
}

/**
 * The warning kinds `GateRunner.runTree`'s whole-tree lint (`gate/adapters/gate-runner.ts`'s
 * `lintWholeTreeDeterminism`/`lintFileDeterminism`, Task 5) and `GateRunner.runPage`'s per-page
 * lint (`gate/model/gate.ts`'s `runGate`) can BOTH produce for the SAME entry file: originally the
 * three determinism/`silencing-any` kinds (Task 5), joined by `module-scope-tokens` (design-tree
 * design-systems Task 8) and `token-name-as-color` (Task 9) — `gate/adapters/gate-runner.ts`'s
 * `lintFileDeterminism` runs all five of `lintDeterminism`/`lintSilencingAny`/
 * `lintModuleScopeTokens`/`lintTokenNameColors` over every code file in the whole-tree pass, the
 * exact same four functions (plus `lintDroppedIds`/`lintUnlistedNavigation`, which are NOT
 * duplicated here — see below) `runGate` runs per page.
 *
 * TASK 8 INTRODUCED THIS SAME DEFECT FOR `module-scope-tokens` AND DID NOT CLOSE IT (task 9 review
 * round 1, Finding 2) — fixed here for both new kinds together, since eligibility is one list and
 * the fix is the same shape for either kind.
 *
 * Every OTHER kind (`dropped-id`, `unpointed-element`, `unlisted-navigation`, `import-cycle`,
 * `dead-module`) is still produced by exactly ONE of the two methods, so none of THOSE can ever
 * collide with itself here — see {@link dedupeWarnings}'s own doc for why that exclusion is
 * load-bearing, not merely narrow scoping for its own sake.
 */
const DEDUPE_ELIGIBLE_WARNING_KINDS: ReadonlySet<GateWarningKindV1> = new Set([
  "nondeterministic-time",
  "nondeterministic-randomness",
  "silencing-any",
  "module-scope-tokens",
  "token-name-as-color",
]);

/**
 * Collapse a warning `runTree`'s whole-tree determinism/`silencing-any` lint and `runPage`'s
 * per-page lint both report for the SAME entry file — the residual `gate/adapters/gate-runner.ts`
 *'s `lintWholeTreeDeterminism` doc comment flagged and deferred ("WHAT THIS DOES NOT CLAIM, SO
 * IT IS NOT LAUNDERED AS SETTLED"), fixed here rather than left open.
 *
 * MEASURED SCENARIO: a page whose OWN entry directly contains a `Date.now()`/`Math.random()`/
 * `: any` construct (not one that only lives in a shared module) gets warned about it TWICE in
 * this function's caller's merged `warnings` array — once by `runTree` (pushed first, from
 * `treePass.warnings`, carrying `blockedPages`) and once by `runPage` (pushed per entry, from
 * `pageResult.warnings`, carrying none) — because Task 5 made the two methods' lints overlap in
 * KIND for the first time on a page's own entry: before Task 5, `runTree`'s warnings
 * (`import-cycle`/`dead-module`) and `runPage`'s (everything else) never shared a kind at all,
 * so the SAME merge that has always happened here never had anything to collide. Neither copy is
 * WRONG; the same underlying fact is reported by two stages that both legitimately scan the
 * identical source text.
 *
 * KEYED ON `kind + file + line + column`, SCOPED TO {@link DEDUPE_ELIGIBLE_WARNING_KINDS} ONLY —
 * deliberately not a blanket key over every warning. `dropped-id` (`gate/model/lints.ts`'s
 * `lintDroppedIds`) carries NO line/column at all, so two GENUINELY DISTINCT `dropped-id`
 * warnings for one page (two different ids referenced but no longer present) would collide on an
 * unscoped `kind+file+line+column` key and one would be silently swallowed — a real regression an
 * unscoped key would introduce, not a theoretical one. Restricting eligibility to the five kinds
 * `runTree`'s whole-tree lint can actually produce (originally three, Task 5; `module-scope-tokens`
 * and `token-name-as-color` joined it at Tasks 8/9 — see {@link DEDUPE_ELIGIBLE_WARNING_KINDS}'s
 * own doc) is what keeps every other kind completely unaffected: each of the rest is produced by
 * exactly ONE of `runPage`/`runTree`, so nothing else here can ever generate a same-kind collision
 * to begin with, and this function never even computes a key for them — they pass straight through
 * unconditionally, however many share the same file.
 *
 * KEEPS THE FIRST OCCURRENCE, never the last: `treePass.warnings` is pushed into the caller's
 * array before any `pageResult.warnings`, so keeping first is what keeps the MORE INFORMATIVE
 * copy — the one naming the pages a shared-module finding would have blocked — rather than an
 * accidental "whichever sorts first" outcome.
 */
function dedupeWarnings(warnings: readonly GateWarningV1[]): GateWarningV1[] {
  const seen = new Set<string>();
  const deduped: GateWarningV1[] = [];
  for (const warning of warnings) {
    if (!DEDUPE_ELIGIBLE_WARNING_KINDS.has(warning.kind)) {
      deduped.push(warning);
      continue;
    }
    const key = JSON.stringify([
      warning.kind,
      warning.file ?? null,
      warning.line ?? null,
      warning.column ?? null,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(warning);
  }
  return deduped;
}

/**
 * The one Gate-exhaustion failure — `safeMessage` included, which is the TEXT of the terminal chat
 * record the user actually reads.
 *
 * EXPORTED FOR THE SECOND EXHAUSTION PATH, NOT COPIED (final whole-branch review, I2, 2026-08-10).
 * `run-turn.ts`'s `started instanceof Error` branch reaches the same substantive outcome by a
 * different route — the fence's own independent hard `MAX_TURN_ATTEMPTS` counter running dry one
 * attempt before this driver's local counter expects it to, reachable only after a session fallback
 * spent one of the four slots (Task 9). It used to interpolate `TurnFenceError.message` — a
 * debugging string ("turn fence rejected the request: attempt 5 exceeds the 4-attempt budget") —
 * into that user-visible text. Two paths to one outcome must not tell the user two different
 * stories, and a second hand-written sentence would drift from this one, so that branch calls this
 * function instead.
 */
export function gateRetryExhaustedFailure(): FailureDtoV1 {
  return {
    code: "GATE_RETRY_EXHAUSTED",
    retryable: false,
    safeMessage: `Gate rejected the candidate after exhausting the ${MAX_TURN_ATTEMPT}-attempt budget.`,
    details: {},
  };
}

export async function runTurnValidation(
  deps: TurnValidationDeps,
  input: RunTurnValidationInputV1,
): Promise<TurnValidationResultV1> {
  // Design §8 step 1. `treePaths` is the candidate's REAL inventory now (task 14 wired
  // `DesignTreeReader.listTree()` through `core/kernel`'s staging assembly and
  // `TurnCandidateV1.treeFiles`), so entry resolution can finally answer "does this `entry`
  // name a real file" instead of being handed the honest empty this call used to carry.
  const sliceResult = await wrap(
    deps.gateRunner.runManifestSlice({
      manifestText: input.manifestText,
      treePaths: input.treePaths,
    }),
  );

  const errors: GateErrorV1[] = [...sliceResult.errors];
  const warnings: GateWarningV1[] = [];
  const descriptors: GatePageDescriptorV1[] = [];

  // Design §8 step 4 — THE IMPORT PERIMETER (see this file's header). Run UNCONDITIONALLY,
  // even when the manifest itself failed to decode: the flat allowlist scan covers every code
  // file in the tree regardless of `pages`, so skipping it on a bad manifest would hide every
  // import violation behind a manifest typo and spend one of only four attempts learning about
  // just one of the two problems. `pages` is the VALIDATED entry list — a closure is walked
  // FROM an entry, and the entry-to-slug binding is `pages.json`'s job, never derivable from a
  // slug — so it is honestly empty when the slice did not decode, and no closure is claimed.
  const treePass = await wrap(
    deps.gateRunner.runTree({
      files: input.files,
      treePaths: input.treePaths,
      pages: sliceResult.slice?.pages ?? [],
    }),
  );
  errors.push(...treePass.errors);
  // The pass's own warnings land in the SAME list the per-page ones do, because the turn's
  // report is per turn, not per stage: a warning about a shared module has no page to belong to.
  warnings.push(...treePass.warnings);

  const closureBySlug = new Map(treePass.closures.map((closure) => [closure.slug, closure]));

  // Design §8 step 8 — WHICH PAGES THE SMOKE STAGE RUNS FOR, computed ONCE for the whole turn
  // rather than per entry: `selectChangedPages` hashes every closure it is given on both sides,
  // so calling it inside the loop would redo the same whole-tree comparison once per page.
  //
  // CALLED, NEVER RE-DERIVED (this is the point of the task, not an implementation detail).
  // `selectChangedPages` is the SAME function `core/kernel/model/handlers/turn.ts`'s
  // `buildFinalizeInput` uses to produce the turn's own `changedPages` — the list the agent and
  // the chat record are shown. A second "did this page change" rule here could disagree with
  // that one, and the disagreement would be invisible: the Gate would skip a page the turn
  // simultaneously reports as changed. It also already answers, for free and correctly, every
  // edge this stage would otherwise have to special-case — a first turn and a newly listed slug
  // have no send-time hash to match, and an uncomputable hash on EITHER side counts as changed.
  const changedSlugs = new Set(
    selectChangedPages({
      closures: treePass.closures,
      beforeInventory: input.sendTimeInventory,
      afterInventory: { files: input.treeInventory },
    }),
  );

  // Design §8's per-entry stage. Driven off the VALIDATED manifest, never off a caller-supplied
  // page list: which file a page lives in is `pages.json`'s `entry` value, and a slug-derived
  // path is precisely what the design tree retires. An undecodable manifest yields no entries
  // and therefore no `runPage` calls — `sliceResult.errors` already carries why.
  for (const entry of sliceResult.slice?.pages ?? []) {
    const source = input.files.get(entry.entry);
    if (source === undefined) {
      // Unreachable while `files` and `treePaths` describe the same candidate inventory (this
      // function's own `files` contract) AND the slice decoded — `checkManifestSlice` already
      // refuses an `entry` absent from `treePaths`. Reported as a typed fatal rather than
      // running `runPage("")`, which would blame the page's own contract for a staging gap.
      errors.push({
        kind: "manifest",
        code: "ENTRY_SOURCE_MISSING",
        message: `the manifest entry "${entry.entry}" for page "${entry.slug}" resolved in the tree but this turn holds no source for it`,
        file: entry.entry,
      });
      continue;
    }
    const closure = closureBySlug.get(entry.slug);
    const pageResult = await wrap(
      deps.gateRunner.runPage({
        source,
        slug: entry.slug,
        // The smoke stage mounts this page's WHOLE closure off the staged candidate tree and
        // hash-verifies every member against the candidate's own inventory (design §6, §9.2).
        // Both come from the candidate `store` just froze — nothing here re-reads or re-hashes
        // a disk this ring never staged.
        treeRoot: input.designRoot,
        expectedFiles: input.treeInventory,
        // The SHORT display name `runGate` echoes into `GateErrorV1.file`, in the same
        // tree-relative vocabulary every other diagnostic and `pages.json` itself speak —
        // never the absolute path, which would leak a filesystem location into agent-facing
        // Gate messages.
        entryRelPath: entry.entry,
        // Design §8 step 8, decided per entry off the ONE set computed above. A page with NO
        // proven closure smokes too, and that is not a fallback but the same honesty rule
        // `selectChangedPages` itself applies to an uncomputable hash: such a slug is absent
        // from `changedSlugs` only because the pass established no file set to hash for it at
        // all, so "not reported as changed" here means "nothing could be compared", never
        // "unchanged". Reading that as `"skip"` would silently drop the smoke render for
        // precisely the pages this turn understands least.
        smoke: closure === undefined || changedSlugs.has(entry.slug) ? "run" : "skip",
        // Only when this pass PROVED the closure complete. `runTree`'s CONTRACT makes
        // the two cases exclusive: a slug absent from `closures` always carries a fatal in
        // `errors`, so omitting `closure` here can never quietly hand a downstream stage a
        // truncated file list — the turn is already rejected.
        ...(closure !== undefined ? { closure: { entry: entry.entry, files: closure.files } } : {}),
      }),
    );
    errors.push(...pageResult.errors);
    warnings.push(...pageResult.warnings);
    if (pageResult.descriptor !== null) descriptors.push(pageResult.descriptor);
  }

  // DEDUPED HERE, ONCE, AFTER THE MERGED ARRAY IS FULLY ASSEMBLED (design-agent-feedback-loop
  // repair, Task 5 supplementary fix) — every downstream use of `warnings` below reads
  // `dedupedWarnings` instead, never the raw merge. See `dedupeWarnings`'s own doc for the exact
  // scenario this closes and why the key is scoped rather than blanket.
  const dedupedWarnings = dedupeWarnings(warnings);

  if (errors.length === 0) {
    // `checkManifestSlice`'s own contract never actually pairs zero errors with a null slice
    // (`gate/model/manifest.ts`) — this is defensive-only. An empty `pages` is the honest
    // fallback: `PageEntryV1[]` needs a real `entry` per page, which this degenerate branch
    // has no way to supply.
    const slice = sliceResult.slice ?? { pages: [], active: null };
    // DIAGNOSTIC (infrastructure/debug-log): the Gate passed this candidate -- recorded so a turn's
    // full attempt history (pass/retry/exhausted) is reconstructable from the trace alone, including
    // the warning text itself (not just a count), since a pass can still carry Gate warnings worth
    // reviewing later.
    trace("core.turns.validation.outcome", {
      turnId: input.turnId,
      attempt: input.attempt,
      kind: "passed",
      pageCount: descriptors.length,
      warnings: dedupedWarnings.map(toGateWarningDto),
    });
    return {
      kind: "passed",
      slice,
      descriptors,
      warnings: dedupedWarnings,
      closures: treePass.closures,
    };
  }

  const diagnostics: TurnGateDiagnosticsV1 = {
    errors: errors.map(toGateErrorDto),
    warnings: dedupedWarnings.map(toGateWarningDto),
  };
  deps.publish({
    kind: "turn.gateRejected",
    payload: {
      turnId: input.turnId,
      attempt: input.attempt,
      retryNumber: input.attempt - 1,
      diagnostics,
    },
    correlation: { turnId: input.turnId },
  });

  if (canRetryAfterGate(input.attempt)) {
    const retried = deps.machine.apply("retryAfterGate");
    if (retried.kind === "illegal") {
      log.warn(
        `core/turns/validation: retryAfterGate illegal (${retried.code}) for turn ${input.turnId}`,
      );
    }
    // DIAGNOSTIC (infrastructure/debug-log): the Gate rejected this candidate but the turn still
    // has retry budget -- the full errors/warnings the next attempt's prompt will be folded from.
    trace("core.turns.validation.outcome", {
      turnId: input.turnId,
      attempt: input.attempt,
      kind: "retry",
      nextAttempt: nextAttemptAfter(input.attempt),
      diagnostics,
    });
    return { kind: "retry", nextAttempt: nextAttemptAfter(input.attempt), diagnostics };
  }

  // DIAGNOSTIC (infrastructure/debug-log): the Gate rejected this candidate and the turn's retry
  // budget is exhausted -- the turn will fail because of exactly these diagnostics.
  trace("core.turns.validation.outcome", {
    turnId: input.turnId,
    attempt: input.attempt,
    kind: "exhausted",
    diagnostics,
  });
  return { kind: "exhausted", failure: gateRetryExhaustedFailure(), diagnostics };
}
