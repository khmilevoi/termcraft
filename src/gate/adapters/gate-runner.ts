import * as errore from "errore";

import type {
  AssertConforms,
  GateClosureV1,
  GateRunResultV1,
  GateRunner,
  ManifestSliceResultV1,
  PageMetaExtractionV1,
  RunTreeImportsResultV1,
} from "core/ports";
import { PAGES_MANIFEST_RELPATH, resolveClosure } from "entities/design-tree";
import type { ClosureV1, PageEntryV1 } from "entities/design-tree";
import type { PageSlug } from "entities/page";

// Relative (not `gate`'s own barrel): `gate/index.ts` re-exports this adapter (Task 6's own
// change), so importing the barrel back from here would be a self-referencing cycle.
import { hasTreePath, runGate, runTreeImports } from "../model/gate";
import type { GatePorts } from "../model/gate";
import { checkManifestSlice } from "../model/manifest";
import { checkPageContract } from "../model/page-contract";
import { createSmokeRender } from "../model/smoke";
import { isCodeFile, parsesJsx, scanModuleEdges } from "../model/tree-scan";
import { createTypeChecker } from "../model/type-check";
import type { SmokeRenderer } from "../ports/smoke-renderer";
import type { GateError, GateErrorKind } from "../types";

/**
 * `createGateRunnerAdapter`: the production `GateRunner` over `gate`'s real `runGate`/
 * `checkManifestSlice` (adapter-ring plan, Task 6). `gate`'s own `GateResult`/`GateError`/
 * `GateWarning`/`PageDescriptor`/`ManifestScanResult` are structurally identical to the
 * port's `GateRunResultV1`/`GateErrorV1`/`GateWarningV1`/`GatePageDescriptorV1`/
 * `ManifestSliceResultV1` (both redraw the SAME shapes per decision C1), so `runGate`'s and
 * `checkManifestSlice`'s return values satisfy the port's return types directly — no
 * per-field mapping function is needed, only async wrapping for the sync
 * `checkManifestSlice`.
 *
 * FLAGGED, NOT FIXED HERE (core-owned port-shape limitation, out of WP-2's scope):
 * `GateRunner.runPage`'s input (`core/ports/gate-runner.ts:76-80`) carries only
 * `{ source, slug, fileName? }` — it does NOT expose `GateInput.referencedIds`/
 * `listedSlugs` (`gate/model/gate.ts:44-47`), so the `dropped-id`/`unlisted-navigation`
 * warning lints stay dormant whenever a page is validated through this port. Note it here,
 * do not invent the fields.
 *
 * CLOSED (was FLAGGED): `runPage`'s input now carries a dedicated `sourcePath` (`core/ports
 * /gate-runner.ts`, additive optional field) for the smoke stage's `SmokeRequest.sourcePath`
 * (`gate/model/smoke.ts`'s `createSmokeRender(renderer, sourcePath)`), separate from
 * `fileName` (the SHORT display name `runGate` echoes into `GateErrorV1.file`). When a caller
 * supplies it — the real host `SmokeRenderer` resolves it via `Bun.file` in a fresh child
 * process cwd, so a bare `${slug}.tsx` never resolves there — it is used for the smoke
 * request; otherwise this adapter falls back to `fileName` (or its own `${slug}.tsx` default,
 * the SAME default `runGate` itself applies internally), preserving every existing caller's
 * behavior unchanged.
 *
 * CLOSED (phase-8 Task 7): `typeCheck` is wired whenever BOTH `tscExePath` and `runtimeDts` are
 * supplied, and the composition root now always supplies both. `entrypoint/model/
 * create-shell.ts`'s `interactiveShell` resolves `tscExePath` via `gate/model/tsc-extract.ts`'s
 * `resolveCompilerPath()` before any project I/O runs — a failed resolution aborts the whole
 * shell construction as a `ShellCompositionError` rather than reaching this adapter at all — and
 * passes `runtime/generated/runtime-dts.ts`'s generated `RUNTIME_DTS` as `runtimeDts`. So in the
 * shipped configuration `typeCheck` is never actually omitted; the `tscExePath`/`runtimeDts`
 * parameters stay OPTIONAL on this adapter only so a caller with no compiler available (a unit
 * test, a hermetic fixture) can still run the source-only stages standalone — `runGate`'s own
 * `ports.typeCheck` parameter being optional is what makes that fallback honest, never a
 * fabricated pass.
 *
 * CLOSED (task 10/12): `runManifestSlice`'s input carries `treePaths` (design tree file
 * inventory), not the pre-design-tree `presentSlugs` (page slugs) — a slug list could never
 * honestly answer whether a manifest `entry` resolves to a real file, only `gate/model/
 * manifest.ts`'s real `checkManifestSlice` (Task 10) already required `treePaths`, and this
 * bridge simply forwards the port's input to it unchanged.
 *
 * CLOSED (task 12): `runPage`'s input carries optional `entryRelPath`/`closure`, forwarded
 * straight into `gate/model/gate.ts`'s `GateInput` — see that module's own doc for why both
 * stay optional rather than the port sketch's required shape (measured cost: `core/turns`/
 * `core/kernel` have no design-tree closure to supply yet, and are production code, not a
 * fixture this task can mechanically patch).
 *
 * CLOSED (task-13 review round 1, Critical C1): `runTreeImports`'s result now carries
 * `closures` alongside `errors` — one per `input.pages` entry, resolved by `entities/
 * design-tree`'s `resolveClosure` walking `edgesOf` (`../model/tree-scan`'s `scanModuleEdges`,
 * the SAME edge reader `scanImportAllowlist` itself uses, so the closure walk and the
 * allowlist scan can never disagree about what a file imports) over the SAME `has`
 * (`../model/gate`'s `hasTreePath`, shared with the flat allowlist scan below so the two
 * halves of one whole-tree scan cannot build two independently-derived notions of "the tree
 * has this path" — task-13 review round 2, Minor M-e). One whole-tree pass now produces both
 * results; `core` still never imports `gate` — only this adapter, behind the port, does the
 * resolving.
 *
 * REBUILT (task-13 review round 3): rounds 1 and 2 traded one obligation against the other —
 * round 1 reported one shared module's bad edge once per reaching page, round 2 removed that
 * duplication by deleting a branch that was NOT always duplicated, losing the diagnostics for an
 * unresolvable manifest entry and for a violation inside a file the flat scan could not
 * tokenize. Both obligations now hold as ONE mechanism, {@link resolveTreeClosures} below: the
 * closure walk produces keyed FACTS with the page they blocked, and a fact becomes at most one
 * diagnostic carrying every blocked slug in `blockedPages`. Read that function's doc for the
 * invariant, the case-by-case attributability argument, and the one computed suppression.
 */

