import type { ClosureV1 } from "entities/design-tree";
import type { PageSlug } from "entities/page";

import type { GateError, GateResult, GateWarning, PageDescriptor } from "../types";
import { makeGateResult } from "./gate-result";
import {
  lintDeterminism,
  lintDroppedIds,
  lintSilencingAny,
  lintUnlistedNavigation,
  lintUnpointedElements,
} from "./lints";
import { checkPageContract } from "./page-contract";
import { scanTreeImports } from "./tree-scan";

/**
 * The gate's injected validation stages that need more than the page source
 * (code-structure ports). Each is optional so the pipeline runs the source-only
 * checks standalone and gains the heavier stages as they are wired: `typeCheck`
 * (phase-3 T4, the tsc/unstable-sync diagnostics), `checkManifest` (T5, gated on
 * the phase-4 pages.json schema), and `smokeRender` (T6, the host's one-shot
 * SmokeRenderer). Each may be sync or async and returns fatal `GateError`s.
 */
export interface GatePorts {
  readonly typeCheck?: (source: string, fileName: string) => GateError[] | Promise<GateError[]>;
  readonly checkManifest?: (
    descriptor: PageDescriptor,
    source: string,
  ) => GateError[] | Promise<GateError[]>;
  readonly smokeRender?: (
    descriptor: PageDescriptor,
    source: string,
  ) => GateError[] | Promise<GateError[]>;
}

/**
 * One candidate page to validate: its source, its slug, and its scratch file name.
 * `referencedIds` and `listedSlugs` feed the `dropped-id` and `unlisted-navigation`
 * warning lints (§6.3 step 3); both are optional and, absent, skip their lint so
 * the gate stays runnable standalone (e.g. in a fixture with no kernel/manifest).
 */
export interface GateInput {
  readonly source: string;
  readonly slug: PageSlug;
  /**
   * The tree-relative path `design/pages.json` bound this entry to (design §4) — the
   * addressing `runTreeImports`'s own whole-tree scan already speaks. Which file a page
   * lives in is `pages.json`'s `entry` value; NEVER derive it from `slug` — that guess
   * (`pages/<slug>.tsx`) is exactly the anti-pattern this plan exists to remove, so every
   * caller this task owns supplies it explicitly (see `fileName`'s fallback below for the
   * one caller that, today, still cannot).
   *
   * OPTIONAL, not required as the port sketch shows it. RE-MEASURED for real (task-12 review
   * round 1 — the prior wording claimed this mirrored task 11's own `context` measurement,
   * which was an over-claim: that measurement was for a different signature, `import-scan.ts`'s
   * `scanImportAllowlist`, not this field. Making `entryRelPath`/`closure` required here and on
   * `core/ports/gate-runner.ts`'s `GateRunner.runPage`, then running `bun x tsc --noEmit`,
   * produces exactly **19 new errors**: 2 in PRODUCTION, non-test files this task does not own
   * (`core/turns/model/validation.ts`, `core/kernel/model/handlers/page-descriptors.ts` — both
   * call `runPage` with no entry data to give, since neither has been wired to a
   * `DesignTreeReader`/closure yet), 1 inside this task's own adapter
   * (`gate/adapters/gate-runner.ts`, which forwards its own still-optional `entryRelPath` into
   * what would become a required `GateInput` field), and 16 across four test files
   * (`gate/adapters/gate-runner.test.ts`, `core/ports/fakes/gate-runner.test.ts`,
   * `entrypoint/model/create-shell.test.ts`, `gate/model/smoke.test.ts`) whose fixtures predate
   * this task. That is a real, current cost, not a guess — reverted after measuring; the fields
   * stay optional.
   * FLAGGED FOR WHICHEVER TASK WIRES A REAL DESIGN-TREE CLOSURE THROUGH `core/turns`/`core/
   * kernel` (13 or 14, per this plan's own dependency graph — both consume Task 12): make
   * this field required, delete `fileName`'s slug-derived fallback below, and update those
   * callers to supply the real value.
   */
  readonly entryRelPath?: string;
  /**
   * The entry's resolved closure (design §7) — so the smoke stage and future stages (design
   * §8 steps 5 and 8: one whole-tree `tsc` program, and smoke scoped to only the pages whose
   * `closureHash` changed) have it once they land. NEITHER is implemented by this plan (see
   * `runTreeImports`'s own doc comment below) — `closure` is threaded through today so the
   * pipeline's shape is already correct, not because any stage here reads it yet. Optional
   * for the same reason as `entryRelPath` above: no current caller outside this task's Files
   * list has one to give.
   */
  readonly closure?: ClosureV1;
  readonly fileName?: string;
  /** Ids the caller's current selection or open pins reference (`dropped-id`). */
  readonly referencedIds?: readonly string[];
  /** The staged manifest slice's page list (`unlisted-navigation`). */
  readonly listedSlugs?: readonly PageSlug[];
}

/**
 * Run the validation gate over one immutable candidate page (master §6.3). The page contract
 * (§4) is fatal; the determinism lints (§6.3) are warnings. The injected `typeCheck` runs
 * next. The manifest + smoke stages run ONLY when nothing fatal has surfaced yet, because a
 * candidate with a broken contract or a type error must never be imported/rendered. A
 * candidate passes only when there are zero fatal errors; warnings never reject.
 *
 * The static-import allowlist (§3.1) does NOT run here (task 12: moved out, into
 * {@link runTreeImports}, run once per turn over the whole tree — see its own doc comment for
 * why a per-page scan would be both redundant and incomplete for a shared module).
 */
