import type { PageMeta } from "entities/page"
import type { PageSlug } from "entities/page"

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

export type GateErrorKindV1 = "import" | "contract" | "type" | "manifest" | "smoke"

export interface GateErrorV1 {
  readonly kind: GateErrorKindV1
  readonly code: string
  readonly message: string
  readonly file?: string
  readonly line?: number
  readonly column?: number
}

export type GateWarningKindV1 = "dropped-id" | "unpointed-element" | "unguarded-timer" | "unguarded-randomness" | "unlisted-navigation"

export interface GateWarningV1 {
  readonly kind: GateWarningKindV1
  readonly message: string
  readonly line?: number
  readonly column?: number
}

/** The page metadata + identity the Gate parses from a passing candidate's static `meta` (runtime-api §4). */
export interface GatePageDescriptorV1 {
  readonly slug: PageSlug
  readonly meta: PageMeta
}

/** The outcome of validating one immutable candidate page (master §6.3). `ok` is true only when `errors` is empty — warnings never fail a candidate. */
export interface GateRunResultV1 {
  readonly ok: boolean
  readonly errors: readonly GateErrorV1[]
  readonly warnings: readonly GateWarningV1[]
  readonly descriptor: GatePageDescriptorV1 | null
}

/** The staging manifest slice `pages.json` (master §6.2): the ordered page slugs the agent left in the turn workspace plus an optional requested active slug. */
export interface ManifestSliceV1 {
  readonly pages: readonly PageSlug[]
  readonly active: PageSlug | null
}

export interface ManifestSliceResultV1 {
  readonly errors: readonly GateErrorV1[]
  readonly slice: ManifestSliceV1 | null
}

export interface GateRunner {
  /** The turn-level manifest-slice check (master §6.3 step 1), run once per turn before the per-page stages. */
  runManifestSlice(input: { readonly manifestText: string; readonly presentSlugs: readonly PageSlug[] }): Promise<ManifestSliceResultV1>
  /** The full per-page pipeline: import allowlist, page contract, type check, determinism lints, then (only if nothing fatal yet) the manifest + smoke stages. */
  runPage(input: { readonly source: string; readonly slug: PageSlug; readonly fileName?: string }): Promise<GateRunResultV1>
}
