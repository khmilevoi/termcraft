import type { ClosureV1, DesignFileEntryV1, PageEntryV1 } from "entities/design-tree";
import type { PageMeta, PageSlug } from "entities/page";

/**
 * `GateRunner`: the two Gate invocations turn orchestration makes per this slice's plan
 * (§4, 6F description) — "candidate freeze -> manifest-slice Gate once, then per-page Gate"
 * — narrowed from `gate/index.ts`'s real `checkManifestSlice` and `runGate` per decision C1.
 * `gate`'s own `GateResult`/`GateError`/`GateWarning`/`PageDescriptor`/`ManifestScanResult`
 * are plain data (no class instances), so nothing here needs `FailureDtoV1` mapping — the
 * shapes are simply redrawn locally so `core` never imports `gate`.
 *
 * The composition root is what closes over `gate`'s real `runGate(input, ports)` and its
 * whole-tree pass — baking in the heavier stages: the `checkManifest`/`smokeRender` ports
 * `runGate` takes (the latter is itself `gate`'s own `SmokeRenderer` port, implemented by
 * `host`) and the compiler the tree type check spawns — and hands `core` the resulting
 * `GateRunner` adapter with no `GatePorts` parameter ever visible here: item 4 of
 * code-structure.md ("the consumer declares the port") means `core` names only the calls it
 * makes, not the internal wiring that produces their answers.
 */

export type GateErrorKindV1 = "import" | "contract" | "type" | "manifest" | "smoke";

export interface GateErrorV1 {
  readonly kind: GateErrorKindV1;
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  /**
   * The pages this whole-tree diagnostic is ATTRIBUTED to — those whose closure contains
   * {@link GateErrorV1.file} — sorted, and absent (never `[]`) when the set is empty.
   *
   * WIDENED BY TASK 3 (design-tree phase 2), and the widening SUBSUMES the old meaning rather
   * than replacing it. The field used to mean "the pages whose closure the pass could not
   * complete AT `file`". It now means "the pages whose closure CONTAINS `file`", which is design
   * §8 step 5's own rule ("a diagnostic in a shared file is attributed to every page whose
   * closure contains it") — and the old reading falls out of it, because under one flat
   * whole-tree verdict a fatal in a shared module does block every page that reaches it. One
   * field, one meaning, two producers inside the SAME pass:
   *
   * - the closure walk, for a fact that stopped a closure being proved complete (a bad edge, a
   *   file with no source text) — the page is then absent from
   *   {@link RunTreeResultV1.closures} entirely, and this is the only remaining signal that it
   *   was excluded (task-13 review round 3, Minor: the slug used to survive only inside free-text
   *   `message`, so a consumer that dropped the unattributable lost both the page's closure AND
   *   its diagnostic — a silent fail-open);
   * - the type check, for a diagnostic in a file some closure reaches — attributed from the
   *   closures THAT SAME PASS just resolved, never a second walk of the import graph.
   *
   * Either way it is what makes ONE diagnostic per underlying fact compatible with per-page
   * attributability: a fault in a module three pages share is reported once, naming the module,
   * carrying all three slugs here instead of being copied per reaching page.
   *
   * ABSENT IS NOT "HARMLESS", AND IT COVERS TWO DIFFERENT FACTS. Either way the diagnostic is
   * STILL fatal — the turn's verdict is whole-tree and never filters on this field — but a
   * consumer that attributes per page (`core/kernel`'s `buildPageDescriptors`) must tell them
   * apart by {@link GateErrorV1.file}:
   *
   * - absent `blockedPages` WITH a `file`: an orphan module — a real diagnostic in a file no
   *   page's closure reaches. There is no descriptor it could honestly belong to, so it
   *   invalidates none, and the consumer logs it rather than dropping it.
   * - absent `blockedPages` with NO `file`: a statement about the TREE, not about any page —
   *   most consequentially the type check's own `TYPE_CHECK_UNAVAILABLE`, one fatal for the whole
   *   tree with no file precisely so it is never mis-attributed to one page. A per-page consumer
   *   must invalidate EVERY page for it. Treating it as "names no page, so it invalidates
   *   nothing" publishes a whole project as valid on the strength of a compiler that never ran.
   *
   * Populated ONLY by {@link GateRunner.runTree}; every other method on this port leaves it
   * absent, since no other method holds a closure.
   */
  readonly blockedPages?: readonly PageSlug[];
}

