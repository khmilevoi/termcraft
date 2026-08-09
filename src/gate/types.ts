import type { PageEntryV1 } from "entities/design-tree";
import type { PageMeta, PageSlug } from "entities/page";

/**
 * The category of a FATAL gate violation (master §6.3). Each maps to one stage of
 * the gate pipeline; any fatal error rejects the candidate and leaves the canonical
 * source untouched.
 */
export type GateErrorKind = "import" | "contract" | "type" | "manifest" | "smoke";

/**
 * One fatal gate violation. `code` is a stable diagnostic identifier (e.g.
 * `FORBIDDEN_IMPORT`, `NON_STATIC_META`, `TYPE_ERROR`); `message` is bounded plain
 * text, never terminal control sequences (host-supervision §13). Location is
 * populated where the stage knows it (an AST position, a tsc diagnostic).
 */
export interface GateError {
  readonly kind: GateErrorKind;
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  /**
   * The pages this whole-tree diagnostic is ATTRIBUTED to — those whose closure contains
   * {@link GateError.file} — sorted, and absent (never `[]`) when the set is empty.
   *
   * WIDENED BY design-tree phase 2 Task 3, and the widening SUBSUMES the old reading ("the pages
   * whose closure the pass could not complete AT `file`") rather than replacing it: under one
   * flat whole-tree verdict a fatal in a shared module does block every page reaching it. Set
   * only by `gate/adapters/gate-runner.ts`'s whole-tree pass — its closure resolution (design §7)
   * for a fact that stopped a closure being proved, and its type check (design §8 step 5) for a
   * diagnostic in a file some closure reaches. Every other stage leaves it absent, because no
   * other stage holds a closure. Mirrors `core/ports/gate-runner.ts`'s `GateErrorV1.blockedPages`
   * field for field (both redraw the SAME shape per decision C1); read that one for why the
   * attribution lives on the diagnostic rather than being duplicated into one diagnostic per
   * page, and for why an ABSENT `blockedPages` is still fatal.
   */
  readonly blockedPages?: readonly PageSlug[];
}

/**
 * The category of a NON-FATAL gate warning (master §6.3). Warnings never reject a
 * candidate — the gate reminds, not rejects: an id an iteration dropped, a raw
 * element with no pointable id, a wall-clock read or an unseeded randomness call
 * that breaks determinism, navigation to a page not in the manifest, an import
 * cycle (design §8 step 2 — ESM permits one, but it is a common source of
 * `undefined`-at-module-init in this shape of code), or a module no page's closure
 * reaches (design §8 step 3 — never auto-deleted, since deleting a half-finished
 * refactor is worse than carrying it).
 *
 * RENAMED from `unguarded-timer`/`unguarded-randomness` (design-agent-feedback-loop
 * repair, Task 4, 2026-08-09): the old names promised a guard (an `isExport()`
 * wrapper) that `gate/model/lints.ts`'s `lintDeterminism` — a token scan with no
 * scope analysis — has no way to ever observe clearing. See that function's own doc
 * comment for the measured turn this fixes.
 */
export type GateWarningKind =
  | "dropped-id"
  | "unpointed-element"
  | "nondeterministic-time"
  | "nondeterministic-randomness"
  | "unlisted-navigation"
  | "silencing-any"
  | "import-cycle"
  | "dead-module";

/**
 * One non-fatal gate warning. `file` names the SOURCE this warning was produced against, and
 * every producing stage sets it: the per-page lints stamp the entry path `runGate` was called
 * with (`gate/model/gate.ts`), and the whole-tree pass stamps the tree-relative path its own
 * graph/closure warnings are about (`gate/adapters/gate-runner.ts`). It is TREE-relative — the
 * `design/` prefix is added by `core/turns/model/prompt.ts` at the moment the text becomes
 * something an agent will type into a tool call, and nowhere else.
 *
 * ABSENT means "this warning is about the TREE, not about a file", the same distinction
 * `GateErrorV1.blockedPages` documents for errors. It is not the ordinary case and a consumer
 * that finds it should not treat the warning as unlocatable-by-design.
 */
export interface GateWarning {
  readonly kind: GateWarningKind;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
  readonly file?: string;
  /**
   * The pages this warning is attributed to — those whose closure contains {@link GateWarning.file}
   * — sorted, and ABSENT (never `[]`) when the set is empty. Identical in meaning, producer and
   * absence rule to `core/ports/gate-runner.ts`'s `GateErrorV1.blockedPages`; read that field's
   * doc comment for the full account — this field does not restate it. Populated ONLY by
   * `GateRunner.runTree` (`gate/adapters/gate-runner.ts`), since no other method holds a closure.
   *
   * ADDED (design-agent-feedback-loop repair, Task 5, 2026-08-09) with closure-wide determinism
   * linting: a `Date.now()` in a module three pages share is one fact, reported once, naming the
   * module — and the agent has no import graph with which to work out which pages that module
   * made non-deterministic.
   */
  readonly blockedPages?: readonly PageSlug[];
}

/**
 * The page metadata + identity the gate parses from a passing candidate's static
 * `meta` (runtime-api §4). Tabs, status-bar sizing, export sizing, and
 * compatibility UI consume this rather than re-parsing the source.
 */
export interface PageDescriptor {
  readonly slug: PageSlug;
  readonly meta: PageMeta;
}

/**
 * The staging manifest slice `design/pages.json` decodes to, once schema validation AND
 * entry resolution both pass (design §4, `gate/model/manifest.ts`'s `checkManifestSlice`).
 * `pages` preserves the manifest's own array order — design §4: "The array order is the page
 * order" — and each entry carries the tree-relative `entry` path `pages.json` bound it to,
 * NOT a slug-derived guess: which file a page lives in is `pages.json`'s `entry` value, never
 * something derived from the slug. `active` is the manifest's optional `requestedActivePage`,
 * or `null` when it names none.
 */
export interface ManifestSlice {
  readonly pages: readonly PageEntryV1[];
  readonly active: PageSlug | null;
}

/**
 * The outcome of validating one immutable candidate page (master §6.3). `ok` is
 * derived — true only when there are NO fatal `errors` (warnings never fail a
 * candidate). `descriptor` is the parsed page metadata when the contract stage
 * passed, else `null`.
 */
export interface GateResult {
  readonly ok: boolean;
  readonly errors: readonly GateError[];
  readonly warnings: readonly GateWarning[];
  readonly descriptor: PageDescriptor | null;
}
