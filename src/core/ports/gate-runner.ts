import type { ClosureV1, PageEntryV1 } from "entities/design-tree";
import type { PageMeta, PageSlug } from "entities/page";

/**
 * `GateRunner`: the two Gate invocations turn orchestration makes per this slice's plan
 * (§4, 6F description) — "candidate freeze -> manifest-slice Gate once, then per-page Gate"
 * — narrowed from `gate/index.ts`'s real `checkManifestSlice` and `runGate` per decision C1.
 * `gate`'s own `GateResult`/`GateError`/`GateWarning`/`PageDescriptor`/`ManifestScanResult`
 * are plain data (no class instances), so nothing here needs `FailureDtoV1` mapping — the
 * shapes are simply redrawn locally so `core` never imports `gate`.
 *
 * The composition root is what closes over `gate`'s real `runGate(input, ports)` — baking
 * in the heavier `typeCheck`/`checkManifest`/`smokeRender` stages (the last of which is
 * itself `gate`'s own `SmokeRenderer` port, implemented by `host`) — and hands `core` the
 * resulting `GateRunner` adapter with no `GatePorts` parameter ever visible here: item 4 of
 * code-structure.md ("the consumer declares the port") means `core` names only the two
 * calls it makes, not the internal wiring that produces their answers.
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
   * The page entries whose closure {@link GateRunner.runTreeImports} could not complete AT
   * {@link GateErrorV1.file} — the structural attribution that lets a consumer partitioning
   * diagnostics per page find this one (task-13 review round 3, Minor: the slug used to survive
   * only inside free-text `message`, so a consumer that dropped the unattributable lost both the
   * page's closure AND its diagnostic — a silent fail-open).
   *
   * This is what makes ONE diagnostic per underlying fact compatible with per-page
   * attributability: a forbidden import in a module three pages share is still reported once,
   * naming the module, and carries all three slugs here instead of being copied per reaching
   * page. Absent (never `[]`) when the fact blocked no page's closure — either no page reaches
   * the file, or every page that does resolved completely.
   *
   * Populated ONLY by `runTreeImports`; every other method on this port leaves it absent, since
   * no other method walks a closure.
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
  | "silencing-any";

export interface GateWarningV1 {
  readonly kind: GateWarningKindV1;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
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
export const PAGE_META_EXTRACTOR_VERSION = 1;

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
 * {@link GateRunner.runTreeImports}'s result: the flat allowlist errors alongside every
 * manifest entry's resolved closure. Both come out of the SAME whole-tree scan/resolve pass —
 * splitting them into two port calls would mean walking the tree's import graph twice (once
 * per method) for no reason, since the adapter already has everything it needs (the tree's
 * file text, the resolved manifest entries) to produce both in one call.
 */