function createTypeCheckPort(
  tscExePath: string | undefined,
  runtimeDts: string | undefined,
): ((source: string, fileName: string) => Promise<GateError[]>) | undefined {
  if (tscExePath === undefined || runtimeDts === undefined) return undefined;
  return createTypeChecker({ tscExePath, runtimeDts });
}

/**
 * One reason a page's closure could NOT be proved complete. Deliberately a FACT, not a
 * diagnostic: `key` identifies the underlying fact so two pages blocked by the same one
 * collapse to a single entry, and `own` is `null` whenever the flat allowlist scan already
 * raised a diagnostic for that fact, so nothing is reported twice. This split is the whole fix
 * for task-13's two-round see-saw — see {@link resolveTreeClosures}.
 */
interface ClosureBlockerV1 {
  /** The tree-relative file the fact is about — the `file` any diagnostic for it must name. */
  readonly file: string;
  /** Identity of the underlying FACT, so N pages blocked by it produce one diagnostic. */
  readonly key: string;
  /** The diagnostic this pass must raise itself, or `null` when the flat scan already did. */
  readonly own: {
    readonly kind: GateErrorKind;
    readonly code: string;
    readonly message: string;
  } | null;
}

/** What one page's closure walk observed, alongside the walk's own success or refusal. */
interface ClosureWalkV1 {
  /** Every relPath {@link resolveClosure} asked for edges — its visited set. */
  readonly reached: Set<string>;
  /** Reached CODE files `files` holds no text for at all. */
  readonly sourceMissing: Set<string>;
  /** Reached files whose own edge list could not be read; value is the engine's reason. */
  readonly edgesUnreadable: Map<string, string>;
}