export type GateWarningKindV1 =
  | "dropped-id"
  | "unpointed-element"
  | "unguarded-timer"
  | "unguarded-randomness"
  | "unlisted-navigation"
  // `any` written to make a type error go away — the escape hatch that turns a diagnostic the
  // gate DID catch into a crash it cannot. See `gate/model/lints.ts`'s `lintSilencingAny`.
  | "silencing-any"
  // Design §8 step 2 — an import cycle: ESM permits one, but it is a common source of
  // `undefined`-at-module-init in this shape of code. Set only by {@link GateRunner.runTree},
  // one warning per cycle (see `gate/adapters/gate-runner.ts`'s `findImportCycles`).
  | "import-cycle"
  // Design §8 step 3 — a code file no page's PROVEN closure reaches. Set only by
  // {@link GateRunner.runTree}; never auto-deletes the file, since deleting a half-finished
  // refactor is worse than carrying it.
  | "dead-module";

/**
 * One non-fatal gate warning. `file` mirrors `gate/types.ts`'s own `GateWarning.file` field for
 * field (both redraw the SAME shape per decision C1) — set for `import-cycle`/`dead-module`
 * (both are ABOUT a file, so an unnamed one would be unactionable), absent for every other kind,
 * none of which is produced against a single tree-relative path.
 */
export interface GateWarningV1 {
  readonly kind: GateWarningKindV1;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
  readonly file?: string;
}

/** The page metadata + identity the Gate parses from a passing candidate's static `meta` (runtime-api §4). */
export interface GatePageDescriptorV1 {
  readonly slug: PageSlug;
  readonly meta: PageMeta;
}

/** The outcome of validating one immutable candidate page (master §6.3). `ok` is true only when `errors` is empty — warnings never fail a candidate. */
export interface GateRunResultV1 {
  readonly ok: boolean;
  readonly errors: readonly GateErrorV1[];
  readonly warnings: readonly GateWarningV1[];
  readonly descriptor: GatePageDescriptorV1 | null;
}

/**
 * The staging manifest slice `design/pages.json` decodes to (design §4; master §6.2), once
 * schema validation AND entry resolution both pass — `pages` is `PageEntryV1[]`, not a bare
 * slug list, because which file a page lives in is `pages.json`'s `entry` value, never
 * something derivable from the slug alone (task 10/12: this port used to redraw `pages` as
 * `PageSlug[]`, which cannot carry `entry` at all — the exact gap that made
 * `gate/adapters/gate-runner.ts`'s bridge to `gate/model/manifest.ts`'s real
 * `checkManifestSlice` impossible to satisfy honestly). `active` is the manifest's optional
 * `requestedActivePage`, or `null` when it names none.
 */
export interface ManifestSliceV1 {
  readonly pages: readonly PageEntryV1[];
  readonly active: PageSlug | null;
}

export interface ManifestSliceResultV1 {
  readonly errors: readonly GateErrorV1[];
  readonly slice: ManifestSliceV1 | null;
}

/**
 * The identity of the meta-EXTRACTION algorithm, and the third component of
 * `PageMetaCache`'s own `PageMetaKeyV1` (`core/ports/projections.ts`) — a cached entry is
 * only valid for the extractor that produced it, so a cache read and the write that fills
 * it must name the SAME version or every read misses forever.
 *
 * This is the real owner storage-identity §7 always implied and no module had claimed:
 * `core/kernel`'s `resolvePageSettings` used to key its reads on a local
 * `PAGE_META_EXTRACTOR_VERSION_PLACEHOLDER` of its own, which its own doc comment named as
 * "the one line to replace" once a canonical owner existed. It lives HERE, on the port that
 * declares the extraction ({@link GateRunner.extractPageMeta}), rather than next to the key
 * in `projections.ts`: the number identifies the extractor, and the cache merely keys on it.
 *
 * BUMP THIS whenever the Gate's page-contract meta extraction changes what it returns for
 * unchanged source (new/renamed `PageMeta` field, changed default, changed parse semantics).
 * Bumping it invalidates every cached entry by construction — no eviction pass is needed.
 */
