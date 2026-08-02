import * as errore from "errore";

import type { ClosureV1 } from "entities/design-tree";
import type { PageSlug } from "entities/page";

import type { GateError, GateResult, GateWarning, PageDescriptor } from "../types";
import { createGateResult } from "./gate-result";
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
 * One page's own source could not be tokenized to the end (`lexer.ts`'s
 * {@link SourceStreamTruncatedError}, or any other throw out of the lexer/contract/lint
 * stack). Carried as a value so {@link runGate} turns it into an ordinary fatal for that page
 * instead of letting it escape into the turn — the same shape and the same reasoning as
 * `tree-scan.ts`'s `TreeFileUnscannableError` for the whole-tree scan.
 */
class PageSourceUnscannableError extends errore.createTaggedError({
  name: "PageSourceUnscannableError",
  message: 'the page source at "$file" could not be read to the end',
}) {}

/**
 * The one fatal {@link runGate} returns for a page whose source could not be read to the end,
 * whichever of the two mechanisms reported it — a returned `SourceStreamTruncatedError` or a
 * caught engine throw. `cause` is unwrapped when present so the diagnostic names the real
 * reason (a stack overflow's own message, say) rather than only the wrapper's.
 */
function unscannablePage(fileName: string, error: Error): GateResult {
  const cause = error.cause;
  const message =
    cause instanceof Error ? `${error.message} — ${cause.name}: ${cause.message}` : error.message;
  return createGateResult(
    [
      {
        kind: "contract",
        code: "UNSCANNABLE_SOURCE",
        message: `${fileName}: ${message}`,
        file: fileName,
        line: 1,
        column: 1,
      },
    ],
    [],
    null,
  );
}

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

  // A SOURCE THIS PAGE'S SCANS COULD NOT READ TO THE END IS A FATAL FOR THE PAGE, never a
  // silent pass and never an escaped throw (task-14 review round 1, C1). `UNSCANNABLE_SOURCE`
  // is deliberately the SAME code the whole-tree scan uses for the same fact, on the
  // `contract` kind because here it is the page's own source. One fact, one code.
  //
  // TWO DIFFERENT MECHANISMS, DELIBERATELY (task-14 review round 2, M6):
  //   - `checkPageContract` and the token-based lints RETURN
  //     `SourceStreamTruncatedError | …`, because `tokenize` is `gate`'s own controlled code and
  //     the project constraint permits `errore.try` only at UNCONTROLLED boundaries. They are
  //     ordinary `instanceof Error` checks.
  //   - the ENGINE can still overflow, and since task 14b fix round 1 that boundary is reached
  //     by EVERY one of these stages, not just `lintUnpointedElements`: `tokenize` now consults
  //     `./jsx`'s recursive-descent reader for the JSX text ranges it lexes around, so a page
  //     nested deeply enough throws out of the page contract and the token lints too. Measured:
  //     `"<a>{".repeat(32_000)` throws `RangeError` from `checkPageContract`,
  //     `lintDeterminism`, `lintSilencingAny`, `lintDroppedIds` and `lintUnlistedNavigation`
  //     alike. `runGate` is SYNCHRONOUSLY inside the turn pipeline, so an escaping throw would
  //     crash the turn instead of rejecting one page — the whole reason this converter exists.
  //     One `errore.try` around the group, rather than five.
  //
  // A CANDIDATE PAGE IS ALWAYS JSX. `entryRelPath`/`fileName` both name a `.tsx` entry (see
  // `fileName`'s own `${input.slug}.tsx` fallback below), and design §5 requires a page to
  // default-export a component, so there is no non-JSX page for this path to serve.
  // `runTreeImports` is the entry point that meets arbitrary tree files, and it derives the
  // syntax per file from `tree-scan.ts`'s measured `parsesJsx`.
  const read = errore.try({
    try: () => ({
      contract: checkPageContract(input.source, "jsx"),
      lints: [
        lintDeterminism(input.source, "jsx"),
        lintSilencingAny(input.source, "jsx"),
        lintDroppedIds(input.source, "jsx", input.referencedIds),
        lintUnlistedNavigation(input.source, "jsx", input.listedSlugs),
      ],
      unpointed: lintUnpointedElements(input.source),
    }),
    catch: (cause) => new PageSourceUnscannableError({ file: fileName, cause }),
  });
  if (read instanceof Error) return unscannablePage(fileName, read);

  const contract = read.contract;
  if (contract instanceof Error) return unscannablePage(fileName, contract);

  for (const lint of read.lints) {
    if (lint instanceof Error) return unscannablePage(fileName, lint);
    warnings.push(...lint);
  }
  warnings.push(...read.unpointed);

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

  return createGateResult(errors, warnings, descriptor);
}