/**
 * `scanModuleEdges` threw. Carried as a value, never rethrown: `runTreeImports` is synchronous
 * and Task 14 calls it once per turn with no `try` of its own, so an escaping throw would crash
 * the turn pipeline rather than reject a page — the same reasoning, and the same fail-closed
 * outcome, as `gate/model/tree-scan.ts`'s own `TreeFileUnscannableError`.
 *
 * THIS BRANCH IS NOW LIVE, and task 14b is what made it so. It used to be unreachable: the
 * measured throw source is `./jsx`'s recursive-descent reader, and `scanModuleEdges` did not
 * call it at all — measured under Bun 1.3.14, `scanModuleEdges` on `"<a>{".repeat(k)` returned
 * its real edge list at k = 32 000 (where `scanImportAllowlist` already threw) and again at
 * k = 200 000. `tokenize` now consults that same reader for every source, so both readers
 * overflow on the same input, and this converter is what keeps that a rejected page rather than
 * a crashed turn.
 *
 * THE COST IS A DIAGNOSTIC, NOT AN ENFORCEMENT. Where the flat scan and the closure walk used to
 * disagree — one refusing the file, the other still reporting its forbidden import — they now
 * agree, so such a file yields one fatal instead of two. `gate-runner.test.ts`'s closure-invariant
 * table pins that row, including that the page is still blocked. Two readers with two different
 * parses is the hazard task 14b exists to remove: a closure built from a different reading than
 * the allowlist's is exactly what lets an unscanned module load.
 */
class ClosureEdgesUnreadableError extends errore.createTaggedError({
  name: "ClosureEdgesUnreadableError",
  message: 'the closure walk could not read the module edges of "$file" to the end',
}) {}

/**
 * The flat-scan diagnostic codes that make a walked file's own edge list untrustworthy, so a
 * closure through it cannot be called complete. Two different reasons, one conclusion:
 *
 * - `REEXPORT`/`DYNAMIC_IMPORT`/`REQUIRE_CALL` — `scanModuleEdges` deliberately does not treat
 *   any of the three as a closure edge (see its own doc in `gate/model/import-scan.ts`), so the
 *   file really does reach further than the walk followed. This is task-13 review round 3's
 *   Important 2: the walk used to return that shorter list as if it were the whole closure.
 * - `UNSCANNABLE_SOURCE` — the allowlist scan could not read the file to the end. This pass's
 *   own reader got through the same text (it does strictly less work on the same token stream),
 *   but "one of this module's two readers was defeated by these bytes" is not a basis for
 *   claiming the edge list is complete.
 *
 * A file carrying any of them already HAS its own diagnostic from the flat scan, which is why
 * every blocker built from this set is `own: null` — the page is attributed onto that existing
 * diagnostic instead of getting a second one.
 */
const CLOSURE_UNVERIFIABLE_SCAN_CODES: ReadonlySet<string> = new Set([
  "REEXPORT",
  "DYNAMIC_IMPORT",
  "REQUIRE_CALL",
  "UNSCANNABLE_SOURCE",
]);

function createClosureWalk(): ClosureWalkV1 {
  return { reached: new Set(), sourceMissing: new Set(), edgesUnreadable: new Map() };
}

/**
 * One manifest entry's edge reader for {@link resolveClosure}: the SAME file text the flat
 * allowlist scan reads, read back through `scanModuleEdges` (the raw-edge sibling of
 * `scanImportAllowlist` — both share `readStaticImportSpecifier`, so the closure walk can never
 * see a different import graph than the allowlist scan just checked).
 *
 * Three shapes answer `[]`, and only one of them is silent:
 *
 * - a relPath that is not code ({@link isCodeFile}) — no edges to walk and not a failure: an
 *   asset can be a legal closure member (design §6 places no extension restriction on a
 *   resolution TARGET) and simply has nothing to scan;
 * - a CODE relPath whose text `files` does not hold — recorded in `walk.sourceMissing`, because
 *   `[]` here is indistinguishable from "this file legitimately imports nothing" and would
 *   truncate the closure exactly where the pass ran out of text;
 * - a relPath whose edge read threw — recorded in `walk.edgesUnreadable`; see
 *   {@link ClosureEdgesUnreadableError} for why this is a value and not a rethrow.
 *
 * A file the flat scan reported `UNSCANNABLE_SOURCE` for is still read here, deliberately. That
 * is task-13 review round 3's Critical (b): its imports were never checked by the flat scan, so
 * skipping it here would be the one place a real `FORBIDDEN_IMPORT` could vanish entirely.
 */
