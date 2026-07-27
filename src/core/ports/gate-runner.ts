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
}

export type GateWarningKindV1 =
  | "dropped-id"
  | "unpointed-element"
  | "unguarded-timer"
  | "unguarded-randomness"
  | "unlisted-navigation";

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

/** The staging manifest slice `pages.json` (master §6.2): the ordered page slugs the agent left in the turn workspace plus an optional requested active slug. */
export interface ManifestSliceV1 {
  readonly pages: readonly PageSlug[];
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

export interface GateRunner {
  /** The turn-level manifest-slice check (master §6.3 step 1), run once per turn before the per-page stages. */
  runManifestSlice(input: {
    readonly manifestText: string;
    readonly presentSlugs: readonly PageSlug[];
  }): Promise<ManifestSliceResultV1>;
  /** The full per-page pipeline: import allowlist, page contract, type check, determinism lints, then (only if nothing fatal yet) the manifest + smoke stages. */
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
  }): Promise<GateRunResultV1>;
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
