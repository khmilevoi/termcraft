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
import { parsesJsx, scanTreeImports } from "./tree-scan";

/**
 * One page's own source could not be tokenized to the end (`lexer.ts`'s
 * {@link SourceStreamTruncatedError}, or any other throw out of the lexer/contract/lint
 * stack). Carried as a value so {@link runGate} turns it into an ordinary fatal for that page
 * instead of letting it escape into the turn — the same shape and the same reasoning as
 * `tree-scan.ts`'s `TreeFileUnscannableError` for the whole-tree scan. EXPORTED (task 16 fix
 * round 1) so `gate/adapters/gate-runner.ts`'s `extractPageMeta` constructs the identical class
 * for the identical failure over its own `checkPageContract` call, rather than a second,
 * divergent one.
 */
export class PageSourceUnscannableError extends errore.createTaggedError({
  name: "PageSourceUnscannableError",
  message: 'the page source at "$file" could not be read to the end',
}) {}

/**
 * The readable text for an UNSCANNABLE_SOURCE diagnostic: `error`'s own message, with its
 * `cause`'s name/message appended when present so the diagnostic names the real reason (a JSX
 * nesting ceiling, a scanner overflow) rather than only the wrapper's generic text. EXPORTED
 * (task 16 fix round 1, Important 2) so `gate/adapters/gate-runner.ts`'s `extractPageMeta` can
 * report the identical failure over the identical `checkPageContract` call the same way, rather
 * than re-deriving this unwrap a second time.
 */
export function unscannableMessage(error: Error): string {
  const cause = error.cause;
  return cause instanceof Error
    ? `${error.message} — ${cause.name}: ${cause.message}`
    : error.message;
}

/**
 * The one fatal {@link runGate} returns for a page whose source could not be read to the end,
 * whichever of the two mechanisms reported it — a returned `SourceStreamTruncatedError` or a
 * caught engine throw.
 */