/**
 * A membership predicate over the tree's full inventory (design §6's `has`) — shared by
 * {@link runTreeImports} below and `gate/adapters/gate-runner.ts`'s closure resolution
 * (task-13 review round 2, Minor M-e), so the two halves of one whole-tree scan can never
 * build two independently derived `Set`s that quietly drift apart on what "the tree has this
 * path" means.
 */
export function hasTreePath(treePaths: readonly string[]): (relPath: string) => boolean {
  const present = new Set(treePaths);
  return (relPath) => present.has(relPath);
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
 * WIRED (task 14 — the red-debt.md entry this used to carry is closed). This function's only
 * production caller is `gate/adapters/gate-runner.ts`'s `runTreeImports` port method, which
 * `core/turns/model/validation.ts` now calls ONCE per turn, after the manifest slice and
 * before any per-page `runPage`, per design §8's own step ordering. Until that landed this
 * function had NO non-test caller at all, so a page containing a forbidden import,
 * `eval(...)`, `new Function(...)`, `require(...)` or a dynamic `import()` passed the whole
 * Gate and reached the smoke render.
 *
 *
 * THE SOURCE-COVERAGE GAP THIS USED TO CARRY IS CLOSED (task 14b). Round 2 of task 14 warned
 * that the scan could be handed a token stream that did not cover the file — an unterminated
 * block comment opened in JSX TEXT truncated it with no signal, and Bun executed such a file
 * while this scan saw a prefix. `lexer.ts` now states the invariant that fixes it (no
 * classification uncertainty may make executable code invisible: a span it cannot classify is
 * scanned as CODE, never skipped and never consumed by a token running past it), and
 * `lexer.oracle.test.ts` measures it against Bun's own parse over the repository's sources, a
 * systematic grid in both loaders, every code point in a wide range, and seeded fuzz.
 *
 * WHAT IS STILL NOT CLOSED, so this is not read as a clean bill: design §5.8's dynamic-code ban.
 * `import-scan.ts`'s KNOWN GAPS 1-4 reach `eval`/`Function` through an alias, a variable key, a
 * concatenated key, or a `constructor.constructor` chain that writes neither identifier — all
 * four measured live (Bun accepts, `await import()` executes, this scan reports nothing), and
 * none closable by a token-level rule. Registered in the plan's red-debt ledger with no owner.
 * The wiring is proven END TO END, not asserted: `src/entrypoint/model/turn-import-perimeter
 * .test.ts` drives the REAL adapter through the REAL `runTurnValidation` and rejects each of
 * those six forms placed in a SHARED module (`lib/theme.ts`) that no page names directly —
 * the shape `runPage` structurally cannot catch — plus one clean-input row proving the guard
 * does not over-fire. `core/turns/model/validation.test.ts` pins the complementary half: that
 * the call happens at all, once, with the WHOLE tree, and that its errors reject the turn.
 */
export function runTreeImports(input: {
  readonly files: ReadonlyMap<string, string>;
  readonly treePaths: readonly string[];
}): GateError[] {
  return scanTreeImports({ files: input.files, has: hasTreePath(input.treePaths) }).map(
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