// BUMPED 1 -> 2 (task 16 fix round 1): `extractPageMeta` now reads a `.ts` entry as TypeScript
// instead of assuming JSX (`parsesJsx(entryRelPath)` replaced a hardcoded `"jsx"`), which changes
// what a `.ts`-entry page's meta extraction returns for unchanged source. A `.tsx` entry's
// reading is unaffected, but the version is per-extractor, not per-entry-shape, so every cached
// entry is invalidated by construction rather than auditing which ones actually changed.
export const PAGE_META_EXTRACTOR_VERSION = 2;

/**
 * The outcome of {@link GateRunner.extractPageMeta}: the page's static `meta` when the page
 * contract holds, else the fatal contract errors explaining why it does not. `meta` and a
 * non-empty `errors` are mutually exclusive — a `null` meta always carries at least one error.
 */
export interface PageMetaExtractionV1 {
  readonly meta: PageMeta | null;
  readonly errors: readonly GateErrorV1[];
}

/**
 * One manifest entry's resolved closure (design §7): `slug` is the identity, `files` is the
 * transitive tree-relative file set `entities/design-tree`'s `resolveClosure` walked from
 * `entry` — sorted, always including `entry` itself. This is `core/turns/model/candidate.ts`'s
 * `selectChangedPages` own `closures` input, structurally — that function is typed against an
 * inline shape rather than this name so it stays independently testable with no port import,
 * but the two must never drift, since this is its one real producer.
 */
export interface GateClosureV1 {
  readonly slug: PageSlug;
  readonly files: readonly string[];
}

/**
 * {@link GateRunner.runTree}'s result: every diagnostic the whole-tree pass produced —
 * the flat allowlist scan's, the closure walk's, and the type check's — alongside every
 * manifest entry's resolved closure. All of them come out of the SAME pass, because splitting
 * them across port calls would mean walking the tree's import graph (and spawning the compiler)
 * once per method for no reason: the adapter already holds everything it needs (the tree's file
 * text, the resolved manifest entries) to produce all three in one call.
 */
export interface RunTreeResultV1 {
  readonly errors: readonly GateErrorV1[];
  /**
   * The pass's non-fatal findings (design §8 steps 2 and 3, design-tree phase 2 Task 4):
   * `import-cycle` for every cycle among the edges the closure walk resolved, `dead-module` for
   * every code file no page's PROVEN closure reaches. Both are derived from data
   * `gate/adapters/gate-runner.ts`'s `resolveTreeClosures` already built resolving `closures`
   * above — no second file read, no second edge reader. `dead-module` is suppressed for the
   * WHOLE tree, not per file, the
   * moment any entry's closure could not be resolved (a warning built on a graph this pass never
   * finished reading is worse than none); an unscannable file's edges are unknown, so it can
   * never appear as an `import-cycle` member.
   */
  readonly warnings: readonly GateWarningV1[];
  readonly closures: readonly GateClosureV1[];
}