export async function runGate(input: GateInput, ports: GatePorts = {}): Promise<GateResult> {
  const errors: GateError[] = [];
  const warnings: GateWarning[] = [];
  // `entryRelPath` OUT-RANKS `fileName` when both are present (task-12 review round 1,
  // Important 4 — corrected from an earlier, backwards precedence). `entryRelPath` is the
  // AUTHORITATIVE addressing (`pages.json`'s own `entry` value, design §4); `fileName` is a
  // caller-supplied display-name OVERRIDE that predates `entryRelPath` and, in every real
  // caller today (`core/kernel/model/handlers/turn.ts`'s `workspacePageRelPath(pageSlug)`), IS
  // still slug-derived. Had `fileName` won, the moment a future caller started passing a real
  // `entryRelPath` ALONGSIDE its existing `fileName` (the natural, incremental way to adopt
  // it), the authoritative value would have lost silently to the slug guess it exists to
  // replace, with nothing visibly broken. FLAGGED FOR WHICHEVER TASK MAKES `entryRelPath`
  // REQUIRED (see `GateInput.entryRelPath`'s own doc): once every caller supplies it, delete
  // the `fileName`/`${input.slug}.tsx` fallback arms below entirely — they exist only to bridge
  // `core/turns`/`core/kernel`, which do not supply `entryRelPath` yet. No caller this task
  // owns ever relies on either fallback arm — every fixture below supplies `entryRelPath`
  // explicitly, several with an entry deliberately unrelated to their slug.
  const fileName = input.entryRelPath ?? input.fileName ?? `${input.slug}.tsx`;

  const contract = checkPageContract(input.source);
  for (const e of contract.errors) {
    errors.push({
      kind: "contract",
      code: e.code,
      message: e.message,
      file: fileName,
      line: e.line,
      column: e.column,
    });
  }
  warnings.push(...lintDeterminism(input.source));
  warnings.push(...lintSilencingAny(input.source));
  warnings.push(...lintDroppedIds(input.source, input.referencedIds));
  warnings.push(...lintUnpointedElements(input.source));
  warnings.push(...lintUnlistedNavigation(input.source, input.listedSlugs));

  if (ports.typeCheck !== undefined) {
    errors.push(...(await ports.typeCheck(input.source, fileName)));
  }

  const descriptor: PageDescriptor | null =
    contract.meta === null ? null : { slug: input.slug, meta: contract.meta };

  // Only mount/render/consult the manifest when the candidate is otherwise safe:
  // a broken contract or a type error means the source cannot be imported or
  // rendered, so skip the heavier stages.
  if (errors.length === 0 && descriptor !== null) {
    if (ports.checkManifest !== undefined)
      errors.push(...(await ports.checkManifest(descriptor, input.source)));
    if (ports.smokeRender !== undefined)
      errors.push(...(await ports.smokeRender(descriptor, input.source)));
  }

  return makeGateResult(errors, warnings, descriptor);
}

/**
 * The whole-tree import allowlist (design §8 step 4), run ONCE per turn before any per-page
 * stage. It lives here rather than inside `runGate` because a shared module belongs to no
 * single page: scanning it per page would report the same violation N times and would miss
 * it entirely for a module no page reaches.
 *
 * NOT YET DONE (design §8 steps 5 and 8, deferred to plan 2): the type check is still ONE
 * `tsc` program per entry file rather than one over the whole tree, and smoke still runs for
 * every present page rather than only those whose `closureHash` changed. Both are correct as
 * they stand — they are simply more expensive than the design's end state.
 *
 * SECURITY-CRITICAL FLAG, MUST-WIRE (task-12 review round 1 — registered in red-debt.md):
 * this function has NO non-test caller today. Moving the import allowlist (and, inside it, the
 * `eval`/`new Function` dynamic-code ban) out of `runGate` was this task's own mandate, but
 * nothing in the shipped pipeline calls `runTreeImports` yet — `core/turns/model/
 * validation.ts` only calls `runManifestSlice`/`runPage`. Until Task 14 wires this into the
 * turn's validation flow (once per turn, before the per-page `runPage` calls, per design §8's
 * own ordering), a page containing a forbidden import, `eval(...)`, or `new Function(...)`
 * passes the whole Gate and reaches the smoke render — see `core/ports/gate-runner.ts`'s
 * `GateRunner.runTreeImports` for the matching flag on the port side, and `gate/adapters/
 * gate-runner.test.ts:66`'s "KNOWN SECURITY GAP, NOT CORRECT BEHAVIOR" test (round-2 fix: the
 * prior locator here named a test that does not exist under either title) for the pinned,
 * currently-true consequence.
 */
export function runTreeImports(input: {
  readonly files: ReadonlyMap<string, string>;
  readonly treePaths: readonly string[];
}): GateError[] {
  const present = new Set(input.treePaths);
  return scanTreeImports({ files: input.files, has: (relPath) => present.has(relPath) }).map(
    (error) => ({
      kind: "import" as const,
      code: error.code,
      message: error.message,
      // The TREE-relative path, not a display name: a violation in a shared module must name
      // the module, and prefixing `design/` here would make the Gate's diagnostics disagree
      // with the paths `pages.json` and every closure already speak.
      file: error.file,
      line: error.line,
      column: error.column,
    }),
  );
}