export interface RunTreeImportsResultV1 {
  readonly errors: readonly GateErrorV1[];
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
   * The per-page pipeline: page contract, type check, determinism lints, then (only if
   * nothing fatal yet) the manifest + smoke stages. The import allowlist does NOT run here
   * (design §8 step 4) — see {@link runTreeImports}.
   */
  runPage(input: {
    readonly source: string;
    readonly slug: PageSlug;
    readonly fileName?: string;
    /**
     * The staged candidate's ABSOLUTE on-disk file path, needed only by the smoke stage
     * (`gate/adapters/gate-runner.ts`'s `createSmokeRender(renderer, sourcePath)`) — the real
     * host `SmokeRenderer` resolves this path via `Bun.file` in a fresh child process cwd, so
     * a bare `${slug}.tsx` never resolves there. Deliberately separate from `fileName` (which
     * stays the SHORT display name `runGate` echoes into `GateErrorV1.file` for diagnostics) —
     * conflating the two would leak an absolute filesystem path into user-facing Gate error
     * messages. Optional and additive: a caller that never staged a candidate to a real path
     * (e.g. the canonical-page validation `project.ts`/`page-pin.ts` run) omits it and keeps
     * today's `fileName`-or-bare-slug smoke default.
     */
    readonly sourcePath?: string;
    /**
     * The tree-relative path `design/pages.json` bound this entry to (design §4) — see
     * `gate/model/gate.ts`'s `GateInput.entryRelPath` for the full rationale (never derive it
     * from `slug`) and its own doc comment for the re-measured, itemized cost of making this
     * required (19 new tsc errors, spanning 2 production files this task does not own). OPTIONAL
     * here for that same measured reason: `core/turns`/`core/kernel` do not yet have a
     * `DesignTreeReader` to source it from (FLAGGED for whichever task wires one — 13 or 14,
     * both consume this port).
     */
    readonly entryRelPath?: string;
    /**
     * The entry's resolved closure (design §7), threaded through for the smoke stage and
     * future stages (design §8 steps 5 and 8 — see `runTreeImports`'s own doc for why neither
     * is implemented by this plan). Optional for the same reason as `entryRelPath` above.
     */
    readonly closure?: ClosureV1;
  }): Promise<GateRunResultV1>;
  /**
   * The whole-tree import allowlist (design §6; §8 step 4), run ONCE per turn — before any
   * per-page stage, not per page — over every file the tree names. A forbidden import in a
   * SHARED module (`lib/theme.ts`, reached by every page that imports it) compromises every
   * page that reaches it; scanning it once here, rather than once per page inside `runPage`,
   * is what catches it even in a module no page's own source ever runs `runPage` against
   * directly, and reports it exactly once rather than once per reaching page. `files` is the
   * text this turn's Gate run holds for each tree-relative path; `treePaths` is the tree's
   * full inventory (`store`'s `listTree`), which may legitimately name files `files` holds no
   * text for (a `.json`/`.md`/`.svg` asset — see `gate/model/tree-scan.ts`'s own doc for the
   * exact contract this enforces).
   *
   * `pages` is the validated manifest's own entry list (`ManifestSliceV1.pages` — a caller
   * runs `runManifestSlice` first, per design §8's own step ordering, and threads its `slice
   * .pages` through here) — what makes {@link RunTreeImportsResultV1.closures} possible at
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
   * module, with all three slugs in `blockedPages`.
   *
   * "EXACTLY ONE" is enforced, not assumed (task-13 review round 4, M-1). Both limbs are keyed
   * by SLUG, so two `pages` entries sharing a slug would otherwise satisfy both at once — one
   * entry resolving into `closures` while the other lands in some `blockedPages`, measured. The
   * adapter therefore raises `DUPLICATE_SLUG` itself and blocks EVERY entry carrying a repeated
   * slug, rather than relying on `entities/design-tree`'s `decodePagesManifest` having refused
   * it upstream: this method accepts `pages` independently of that decoder, and a guarantee that
   * lives only in another module's prose is the shape that produced round 3's Critical.
   *
   * SECURITY-CRITICAL FLAG, MUST-WIRE (task-12 review round 1 — registered in red-debt.md):
   * declared on this port, implemented by the adapter, but NO production caller invokes it yet
   * — `core/turns/model/validation.ts` calls only `runManifestSlice`/`runPage`. Task 14 (the
   * turn's real validation flow) must call this ONCE per turn, before the per-page `runPage`
   * calls, or the import allowlist (and the `eval`/`new Function` ban inside it) never actually
   * runs and a forbidden import reaches the smoke render undetected.
   */
  runTreeImports(input: {
    readonly files: ReadonlyMap<string, string>;
    readonly treePaths: readonly string[];
    readonly pages: readonly PageEntryV1[];
  }): Promise<RunTreeImportsResultV1>;
  /**
   * The page-contract stage ALONE — parses the page's static `meta` export and nothing else.
   * Deliberately NOT `runPage`: the full pipeline additionally spawns a TypeScript compiler
   * and a smoke-render child process, neither of which a caller that only wants the page's
   * declared size/theme/kit version should pay for or be blocked by. A page that fails the
   * type check still has a perfectly readable `meta`, and reporting THAT failure as "this
   * page has no settings" would be a false diagnosis.
   *
   * Cheap and pure enough to run on a `PageMetaCache` miss, which is its one caller today
   * (`core/kernel`'s `resolvePageSettings`); results cached under
   * {@link PAGE_META_EXTRACTOR_VERSION}.
   */
  extractPageMeta(input: {
    readonly source: string;
    readonly slug: PageSlug;
  }): Promise<PageMetaExtractionV1>;
}