function readClosureEdges(
  files: ReadonlyMap<string, string>,
  relPath: string,
  walk: ClosureWalkV1,
): readonly string[] {
  walk.reached.add(relPath);
  if (!isCodeFile(relPath)) return [];
  const source = files.get(relPath);
  if (source === undefined) {
    walk.sourceMissing.add(relPath);
    return [];
  }
  // As in `tree-scan.ts`: a RETURNED `SourceStreamTruncatedError` (controlled code, the
  // completeness invariant) or a THROWN engine stack overflow (the one uncontrolled boundary).
  const edges = errore.try({
    // The SAME measured predicate the flat scan uses (`tree-scan.ts`'s `parsesJsx`), so the
    // closure walk and the allowlist can never disagree about whether this file holds JSX —
    // a disagreement there is what lets a closure be built from a different reading.
    try: () => scanModuleEdges(source, parsesJsx(relPath)),
    catch: (cause) => new ClosureEdgesUnreadableError({ file: relPath, cause }),
  });
  if (edges instanceof Error) {
    const cause = edges.cause;
    walk.edgesUnreadable.set(
      relPath,
      cause === undefined
        ? edges.message
        : cause instanceof Error
          ? `${cause.name}: ${cause.message}`
          : String(cause),
    );
    return [];
  }
  return edges;
}

/**
 * The blocker raised for EVERY entry whose slug `pages` lists more than once (round 4, M-1).
 *
 * WHY THIS IS ENFORCED HERE AND NOT LEFT TO THE MANIFEST DECODER. Both halves of this pass's
 * result — `closures` and {@link GateErrorV1.blockedPages} — are keyed by SLUG, so two entries
 * sharing one slug make the port's "EXACTLY ONE of these holds" absolute false by construction:
 * measured on `pages=[{a,"pages/a.tsx"},{a,"pages/ghost.tsx"}]`, `a` appeared in `closures` AND
 * in a diagnostic's `blockedPages` at once. `entities/design-tree`'s `decodePagesManifest`
 * already refuses a duplicate slug under this same `DUPLICATE_SLUG` code, but `runTreeImports`
 * accepts `pages` independently of it — and "the guarantee holds because another module checks
 * it" is the exact prose-guarantee shape that produced round 3's Critical (a). One `Set` closes
 * it structurally instead.
 *
 * `file` is the manifest's own TREE-relative path, deliberately not `gate/model/manifest.ts`'s
 * project-relative `design/pages.json`: every `file` this method emits is tree-relative (see
 * `gate/model/gate.ts`'s `runTreeImports`, which pins that vocabulary), and mixing the two
 * inside one error list would be worse than the two methods differing.
 */
function duplicateSlugBlocker(slug: PageSlug): ClosureBlockerV1 {
  return {
    file: PAGES_MANIFEST_RELPATH,
    key: JSON.stringify(["duplicate-slug", slug]),
    own: {
      // The decoder's own code, reused rather than a second name for one rule; `manifest` kind
      // for the same reason — the broken thing is the manifest, not an import.
      kind: "manifest",
      code: "DUPLICATE_SLUG",
      message: `"${slug}" is listed more than once, so no closure can be keyed to it`,
    },
  };
}

/**
 * Walk one manifest entry's closure (design §7) and report every fact that stops this pass
 * PROVING the result complete. `files` is `null` exactly when the walk itself refused, and a
 * non-empty `blockers` is what excludes the slug from `closures` — never a partial file list.
 *
 * `has(entry)` is checked HERE rather than left to {@link resolveClosure}'s own identical
 * refusal so the two failures stay distinguishable: an entry that names no file in the tree is
 * not an edge at all, and the flat scan cannot report it under any code — it iterates `files`,
 * never `pages` (task-13 review round 3, Critical (a)).
 */
