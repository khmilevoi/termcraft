import type { PageMeta, PageSlug } from "entities/page"

/**
 * The category of a FATAL gate violation (master §6.3). Each maps to one stage of
 * the gate pipeline; any fatal error rejects the candidate and leaves the canonical
 * source untouched.
 */
export type GateErrorKind = "import" | "contract" | "type" | "manifest" | "smoke"

/**
 * One fatal gate violation. `code` is a stable diagnostic identifier (e.g.
 * `FORBIDDEN_IMPORT`, `NON_STATIC_META`, `TYPE_ERROR`); `message` is bounded plain
 * text, never terminal control sequences (host-supervision §13). Location is
 * populated where the stage knows it (an AST position, a tsc diagnostic).
 */
export interface GateError {
  readonly kind: GateErrorKind
  readonly code: string
  readonly message: string
  readonly file?: string
  readonly line?: number
  readonly column?: number
}

/**
 * The category of a NON-FATAL gate warning (master §6.3). Warnings never reject a
 * candidate — the gate reminds, not rejects: an id an iteration dropped, a raw
 * element with no pointable id, an unguarded timer/randomness that breaks
 * determinism, or navigation to a page not in the manifest.
 */
export type GateWarningKind =
  | "dropped-id"
  | "unpointed-element"
  | "unguarded-timer"
  | "unguarded-randomness"
  | "unlisted-navigation"

/** One non-fatal gate warning. */
export interface GateWarning {
  readonly kind: GateWarningKind
  readonly message: string
  readonly line?: number
  readonly column?: number
}

/**
 * The page metadata + identity the gate parses from a passing candidate's static
 * `meta` (runtime-api §4). Tabs, status-bar sizing, export sizing, and
 * compatibility UI consume this rather than re-parsing the source.
 */
export interface PageDescriptor {
  readonly slug: PageSlug
  readonly meta: PageMeta
}

/**
 * The outcome of validating one immutable candidate page (master §6.3). `ok` is
 * derived — true only when there are NO fatal `errors` (warnings never fail a
 * candidate). `descriptor` is the parsed page metadata when the contract stage
 * passed, else `null`.
 */
export interface GateResult {
  readonly ok: boolean
  readonly errors: readonly GateError[]
  readonly warnings: readonly GateWarning[]
  readonly descriptor: PageDescriptor | null
}