export interface GateRunner {
  /**
   * The turn-level manifest-slice check (master §6.3 step 1; design §8 step 1), run once per
   * turn before the per-page stages. `treePaths` is entry resolution's universe — every
   * tree-relative path present in the staged `design/` tree (design §4: "It must resolve to
   * a real file inside the tree") — NOT the turn's page slugs (`presentSlugs`, this port's
   * pre-design-tree shape): a slug list cannot answer whether an `entry` resolves to a real
   * file, only the tree's own inventory can.
   */
  runManifestSlice(input: {
    readonly manifestText: string;
    readonly treePaths: readonly string[];
  }): Promise<ManifestSliceResultV1>;
  /**
   * The per-page pipeline: page contract and determinism lints, then (only if nothing fatal
   * yet) the manifest + smoke stages.
   *
   * TWO STAGES DELIBERATELY DO NOT RUN HERE, both for the same reason — a shared module belongs
   * to no single page, so a per-page reading of it is either redundant or blind:
   * - the import allowlist (design §8 step 4), moved out in task 12;
   * - the TYPE CHECK (design §8 step 5), moved out by design-tree phase 2 Task 3. The per-file
   *   program it used to run served a virtual FS holding that one file, so a page importing a
   *   sibling failed with a spurious `TS2307` — measured. One program over the whole tree is the
   *   only shape that can type-check a page which imports shared code at all.
   *
   * Both now live in {@link runTree}, which a caller runs ONCE before this loop. A caller that
   * needs a page's `"invalid"` verdict — `core/kernel`'s `buildPageDescriptors` — must fold that
   * pass's errors in by {@link GateErrorV1.blockedPages}; running only this method would report
   * a type-clean page that does not compile.
   */
  runPage(input: {
    readonly source: string;
    readonly slug: PageSlug;
    /**
     * The ABSOLUTE on-disk `…/design` directory of the tree this page lives in, plus that
     * tree's `(relPath, sha256)` inventory — needed only by the smoke stage
     * (`gate/model/smoke.ts`'s `createSmokeRender`), which mounts the page's WHOLE closure and
     * hash-verifies every member before running any of it (design §6, §9.2).
     *
     * REPLACED a single `sourcePath` in task 15. The reason it cannot stay one path: a
     * candidate page is its closure, so a smoke render of the entry alone proves nothing about
     * the shared module that would actually throw.
     *
     * REQUIRED (task 16): every production caller supplies it, so a refusal on a missing tree
     * root is now impossible to construct.
     */
    readonly treeRoot: string;
    /** See {@link treeRoot} — the two are supplied together. */
    readonly expectedFiles: readonly DesignFileEntryV1[];
    /**
     * The tree-relative path `design/pages.json` bound this entry to (design §4) — see
     * `gate/model/gate.ts`'s `GateInput.entryRelPath` for the full rationale (never derive it
     * from `slug`).
     *
     * REQUIRED (task 16): every production caller supplies it, so a refusal on a missing entry
     * is now impossible to construct.
     */
    readonly entryRelPath: string;
    /**
     * The entry's resolved closure (design §7), threaded through for the smoke stage. Optional:
     * `page-descriptors.ts` has no closure to give, and deriving one per descriptor publish
     * would mean running the synchronous whole-tree scan whose cost Task 3 exists to bound —
     * controller ruling #15's trade, unchanged.
     *
     * NOT what decides {@link smoke}: "did this page change" is a comparison against the turn's
     * SEND-TIME read set, which no implementation of this port can see.
     */
    readonly closure?: ClosureV1;
    /**
     * Design §8 step 8 — whether this page's SMOKE RENDER runs at all. Everything else the
     * per-page pipeline does still runs either way; only the stage that spawns a host child
     * process is scoped.
     *
     * REQUIRED, WITH NO DEFAULT ANYWHERE IN THE CHAIN (port, adapter, gate model), because both
     * possible defaults fail silently: `"skip"` would stop smoke-testing everything the moment a
     * caller forgot the field, and `"run"` would make a caller that forgot to scope
     * indistinguishable from one that scoped correctly — which is the entire regression this
     * field exists to prevent. So each caller states it:
     *
     * - `core/turns/model/validation.ts` passes `"run"` exactly for the slugs
     *   `core/turns/model/candidate.ts`'s `selectChangedPages` reports as changed between the
     *   turn's send-time read set and the frozen candidate — the SAME function that produces the
     *   turn's own `changedPages` report, called rather than re-derived so the Gate's smoke
     *   selection and that report can never disagree — plus any page whose closure
     *   {@link runTree} did not prove, since "I cannot prove it is unchanged" is never
     *   "unchanged".
     * - `core/kernel/model/handlers/page-descriptors.ts` passes `"run"` unconditionally: a
     *   descriptor publish has no send-time read set to diff a closure against, and quietly
     *   weakening what a project open validates is not what smoke scoping is for.
     *
     * WHY THIS MATTERS (design §8: "Step 8 is what keeps the Gate affordable"): a smoke render
     * is a host child process per page. Without scoping, one edit to a module three pages share
     * smokes all three on every attempt — up to four attempts a turn.
     */
    readonly smoke: "run" | "skip";
  }): Promise<GateRunResultV1>;
  /**
   * THE WHOLE-TREE PASS (design §8 steps 4 and 5) — the single place a tree is judged, run ONCE
   * per tree read, before any per-page stage and never per page. In order:
   *
   * 1. the flat import allowlist (design §6) over every code file the tree names;
   * 2. every manifest entry's closure resolution (design §7);
   * 3. ONE `tsc` program over the whole tree, whose diagnostics are attributed back onto the
   *    closures step 2 just produced.
   *
   * A fault in a SHARED module (`lib/theme.ts`, reached by every page that imports it)
   * compromises every page that reaches it; judging it once here, rather than once per page
   * inside `runPage`, is what catches it even in a module no page's own source ever runs
   * `runPage` against directly, and reports it exactly once rather than once per reaching page.
   * For the type check it is stronger than economy: the per-file program this replaced served a
   * virtual FS holding one file, so a page importing a sibling failed with a spurious `TS2307`
   * — one whole-tree program is the only shape that can check such a page at all.
   *
   * `files` is the text the caller holds for each tree-relative path; `treePaths` is the tree's
   * full inventory (`store`'s `listTree`), which may legitimately name files `files` holds no
   * text for (a `.json`/`.md`/`.svg` asset — see `gate/model/tree-scan.ts`'s own doc for the
   * exact contract this enforces).
   *
   * `pages` is the validated manifest's own entry list (`ManifestSliceV1.pages` — a caller
   * runs `runManifestSlice` first, per design §8's own step ordering, and threads its `slice
   * .pages` through here) — what makes {@link RunTreeResultV1.closures} possible at
   * all: a closure is walked FROM an entry, and the entry-to-slug binding is `pages.json`'s
   * own job, never derivable from a slug (task-13 review round 1, Critical C1 — the same
   * whole-tree scan this method already runs is what resolves every entry's transitive file
   * set, so producing `closures` here costs no second tree walk).
   *
   * CONTRACT — the joint invariant (task-13 review round 3; rounds 1 and 2 each satisfied one
   * half of it by breaking the other). For every entry in `pages`, EXACTLY ONE of these holds,
   * and the adapter enforces both halves in one pass:
   *
   * 1. the slug appears in `closures` with a file list this pass PROVED complete — every code
   *    file it reaches had source text in `files`, was read to the end by the flat allowlist
   *    scan, and carries no edge form (`export … from`, `import(…)`, `require(…)`) that the
   *    closure walk's own edge reader deliberately does not follow; or
   * 2. the slug is absent from `closures` — never a truncated file list a caller could mistake
   *    for the whole thing — and at least one entry in `errors` names it in
   *    {@link GateErrorV1.blockedPages}.
   *
   * And every diagnostic is emitted ONCE PER UNDERLYING FACT, never once per page that happens
   * to reach it: a bad import in a module three pages share is one `errors` entry naming the
   * module, with all three slugs in `blockedPages`. A TYPE diagnostic follows the same rule and
   * the same field, attributed to every page whose resolved closure CONTAINS its `file` — see
   * {@link GateErrorV1.blockedPages} for why that widening subsumes the closure walk's own
   * meaning rather than competing with it. Note the asymmetry, which is not an inconsistency: a
   * closure blocker EXCLUDES its pages from `closures`, a type error does not — a page whose
   * shared module does not compile still has a perfectly well-defined file set.
   *
   * "EXACTLY ONE" is enforced, not assumed (task-13 review round 4, M-1). Both limbs are keyed
   * by SLUG, so two `pages` entries sharing a slug would otherwise satisfy both at once — one
   * entry resolving into `closures` while the other lands in some `blockedPages`, measured. The
   * adapter therefore raises `DUPLICATE_SLUG` itself and blocks EVERY entry carrying a repeated
   * slug, rather than relying on `entities/design-tree`'s `decodePagesManifest` having refused
   * it upstream: this method accepts `pages` independently of that decoder, and a guarantee that
   * lives only in another module's prose is the shape that produced round 3's Critical.
   *
   * WIRED (task 14 — the red-debt.md SECURITY-CRITICAL must-wire has a caller now).
   *
   * WIRED, AND THE SOURCE-COVERAGE GAP IT USED TO CARRY IS CLOSED (task 14b). Round 2 of task
   * 14 qualified this with "wired is not closed", because the scan could still be handed a token
   * stream that did not cover the file. `gate/model/lexer.ts` now states and enforces the
   * invariant that fixed it — no classification uncertainty may make executable code invisible
   * — and `gate/model/lexer.oracle.test.ts` measures it against Bun's own parse. What is NOT
   * closed, and is registered in the plan's red-debt ledger with no owner, is design §5.8's
   * dynamic-code ban: `import-scan.ts`'s KNOWN GAPS 1-4 reach `eval`/`Function` through alias
   * and property indirection no token-level scan can follow. Read this method as "the import
   * perimeter holds; the dynamic-code ban is best-effort".
   *
   * TWO PRODUCTION CALLERS, both running it exactly once per tree they judge:
   * - `core/turns/model/validation.ts`, once per turn, after `runManifestSlice` and before any
   *   per-page `runPage`, threading `slice.pages` through as `pages`. It is called
   *   UNCONDITIONALLY, including when the manifest itself failed to decode (with an empty
   *   `pages`): the flat allowlist scan covers every code file in the tree regardless of which
   *   pages exist, so skipping it on a bad manifest would hide every import violation behind a
   *   manifest typo and spend one of only four attempts learning about just one of them.
   * - `core/kernel/model/handlers/page-descriptors.ts`'s `buildPageDescriptors`, once per
   *   descriptor publish (project open, and after every commit). It cannot skip it: this is
   *   where the type check lives now, and a descriptor path that ran only `runPage` would
   *   publish `"ready"` for a page that does not compile.
   *
   * The TURN's verdict over the returned `errors` is WHOLE-TREE — any error rejects the turn,
   * and nothing filters by `file` or by {@link GateErrorV1.blockedPages}. That is a deliberate
   * choice, not an omission: `gate/model/tree-scan.ts`'s `isTrustedTarget` vouches for an
   * importer whose target is a key in `files` even when that target's OWN scan threw, which is
   * harmless under one flat verdict and becomes a fail-open the moment a consumer attributes
   * rejections per page or per file (task-12b review round 1, Minor M4). For the turn,
   * `blockedPages` is carried to the agent as a diagnostic, never consulted to decide pass/fail.
   *
   * The DESCRIPTOR path is the one consumer that legitimately attributes per page, because its
   * output IS per page — one `PageDescriptorV1` per slug, `"ready"` or `"invalid"`. It stays
   * honest about the gap above by never treating an unattributed diagnostic as absent: an orphan
   * module's diagnostic invalidates nothing and is logged, while a file-less TREE-WIDE fatal
   * invalidates every page. See {@link GateErrorV1.blockedPages} for why that split is not
   * optional.
   */
  runTree(input: {
    readonly files: ReadonlyMap<string, string>;
    readonly treePaths: readonly string[];
    readonly pages: readonly PageEntryV1[];
  }): Promise<RunTreeResultV1>;
  /**
   * The page-contract stage ALONE — parses the page's static `meta` export and nothing else.
   * Deliberately NOT `runPage`, and deliberately not {@link runTree} either: between them those
   * spawn a TypeScript compiler and a smoke-render child process, neither of which a caller that
   * only wants the page's declared size/theme/kit version should pay for or be blocked by. A
   * page that fails the type check still has a perfectly readable `meta`, and reporting THAT
   * failure as "this page has no settings" would be a false diagnosis.
   *
   * Cheap and pure enough to run on a `PageMetaCache` miss, which is its one caller today
   * (`core/kernel`'s `resolvePageSettings`); results cached under
   * {@link PAGE_META_EXTRACTOR_VERSION}.
   */
  extractPageMeta(input: {
    readonly source: string;
    readonly slug: PageSlug;
    /**
     * The tree-relative path `design/pages.json` bound this entry to (design §4) — decides
     * whether the source is read as JSX or plain TypeScript (see `gate/adapters/gate-runner.ts`'s
     * `extractPageMeta` for the residual this closes: a `pages/a.ts` entry is legal under
     * `entryPathSchema` and used to be read here as JSX regardless).
     */
    readonly entryRelPath: string;
  }): Promise<PageMetaExtractionV1>;
}