function walkPageClosure(
  page: PageEntryV1,
  context: {
    readonly files: ReadonlyMap<string, string>;
    readonly has: (relPath: string) => boolean;
    /** True when the flat scan read this exact file to the end, so it checked its imports. */
    readonly scannedInFull: (relPath: string) => boolean;
    /** Files the flat scan already flagged under {@link CLOSURE_UNVERIFIABLE_SCAN_CODES}. */
    readonly unverifiable: ReadonlySet<string>;
    /** True when `pages` lists this slug more than once — see {@link duplicateSlugBlocker}. */
    readonly isDuplicateSlug: (slug: PageSlug) => boolean;
  },
): { readonly files: readonly string[] | null; readonly blockers: readonly ClosureBlockerV1[] } {
  const blockers: ClosureBlockerV1[] = [];
  // Checked FIRST, and deliberately WITHOUT short-circuiting the walk: a duplicated slug still
  // gets its own entry walked, so whatever else is wrong with that entry is still reported
  // (round 4, M-1 — an early return here would have made the second entry's own
  // `UNRESOLVED_IMPORT` disappear, the exact defect class round 3 was brought in to fix).
  if (context.isDuplicateSlug(page.slug)) blockers.push(duplicateSlugBlocker(page.slug));

  if (!context.has(page.entry)) {
    blockers.push({
      file: page.entry,
      key: JSON.stringify(["entry-unresolved", page.entry]),
      // Raised unconditionally: the flat scan iterates `files`, so it never says anything
      // about an entry AS an entry, whatever else it may report about that same path.
      own: {
        kind: "import",
        code: "UNRESOLVED_IMPORT",
        message: `the manifest entry "${page.entry}" names no file in the tree, so no closure can be walked from it`,
      },
    });
    return { files: null, blockers };
  }

  const walk = createClosureWalk();
  const resolved = resolveClosure({
    entry: page.entry,
    has: context.has,
    edgesOf: (relPath) => readClosureEdges(context.files, relPath, walk),
  });

  if (resolved instanceof Error) {
    const from = String(resolved.from);
    blockers.push({
      file: from,
      key: JSON.stringify(["edge-rejected", from, String(resolved.specifier)]),
      // The ONE suppression in this pass, and it is computed rather than argued. When the flat
      // scan read `from` to the end it ran `scanImportAllowlist` over that exact source with
      // this exact `has`; that function resolves every static import through the SAME
      // `resolveDesignSpecifier` and maps a rejection with the SAME code split, so the identical
      // specifier is already reported, naming the same file. Round 2 asserted this
      // unconditionally and was disproved by a file the flat scan could not tokenize at all
      // (task-13 review round 3, Critical (b)) — hence the `scannedInFull` test, which is
      // exactly the condition that was missing. What would falsify it: `scanModuleEdges` and
      // `scanImportAllowlist` ceasing to share `readStaticImportSpecifier`, or the two ceasing
      // to resolve through the same function.
      own: context.scannedInFull(from)
        ? null
        : {
            // The same code mapping `scanImportAllowlist` applies to the identical
            // `SpecifierRejectedError`: "UNRESOLVED" is usually a typo or a missing file, every
            // other code is a rule violation.
            kind: "import",
            code: resolved.code === "UNRESOLVED" ? "UNRESOLVED_IMPORT" : "FORBIDDEN_IMPORT",
            message: `${resolved.message} — found by the closure walk because "${from}" was never scanned in full`,
          },
    });
  }

  for (const relPath of walk.sourceMissing) {
    blockers.push({
      file: relPath,
      key: JSON.stringify(["source-missing", relPath]),
      // Raised once per missing FILE, not once per page reaching it. The flat scan's own
      // `UNSCANNED_IMPORT` is a different fact about a different file (the IMPORTER, not the
      // missing module) and does not exist at all when the missing file is a page's own entry,
      // which is the shape that silently truncated a closure to one file in round 1.
      own: {
        kind: "import",
        code: "CLOSURE_SOURCE_MISSING",
        message: `"${relPath}" is named by the tree but this pass was given no source for it, so no page closure reaching it can be verified complete`,
      },
    });
  }

  for (const [relPath, reason] of walk.edgesUnreadable) {
    blockers.push({
      file: relPath,
      key: JSON.stringify(["edges-unreadable", relPath]),
      own: context.unverifiable.has(relPath)
        ? null
        : {
            kind: "import",
            code: "UNSCANNABLE_SOURCE",
            message: `the closure walk could not read the module edges of "${relPath}" to the end — ${reason}`,
          },
    });
  }

  // Every file the walk actually touched — the resolved closure when it completed, the partial
  // visited set when it did not — checked against what the flat scan found in those same files.
  for (const relPath of resolved instanceof Error ? walk.reached : resolved.files) {
    if (!context.unverifiable.has(relPath)) continue;
    blockers.push({
      file: relPath,
      key: JSON.stringify(["edge-list-unverifiable", relPath]),
      own: null, // by construction: `unverifiable` is built FROM the flat scan's own diagnostics
    });
  }

  return { files: resolved instanceof Error ? null : resolved.files, blockers };
}

