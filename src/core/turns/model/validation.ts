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
  GateWarningV1,
  ManifestSliceV1,
} from "core/ports";
import type { EventPayloadByKindV1, FailureDtoV1, UUIDv7 } from "core/protocol";
import { trace } from "infrastructure/debug-log";

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
 * PER TURN; the whole-tree import allowlist (step 4) runs EXACTLY ONCE PER TURN immediately
 * after it; only then does every manifest entry run the per-page `GateRunner.runPage`
 * pipeline. Neither once-per-turn stage is ever interleaved with, or repeated inside, the
 * per-page loop. Every entry then runs `runPage` regardless of whether an earlier one already
 * failed, so a rejection carries the COMPLETE set of diagnostics across every page in one
 * report, not just the first failure.
 *
 * THE IMPORT PERIMETER IS WIRED HERE, AND ONLY HERE (red-debt.md's SECURITY-CRITICAL
 * must-wire; task-14-supplement §1). `GateRunner.runTreeImports` — the import allowlist and,
 * inside it, design §5.8's `eval`/`new Function` ban — had NO production caller before task
 * 14: `runPage` deliberately stopped scanning imports in task 12 (a shared module belongs to
 * no single page, so scanning per page both misses a module no page's own source is run
 * against and reports a shared violation once per reaching page). Between those two changes a
 * page importing `lodash`, calling `require("fs")`, `eval(...)`, `new Function(...)` or a
 * dynamic `import()` passed the whole Gate and reached the smoke render. The
 * `runTreeImports` call below is the fix. `src/entrypoint/model/turn-import-perimeter.test.ts`
 * proves it end to end against the REAL `gate` adapter for each of those six forms placed in a
 * SHARED module no page names directly; the tests beside this file prove the call shape and
 * the verdict rule against the port fake.
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
   * Every tree file's source text, keyed by the SAME tree-relative path as `treePaths` —
   * complete, with no filter of this ring's own.
   *
   * WHY NO FILTER, AND WHY THAT IS THE POINT (task-14-supplement §2; Task 13's
   * closure-completeness contract on `GateRunner.runTreeImports`). That contract requires
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
       * Every manifest entry's PROVEN-COMPLETE closure, straight from `runTreeImports`
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
  };
}

function gateRetryExhaustedFailure(): FailureDtoV1 {
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
  const treeImports = await wrap(
    deps.gateRunner.runTreeImports({
      files: input.files,
      treePaths: input.treePaths,
      pages: sliceResult.slice?.pages ?? [],
    }),
  );
  errors.push(...treeImports.errors);

  const closureBySlug = new Map(treeImports.closures.map((closure) => [closure.slug, closure]));

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
        // The SHORT display name `runGate` echoes into `GateErrorV1.file`, in the same
        // tree-relative vocabulary every other diagnostic and `pages.json` itself speak —
        // never the absolute path, which would leak a filesystem location into agent-facing
        // Gate messages.
        fileName: entry.entry,
        sourcePath: `${input.designRoot}/${entry.entry}`,
        entryRelPath: entry.entry,
        // Only when this pass PROVED the closure complete. `runTreeImports`' CONTRACT makes
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
      warnings: warnings.map(toGateWarningDto),
    });
    return { kind: "passed", slice, descriptors, warnings, closures: treeImports.closures };
  }

  const diagnostics: TurnGateDiagnosticsV1 = {
    errors: errors.map(toGateErrorDto),
    warnings: warnings.map(toGateWarningDto),
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
      console.warn(
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