function unscannablePage(fileName: string, error: Error): GateResult {
  return createGateResult(
    [
      {
        kind: "contract",
        code: "UNSCANNABLE_SOURCE",
        message: `${fileName}: ${unscannableMessage(error)}`,
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
 * The gate's injected PER-PAGE validation stages that need more than the page source
 * (code-structure ports). Each is optional so the pipeline runs the source-only checks
 * standalone and gains the heavier stages as they are wired: `checkManifest` (T5, gated on the
 * phase-4 pages.json schema) and `smokeRender` (T6, the host's one-shot SmokeRenderer). Each may
 * be sync or async and returns fatal `GateError`s.
 *
 * `typeCheck` USED TO BE HERE and is gone (design-tree phase 2 Task 3). It ran one `tsc` program
 * per entry file over a virtual FS holding only that file, so a page importing a shared module
 * failed with a spurious `TS2307` — measured. The check now runs ONCE over the whole tree, in
 * `gate/adapters/gate-runner.ts`'s `runTree`, which is also the only place that can attribute a
 * shared module's diagnostic to the pages reaching it. Do not reintroduce a per-page one.
 */
export interface GatePorts {
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
 * One candidate page to validate: its source, its slug, and its manifest entry path.
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
   * (`pages/<slug>.tsx`) was exactly the anti-pattern this plan exists to remove.
   *
   * REQUIRED (task 16): every production caller now supplies it
   * (`core/turns/model/validation.ts`, `core/kernel/model/handlers/page-descriptors.ts`), so a
   * refusal on a missing one is now impossible to construct.
   */
  readonly entryRelPath: string;
  /**
   * The entry's resolved closure (design §7) — threaded through for the smoke stage. Step 5's
   * whole-tree `tsc` program does NOT read it: that check runs over the whole tree at once, in
   * `gate/adapters/gate-runner.ts`'s `runTree`, and never per page.
   *
   * NOT WHAT DECIDES {@link smoke} EITHER, which is the other thing design §8 step 8 could have
   * been built on and deliberately was not: whether a closure CHANGED is a comparison against
   * the turn's send-time read set, which this ring cannot see and must never guess at from the
   * file list in hand.
   *
   * STAYS OPTIONAL, deliberately, unlike `entryRelPath` above (task 16): `page-descriptors.ts`
   * has no closure to give, and deriving one per descriptor publish would mean running the
   * synchronous whole-tree scan whose cost Task 3 exists to bound — controller ruling #15's
   * trade, unchanged.
   */
  readonly closure?: ClosureV1;
  /**
   * Design §8 step 8 — whether this page's SMOKE RENDER runs at all. The caller decides:
   * `core/turns/model/validation.ts` passes `"run"` only for the pages whose closure hash
   * differs from the turn's send-time read set (`core/turns/model/candidate.ts`'s
   * `selectChangedPages`, the same function that produces the turn's own `changedPages`
   * report), `"skip"` for the rest; `core/kernel/model/handlers/page-descriptors.ts` passes
   * `"run"` unconditionally, having no send-time read set to diff against.
   *
   * REQUIRED, WITH NO DEFAULT, and the two possible defaults are why. `"skip"` would silently
   * stop smoke-testing everything the day a caller forgot the field — a catastrophic, invisible
   * regression. `"run"` would hide exactly the caller this task exists to scope, so a
   * regression to "smoke every page on every attempt" would look identical to correct code.
   * Neither failure is detectable from a call site, so the field is stated at every call site.
   *
   * SCOPES THE SMOKE STAGE ALONE. Everything else {@link runGate} does — the page contract, the
   * determinism lints, the manifest stage — still runs for every page, and the existing
   * precondition (nothing fatal yet) is untouched: `"run"` never forces a smoke render onto a
   * candidate whose contract is broken.
   */
  readonly smoke: "run" | "skip";
  /** Ids the caller's current selection or open pins reference (`dropped-id`). */
  readonly referencedIds?: readonly string[];
  /** The staged manifest slice's page list (`unlisted-navigation`). */
  readonly listedSlugs?: readonly PageSlug[];
}

/**
 * Run the validation gate over one immutable candidate page (master §6.3). The page contract
 * (§4) is fatal; the determinism lints (§6.3) are warnings. The manifest + smoke stages run
 * ONLY when nothing fatal has surfaced yet, because a candidate with a broken contract must
 * never be imported/rendered. A candidate passes only when there are zero fatal errors;
 * warnings never reject.
 *
 * TWO STAGES DELIBERATELY DO NOT RUN HERE, both moved out for the same reason — a shared module
 * belongs to no single page, so a per-page reading of it is either redundant or blind:
 * the static-import allowlist (§3.1; task 12) and the TYPE CHECK (§8 step 5; design-tree phase 2
 * Task 3). Both now live in the whole-tree pass, whose port method is `GateRunner.runTree`. This
 * function's result is therefore NOT a complete verdict on a page by itself — a caller must fold
 * the pass's own diagnostics in, as `core/turns/model/validation.ts` and
 * `core/kernel/model/handlers/page-descriptors.ts` both do.
 */
export async function runGate(input: GateInput, ports: GatePorts = {}): Promise<GateResult> {
  const errors: GateError[] = [];
  const warnings: GateWarning[] = [];
  // The display name is `pages.json`'s own `entry` value (design §4) — never derived from
  // `slug`.
  const fileName = input.entryRelPath;

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
  //   - the ENGINE can still throw — since task 3 the dominant cause is `./jsx`'s own deliberate
  //     `JsxNestingTooDeepError`, raised past `MAX_JSX_NESTING_DEPTH`, with a `RangeError` from
  //     the raw JS stack limit as the residual for a shape that reaches it first — and since
  //     task 14b fix round 1 that boundary is reached by EVERY one of these stages, not just
  //     `lintUnpointedElements`: `tokenize` now consults `./jsx`'s recursive-descent reader for
  //     the JSX text ranges it lexes around, so a page nested deeply enough throws out of the
  //     page contract and the token lints too. Measured: `"<a>{".repeat(32_000)` throws
  //     `JsxNestingTooDeepError` from `checkPageContract`, `lintDeterminism`, `lintSilencingAny`,
  //     `lintDroppedIds` and `lintUnlistedNavigation` alike. `runGate` is SYNCHRONOUSLY inside
  //     the turn pipeline, so an escaping throw would crash the turn instead of rejecting one
  //     page — the whole reason this converter exists. One `errore.try` around the group, rather
  //     than five.
  //
  // THE PAGE'S SYNTAX IS DERIVED FROM ITS OWN PATH, not assumed (task 14b fix round 2, Minor
  // 2). This used to assert "a candidate page is always JSX" because `entryRelPath`/`fileName`
  // name a `.tsx` entry — but nothing enforces that: `entryPathSchema`
  // (`entities/design-tree`'s `manifest.ts`) places no constraint on the extension, so
  // `pages/a.ts` is a legal entry and Bun parses no JSX in it. `parsesJsx` is the same measured
  // predicate `runTreeImports` uses, so a page and a shared module of the same name are read
  // identically.
  const syntax = parsesJsx(fileName);
  const read = errore.try({
    try: () => ({
      contract: checkPageContract(input.source, syntax),
      lints: [
        lintDeterminism(input.source, syntax),
        lintSilencingAny(input.source, syntax),
        lintDroppedIds(input.source, syntax, input.referencedIds),
        lintUnlistedNavigation(input.source, syntax, input.listedSlugs),
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

  const descriptor: PageDescriptor | null =
    contract.meta === null ? null : { slug: input.slug, meta: contract.meta };

  // Only mount/render/consult the manifest when the candidate is otherwise safe: a broken
  // contract means the source cannot be imported or rendered, so skip the heavier stages.
  if (errors.length === 0 && descriptor !== null) {
    if (ports.checkManifest !== undefined)
      errors.push(...(await ports.checkManifest(descriptor, input.source)));
    // TWO INDEPENDENT PRECONDITIONS ON THE SMOKE STAGE, and the second is ADDITIVE (design §8
    // step 8). The one above is about SAFETY — a candidate with a broken contract must never be
    // imported or rendered — and is unchanged. This one is about COST: rendering a page whose
    // whole closure is byte-identical to the send-time read set spawns a host child process per
    // page per attempt (up to four attempts a turn) to re-derive an answer that cannot have
    // moved. `input.smoke` is the caller's decision, never inferred here — see
    // {@link GateInput.smoke} for why it has no default on either side.
    if (input.smoke === "run" && ports.smokeRender !== undefined)
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
 * DONE SINCE (design §8 step 5): the type check is no longer one `tsc` program per entry file —
 * `gate/adapters/gate-runner.ts`'s `runTree` runs ONE program over the whole tree, in the same
 * pass this scan opens. DONE SINCE (design §8 step 8): the smoke render no longer runs for every
 * present page — {@link GateInput.smoke} carries the caller's per-page decision, and
 * `core/turns/model/validation.ts` sets it from the closures THIS pass resolves.
 *
 * WIRED (task 14 — the red-debt.md entry this used to carry is closed). This function's only
 * production caller is `gate/adapters/gate-runner.ts`'s `runTree` port method, which
 * `core/turns/model/validation.ts` calls ONCE per turn, after the manifest slice and
 * before any per-page `runPage`, per design §8's own step ordering, and which
 * `core/kernel/model/handlers/page-descriptors.ts` calls ONCE per descriptor publish. Until task
 * 14 landed this
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