function addSlug(index: Map<string, Set<PageSlug>>, key: string, slug: PageSlug): void {
  const slugs = index.get(key);
  if (slugs === undefined) {
    index.set(key, new Set([slug]));
    return;
  }
  slugs.add(slug);
}

function sortedSlugs(slugs: ReadonlySet<PageSlug>): readonly PageSlug[] {
  return [...slugs].sort();
}

function filesReportedUnder(
  scanErrors: readonly GateError[],
  codes: (code: string) => boolean,
): ReadonlySet<string> {
  const reported = new Set<string>();
  for (const error of scanErrors) {
    if (error.file !== undefined && codes(error.code)) reported.add(error.file);
  }
  return reported;
}

/**
 * Resolve every manifest entry's closure (design §7) over the SAME whole-tree inventory and the
 * SAME file text the flat allowlist scan just ran on, and merge both halves' diagnostics into
 * one honest list.
 *
 * THE JOINT INVARIANT THIS FUNCTION EXISTS TO HOLD (task-13 review round 3). Rounds 1 and 2
 * each satisfied one half of it by breaking the other — round 1 reported a shared module's one
 * bad edge once per reaching page, round 2 removed the duplication by deleting diagnostics that
 * were not duplicates. Both halves hold here because they are one mechanism, not two patches:
 *
 *   For every `pages` entry, EITHER its slug is in `closures` with a file list this pass proved
 *   complete, OR the slug is absent from `closures` AND at least one returned diagnostic names
 *   it in `blockedPages` — with every diagnostic emitted once per underlying FACT, never once
 *   per page that happens to reach it.
 *
 * The mechanism: a walk produces {@link ClosureBlockerV1} FACTS, not diagnostics. Facts are
 * keyed, so N pages blocked by one fact collapse to one entry; each fact carries the page it
 * blocked, so attribution is a set on a single diagnostic instead of a copy per page; and a
 * fact whose diagnostic the flat scan already raised carries `own: null`, so the page is
 * attributed onto that existing diagnostic rather than getting a second one. The one place a
 * fact is suppressed is computed from what the flat scan actually managed to read
 * (`scannedInFull`), never asserted — see {@link walkPageClosure}.
 *
 * WHY EVERY BLOCKED PAGE IS ATTRIBUTABLE, case by case, rather than by a coverage sweep. Each
 * blocker's `file` either receives a diagnostic from this pass (`own !== null`) or is a file the
 * flat scan diagnosed: `entry-unresolved` and `source-missing` always raise their own;
 * `edge-rejected` raises its own unless `from` was scanned in full, in which case that same
 * `from` carries the flat scan's report of the identical rejection; `edge-list-unverifiable` is
 * built out of the flat scan's own diagnostics, so its file has one by construction; and
 * `edges-unreadable` raises its own unless the same file is already in that set. So no blocked
 * page can end up with an empty `blockedPages` anywhere in `errors`.
 */
export function resolveTreeClosures(input: {
  readonly pages: readonly PageEntryV1[];
  readonly files: ReadonlyMap<string, string>;
  readonly treePaths: readonly string[];
  readonly scanErrors: readonly GateError[];
}): { readonly closures: readonly GateClosureV1[]; readonly errors: readonly GateError[] } {
  const has = hasTreePath(input.treePaths);
  const unscannable = filesReportedUnder(input.scanErrors, (code) => code === "UNSCANNABLE_SOURCE");
  const unverifiable = filesReportedUnder(input.scanErrors, (code) =>
    CLOSURE_UNVERIFIABLE_SCAN_CODES.has(code),
  );
  // The flat scan runs `scanImportAllowlist` over exactly the CODE keys of `files`, and reports
  // `UNSCANNABLE_SOURCE` for each one it could not finish — so this is a derivation of what it
  // actually checked, not a second guess at it.
  const scannedInFull = (relPath: string) =>
    isCodeFile(relPath) && input.files.has(relPath) && !unscannable.has(relPath);

  // Every slug `pages` lists more than once — see {@link duplicateSlugBlocker} for why this
  // pass owns the check rather than trusting the manifest decoder that also makes it.
  const slugCounts = new Map<PageSlug, number>();
  for (const page of input.pages) slugCounts.set(page.slug, (slugCounts.get(page.slug) ?? 0) + 1);
  const isDuplicateSlug = (slug: PageSlug) => (slugCounts.get(slug) ?? 0) > 1;

  const closures: GateClosureV1[] = [];
  const blockedAt = new Map<string, Set<PageSlug>>();
  const raised = new Map<
    string,
    {
      readonly file: string;
      readonly kind: GateErrorKind;
      readonly code: string;
      readonly message: string;
      slugs: Set<PageSlug>;
    }
  >();

  for (const page of input.pages) {
    const walked = walkPageClosure(page, {
      files: input.files,
      has,
      scannedInFull,
      unverifiable,
      isDuplicateSlug,
    });
    if (walked.blockers.length === 0 && walked.files !== null) {
      closures.push({ slug: page.slug, files: walked.files });
      continue;
    }
    for (const blocker of walked.blockers) {
      addSlug(blockedAt, blocker.file, page.slug);
      if (blocker.own === null) continue;
      const already = raised.get(blocker.key);
      if (already !== undefined) {
        already.slugs.add(page.slug);
        continue;
      }
      raised.set(blocker.key, { file: blocker.file, ...blocker.own, slugs: new Set([page.slug]) });
    }
  }

  const attributed = input.scanErrors.map((error) => {
    const slugs = error.file === undefined ? undefined : blockedAt.get(error.file);
    return slugs === undefined ? error : { ...error, blockedPages: sortedSlugs(slugs) };
  });
  const walkErrors = [...raised.values()].map((entry) => ({
    kind: entry.kind,
    code: entry.code,
    message: entry.message,
    file: entry.file,
    blockedPages: sortedSlugs(entry.slugs),
  }));

  return { closures, errors: [...attributed, ...walkErrors] };
}

export interface GateRunnerAdapterDeps {
  readonly smokeRenderer: SmokeRenderer;
  /** A path already resolved by `gate/model/tsc-extract.ts`'s `resolveCompilerPath()` — this
   *  adapter does no resolution of its own; see this file's header note. */
  readonly tscExePath?: string;
  /** See this file's header note — the composition root supplies `runtime/generated
   *  /runtime-dts.ts`'s `RUNTIME_DTS` here (phase-8 Task 7). */
  readonly runtimeDts?: string;
  readonly checkManifest?: GatePorts["checkManifest"];
}

export function createGateRunnerAdapter(deps: GateRunnerAdapterDeps): GateRunner {
  const typeCheck = createTypeCheckPort(deps.tscExePath, deps.runtimeDts);

  async function runManifestSlice(input: {
    readonly manifestText: string;
    readonly treePaths: readonly string[];
  }): Promise<ManifestSliceResultV1> {
    return checkManifestSlice(input);
  }

  async function runPage(input: {
    readonly source: string;
    readonly slug: PageSlug;
    readonly fileName?: string;
    readonly sourcePath?: string;
    readonly entryRelPath?: string;
    readonly closure?: ClosureV1;
  }): Promise<GateRunResultV1> {
    // `entryRelPath` out-ranks `fileName` — see `gate/model/gate.ts`'s own `runGate` for the
    // full rationale (task-12 review round 1, Important 4). Mirrored here, not delegated to
    // `runGate`'s own fallback, because this adapter ALSO uses `fileName` for
    // `smokeSourcePath` below and both must agree on which value actually won.
    const fileName = input.entryRelPath ?? input.fileName ?? `${input.slug}.tsx`;
    // The smoke stage needs a path it can actually resolve on disk (see this file's header,
    // "CLOSED (was FLAGGED)") — `sourcePath` is preferred when a caller staged a real
    // candidate file; `fileName` stays the diagnostics-facing display name regardless.
    const smokeSourcePath = input.sourcePath ?? fileName;
    const ports: GatePorts = {
      ...(typeCheck !== undefined ? { typeCheck } : {}),
      ...(deps.checkManifest !== undefined ? { checkManifest: deps.checkManifest } : {}),
      smokeRender: createSmokeRender(deps.smokeRenderer, smokeSourcePath),
    };
    return runGate(
      {
        source: input.source,
        slug: input.slug,
        fileName,
        ...(input.entryRelPath !== undefined ? { entryRelPath: input.entryRelPath } : {}),
        ...(input.closure !== undefined ? { closure: input.closure } : {}),
      },
      ports,
    );
  }

  /**
   * The whole-tree import allowlist (design §8 step 4) plus every manifest entry's resolved
   * closure (task-13 review round 1, Critical C1 — see this file's header). `gate/model/
   * gate.ts`'s own `runTreeImports` is synchronous — it does no I/O, only token-scanning over
   * the text it is handed — so this only wraps it in a promise the same way every other method
   * on this port is async, keeping `core` looking at one uniform shape. The flat scan runs
   * FIRST and its findings are an INPUT to the closure pass ({@link resolveTreeClosures}), not
   * merely concatenated afterwards: which files it managed to read, and which it found to carry
   * an edge form the closure walk does not follow, is what decides both whether a closure may be
   * called complete and whether a fact already has a diagnostic.
   */
  async function runTreeImportsPort(input: {
    readonly files: ReadonlyMap<string, string>;
    readonly treePaths: readonly string[];
    readonly pages: readonly PageEntryV1[];
  }): Promise<RunTreeImportsResultV1> {
    return resolveTreeClosures({ ...input, scanErrors: runTreeImports(input) });
  }

  /**
   * The page-contract stage alone (see the port's own doc for why this is deliberately not
   * `runPage`). `checkPageContract` is pure and synchronous — no compiler, no smoke child,
   * no `GatePorts` at all — so this only wraps it and re-labels its errors the way `runGate`
   * itself does (`gate/model/gate.ts`: `kind: "contract"`, `file` set to the display name),
   * rather than mapping them a second, divergent way.
   */
  async function extractPageMeta(input: {
    readonly source: string;
    readonly slug: PageSlug;
  }): Promise<PageMetaExtractionV1> {
    const fileName = `${input.slug}.tsx`;
    const contract = checkPageContract(input.source, "jsx");
    if (contract instanceof Error) {
      // A source whose token stream does not cover it has no readable `meta` — reporting
      // `meta: null` with the real reason beats reporting "this page declares no settings",
      // which would be a false diagnosis (this method's own doc: a page that fails one stage
      // still has a perfectly readable `meta`, and the converse must be just as honest).
      return {
        meta: null,
        errors: [
          {
            kind: "contract" as const,
            code: "UNSCANNABLE_SOURCE",
            message: `${fileName}: ${contract.message}`,
            file: fileName,
            line: 1,
            column: 1,
          },
        ],
      };
    }
    return {
      meta: contract.meta,
      errors: contract.errors.map((error) => ({
        kind: "contract" as const,
        code: error.code,
        message: error.message,
        file: fileName,
        line: error.line,
        column: error.column,
      })),
    };
  }

  return { runManifestSlice, runPage, runTreeImports: runTreeImportsPort, extractPageMeta };
}

type _Conforms = AssertConforms<GateRunner, ReturnType<typeof createGateRunnerAdapter>>;
