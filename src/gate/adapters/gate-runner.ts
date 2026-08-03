import * as errore from "errore";

import type {
  AssertConforms,
  GateClosureV1,
  GateRunResultV1,
  GateRunner,
  ManifestSliceResultV1,
  PageMetaExtractionV1,
  RunTreeResultV1,
} from "core/ports";
import {
  PAGES_MANIFEST_RELPATH,
  resolveClosure,
  resolveDesignSpecifier,
} from "entities/design-tree";
import type { ClosureV1, DesignFileEntryV1, PageEntryV1 } from "entities/design-tree";
import type { PageSlug } from "entities/page";

// Relative (not `gate`'s own barrel): `gate/index.ts` re-exports this adapter (Task 6's own
// change), so importing the barrel back from here would be a self-referencing cycle.
import {
  PageSourceUnscannableError,
  hasTreePath,
  runGate,
  runTreeImports,
  unscannableMessage,
} from "../model/gate";
import type { GatePorts } from "../model/gate";
import { checkManifestSlice } from "../model/manifest";
import { checkPageContract } from "../model/page-contract";
import { createSmokeRender } from "../model/smoke";
import { isCodeFile, parsesJsx, scanModuleEdges } from "../model/tree-scan";
import { createTreeTypeChecker } from "../model/type-check";
import type { SmokeRenderer } from "../ports/smoke-renderer";
import type { GateError, GateErrorKind, GateWarning } from "../types";

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
 * `GateRunner.runPage`'s input (`core/ports/gate-runner.ts`) carries no `referencedIds`/
 * `listedSlugs` (`gate/model/gate.ts:44-47`), so the `dropped-id`/`unlisted-navigation`
 * warning lints stay dormant whenever a page is validated through this port. Note it here,
 * do not invent the fields.
 *
 * CLOSED (was FLAGGED): `runPage`'s input carries `treeRoot`/`expectedFiles` for the smoke
 * stage's `SmokeRequest` (`gate/model/smoke.ts`'s `createSmokeRender`), and `entryRelPath` —
 * the SHORT display name `runGate` echoes into `GateErrorV1.file` — for the smoke request's
 * own entry path. The real host `SmokeRenderer` resolves `<treeRoot>/<entryRelPath>` via
 * `Bun.file` in a fresh child process cwd.
 *
 * CLOSED (phase-8 Task 7; MOVED by design-tree phase 2 Task 3): the type check is wired whenever
 * BOTH `tscExePath` and `runtimeDts` are supplied, and the composition root now always supplies
 * both. `entrypoint/model/create-shell.ts`'s `interactiveShell` resolves `tscExePath` via
 * `gate/model/tsc-extract.ts`'s `resolveCompilerPath()` before any project I/O runs — a failed
 * resolution aborts the whole shell construction as a `ShellCompositionError` rather than
 * reaching this adapter at all — and passes `runtime/generated/runtime-dts.ts`'s generated
 * `RUNTIME_DTS` as `runtimeDts`. So in the shipped configuration the check is never actually
 * omitted; the `tscExePath`/`runtimeDts` parameters stay OPTIONAL on this adapter only so a
 * caller with no compiler available (a unit test, a hermetic fixture) can still run the
 * source-only stages standalone, and that omission is honest rather than a fabricated pass.
 *
 * WHAT TASK 3 MOVED, and why it is not merely a relocation: the check used to be a `GatePorts
 * .typeCheck` running ONE `tsc` program per ENTRY FILE inside `runGate`, over a virtual FS that
 * served only that file — so a page importing a sibling module failed with a spurious `TS2307`
 * (measured). It now runs ONCE, inside {@link createGateRunnerAdapter}'s `runTree`, over every
 * code file in the tree at once, and its diagnostics are attributed to pages through the
 * closures that SAME pass just resolved.
 *
 * CLOSED (task 10/12): `runManifestSlice`'s input carries `treePaths` (design tree file
 * inventory), not the pre-design-tree `presentSlugs` (page slugs) — a slug list could never
 * honestly answer whether a manifest `entry` resolves to a real file, only `gate/model/
 * manifest.ts`'s real `checkManifestSlice` (Task 10) already required `treePaths`, and this
 * bridge simply forwards the port's input to it unchanged.
 *
 * CLOSED (task 12): `runPage`'s input carries `entryRelPath`/`closure`, forwarded straight
 * into `gate/model/gate.ts`'s `GateInput`.
 *
 * REQUIRED (task 16): `treeRoot`/`expectedFiles`/`entryRelPath` are no longer optional —
 * every production caller (`core/kernel/model/handlers/page-descriptors.ts`,
 * `core/turns/model/validation.ts`) supplies all three, so a refusal on a missing one is now
 * impossible to construct. `closure` stays optional: see `gate/model/gate.ts`'s own
 * `GateInput.closure` doc for why.
 *
 * CLOSED (task-13 review round 1, Critical C1): `runTree`'s result now carries
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

/**
 * The whole-tree type check, or `undefined` when this adapter was built with no compiler to run
 * it (see this file's header for why that stays possible and why it is honest). Both halves of
 * the config are required together — a `tsc` path with no ambient runtime declaration would
 * report every `@termcraft/runtime` import as unresolved, which is a fabricated diagnostic, not
 * a degraded one.
 */
function createTreeTypeCheckStage(
  tscExePath: string | undefined,
  runtimeDts: string | undefined,
): ((input: { readonly files: ReadonlyMap<string, string> }) => Promise<GateError[]>) | undefined {
  if (tscExePath === undefined || runtimeDts === undefined) return undefined;
  return createTreeTypeChecker({ tscExePath, runtimeDts });
}

/**
 * Every slug whose resolved closure contains a given file, sorted — built ONCE from the closures
 * {@link resolveTreeClosures} just produced, and read once per type diagnostic.
 *
 * THE ATTRIBUTION IS A LOOKUP, NEVER A SECOND WALK. Design §8 step 5 asks for "a diagnostic in a
 * shared file attributed to every page whose closure contains it", and the pass already holds
 * exactly that relation: `closures` is `slug -> files`, so inverting it costs one traversal of
 * data already in hand. Re-deriving reachability from the import graph here would mean a second
 * reading of the same question — the failure mode this whole plan keeps designing against, where
 * two readings disagree and the disagreement is the defect.
 *
 * A page ABSENT from `closures` (its closure was not proved complete) therefore contributes
 * nothing: it is already carrying its own blocker diagnostic, and claiming a type error blocks a
 * page whose file set this pass could not establish would be a fabricated attribution.
 */
function createClosureIndex(
  closures: readonly GateClosureV1[],
): (file: string | undefined) => readonly PageSlug[] | undefined {
  const slugsByFile = new Map<string, Set<PageSlug>>();
  for (const closure of closures) {
    for (const file of closure.files) addSlug(slugsByFile, file, closure.slug);
  }
  return (file) => {
    if (file === undefined) return undefined;
    const slugs = slugsByFile.get(file);
    // Absent, never `[]` — the field's own contract. A diagnostic no closure reaches (an orphan
    // module, or a global/config diagnostic with no `file` at all) stays fatal and unattributed.
    return slugs === undefined ? undefined : sortedSlugs(slugs);
  };
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
 *
 * CAPTURES `edgeMap` (design-tree phase 2 Task 4), a byproduct of the SAME raw specifiers this
 * function was already computing, not a second read. `import-cycle`/`dead-module` need the
 * WHOLE tree's resolved import graph, and until now nothing retained it: `resolveClosure`
 * resolves each specifier internally (via the identical `resolveDesignSpecifier`) but returns
 * only the final file set or an error, never the edges it walked. Resolving the SAME specifier
 * strings a second time here costs no I/O and no re-tokenizing — `resolveDesignSpecifier` is a
 * pure string computation over `has`, not a file read — so this is the same edge READER's
 * output, reused, never a second one. Only `"file"`-kind resolutions are kept: a `"runtime"`
 * edge (`@termcraft/runtime`) leaves the tree and cannot participate in a tree-internal cycle,
 * and a REJECTED specifier names no real file to point an edge at. Skipped when `relPath`
 * already has an entry — multiple pages can walk the same shared module, and its edges do not
 * change between them.
 */
function readClosureEdges(
  files: ReadonlyMap<string, string>,
  relPath: string,
  walk: ClosureWalkV1,
  has: (relPath: string) => boolean,
  edgeMap: Map<string, ReadonlySet<string>>,
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
    // No entry recorded in `edgeMap` for `relPath` — its edges are UNKNOWN, not empty, which is
    // exactly what keeps it out of `findImportCycles`: a node absent from the map can never be
    // reached as a member because nothing ever puts an edge INTO the traversal FROM it.
    return [];
  }
  if (!edgeMap.has(relPath)) {
    const targets = new Set<string>();
    for (const specifier of edges) {
      const resolved = resolveDesignSpecifier({ from: relPath, specifier, has });
      if (!(resolved instanceof Error) && resolved.kind === "file") targets.add(resolved.relPath);
    }
    edgeMap.set(relPath, targets);
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
 * already refuses a duplicate slug under this same `DUPLICATE_SLUG` code, but `runTree`
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
    /** Shared across every page's walk in this call — see {@link readClosureEdges}'s doc. */
    readonly edgeMap: Map<string, ReadonlySet<string>>;
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
    edgesOf: (relPath) =>
      readClosureEdges(context.files, relPath, walk, context.has, context.edgeMap),
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
 *
 * ALSO RETURNS, since design-tree phase 2 Task 4, the two pieces of data `findImportCycles`/
 * `findDeadModules` need and this pass ALREADY built while walking every page's closure:
 * `edges` (every successfully-read file's resolved same-tree targets, {@link readClosureEdges}'s
 * own doc) and `anyClosureBlocked` (true the moment one page's walk above did NOT reach the
 * `closures.push` branch — i.e. at least one entry's closure could not be proved complete).
 * Neither costs a second file read or a second edge reader; both are read straight off state
 * this loop maintains for its own, pre-existing purpose.
 */
export function resolveTreeClosures(input: {
  readonly pages: readonly PageEntryV1[];
  readonly files: ReadonlyMap<string, string>;
  readonly treePaths: readonly string[];
  readonly scanErrors: readonly GateError[];
}): {
  readonly closures: readonly GateClosureV1[];
  readonly errors: readonly GateError[];
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly anyClosureBlocked: boolean;
} {
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
  // Shared across every page's walk below, and returned — see this function's own doc and
  // {@link readClosureEdges}'s.
  const edgeMap = new Map<string, ReadonlySet<string>>();
  let anyClosureBlocked = false;

  for (const page of input.pages) {
    const walked = walkPageClosure(page, {
      files: input.files,
      has,
      scannedInFull,
      unverifiable,
      isDuplicateSlug,
      edgeMap,
    });
    if (walked.blockers.length === 0 && walked.files !== null) {
      closures.push({ slug: page.slug, files: walked.files });
      continue;
    }
    anyClosureBlocked = true;
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

  return { closures, errors: [...attributed, ...walkErrors], edges: edgeMap, anyClosureBlocked };
}

/**
 * design §8 step 3: a code file `input.files` holds text for that no page's PROVEN closure
 * reaches — derived ENTIRELY from {@link resolveTreeClosures}'s own `closures` (the union of
 * every resolved closure's `files`), never a second walk of the import graph.
 *
 * SUPPRESSED FOR THE WHOLE TREE, not filtered per file, the moment `anyClosureBlocked` is true
 * (one of the two fail-quiet honesty rules design-tree phase 2 Task 4 asks for). A page whose
 * closure could not be proved complete contributes NOTHING to `closures`, so every module past
 * wherever its walk stopped reads as "unreached" for a reason that has nothing to do with
 * whether a page actually uses it — a `dead-module` warning built on that partial a picture
 * would assert "nothing reaches this file" about a graph this pass never finished reading, which
 * is worse than reporting no warning at all. Hence the early return below covers every file, not
 * only the ones downstream of whichever entry got blocked.
 *
 * Scoped to `input.files`' keys, not `input.treePaths`' — the same scope
 * {@link resolveTreeClosures} itself reads text from; a tree-relative path present only in
 * `treePaths` (no text given) is outside what this pass can even classify as code with any
 * confidence beyond its extension, and design-tree phase 2 Task 4's own brief pins its one
 * dead-module test fixture as "present in `files`".
 */
function findDeadModules(input: {
  readonly files: ReadonlyMap<string, string>;
  readonly closures: readonly GateClosureV1[];
  readonly anyClosureBlocked: boolean;
}): readonly GateWarning[] {
  if (input.anyClosureBlocked) return [];

  const reachable = new Set<string>();
  for (const closure of input.closures) for (const file of closure.files) reachable.add(file);

  const deadRelPaths = [...input.files.keys()]
    .filter((relPath) => isCodeFile(relPath) && !reachable.has(relPath))
    .sort();

  return deadRelPaths.map((relPath) => ({
    kind: "dead-module" as const,
    file: relPath,
    message: `"${relPath}" is not reached by any page's resolved closure`,
  }));
}

/** One frame of {@link findImportCycles}'s explicit-stack DFS — a plain array push, never a call. */
interface ClosureDfsFrameV1 {
  readonly node: string;
  readonly outEdges: readonly string[];
  index: number;
}

const DFS_NOT_VISITED = 0;
const DFS_ON_STACK = 1;
const DFS_DONE = 2;
type DfsMarkV1 = typeof DFS_NOT_VISITED | typeof DFS_ON_STACK | typeof DFS_DONE;

/**
 * design §8 step 2: every import cycle among the edges {@link resolveTreeClosures} already
 * resolved while walking every page's closure — reused as-is, never a second reading of any
 * file.
 *
 * AN EXPLICIT-STACK, ITERATIVE DFS, DELIBERATELY, mirroring {@link resolveClosure}'s own
 * explicit-queue BFS shape rather than the natural recursive statement of "follow this edge,
 * then follow its edges": plan 1's Task 3 exists because a RECURSIVE reader blocked the event
 * loop for seconds and needed a fail-closed depth ceiling to recover from it. This pass must not
 * reintroduce that hazard, so every "descend into this edge" below is a push onto `stack`, and
 * every "return from this call" is a pop — no function ever calls itself.
 *
 * ONE WARNING PER CYCLE — not per member, not per edge. The classic white/gray/black DFS cycle
 * check gives this by construction: a cycle is discovered exactly once per BACK EDGE (an edge to
 * a node still `DFS_ON_STACK`, i.e. still an ancestor on the current path), and `found` dedupes
 * by the sorted member list, so even a graph tangled enough to reach the same cycle's back edge
 * twice (not exercised by this task's own pinned scenarios, but structurally possible) still
 * yields one warning. `file` is the LEXICOGRAPHICALLY SMALLEST member — a stable anchor
 * independent of which node the DFS happened to start from or which back edge closed the loop —
 * while the MESSAGE lists members in the order the walk actually visited them. These are
 * DELIBERATELY not the same order: `file`/the dedup key answer "which cycle is this, robustly";
 * the message answers "what does the loop actually look like".
 *
 * `edges` NEVER carries an entry for a file whose own edges could not be verified read to the
 * end — {@link readClosureEdges} returns before recording anything for such a file, whether the
 * scan threw or the source was missing entirely. So an unscannable file's edges are UNKNOWN, and
 * it can never appear as a cycle member: nothing ever pushes an edge FROM it for this DFS to
 * walk, by construction, not by a check written in this function.
 */
function findImportCycles(edges: ReadonlyMap<string, ReadonlySet<string>>): readonly GateWarning[] {
  const state = new Map<string, DfsMarkV1>();
  const found = new Map<string, readonly string[]>();

  for (const start of edges.keys()) {
    if ((state.get(start) ?? DFS_NOT_VISITED) === DFS_DONE) continue;

    const stack: ClosureDfsFrameV1[] = [
      { node: start, outEdges: [...(edges.get(start) ?? [])], index: 0 },
    ];
    state.set(start, DFS_ON_STACK);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break; // unreachable: `stack.length > 0` just above

      if (top.index >= top.outEdges.length) {
        state.set(top.node, DFS_DONE);
        stack.pop();
        continue;
      }

      const next = top.outEdges[top.index];
      top.index += 1;
      if (next === undefined) continue; // unreachable: `index < outEdges.length` just above

      const nextMark = state.get(next) ?? DFS_NOT_VISITED;
      if (nextMark === DFS_DONE) continue;
      if (nextMark === DFS_NOT_VISITED) {
        state.set(next, DFS_ON_STACK);
        stack.push({ node: next, outEdges: [...(edges.get(next) ?? [])], index: 0 });
        continue;
      }

      // `nextMark === DFS_ON_STACK`: a back edge to a node still on THIS path — everything from
      // that node's position to the current top is one cycle, in the order the walk visited it.
      const cycleStart = stack.findIndex((frame) => frame.node === next);
      if (cycleStart === -1) continue; // unreachable: `next` is ON_STACK, so it is IN `stack`
      const members = stack.slice(cycleStart).map((frame) => frame.node);
      const key = JSON.stringify([...members].sort());
      if (!found.has(key)) found.set(key, members);
    }
  }

  const warnings: GateWarning[] = [];
  for (const members of found.values()) {
    const [firstMember] = members;
    if (firstMember === undefined) continue; // unreachable: every recorded cycle has >=1 member
    const smallest = [...members].sort()[0];
    if (smallest === undefined) continue; // unreachable: the same non-empty array, sorted
    warnings.push({
      kind: "import-cycle" as const,
      file: smallest,
      message: `an import cycle: ${members.join(" -> ")} -> ${firstMember}`,
    });
  }
  return warnings;
}

export interface GateRunnerAdapterDeps {
  readonly smokeRenderer: SmokeRenderer;
  /** A path already resolved by `gate/model/tsc-extract.ts`'s `resolveCompilerPath()` — this
   *  adapter does no resolution of its own; see this file's header note. Consumed by the
   *  WHOLE-TREE type check inside `runTree` since Task 3, not by any per-page stage. */
  readonly tscExePath?: string;
  /** See this file's header note — the composition root supplies `runtime/generated
   *  /runtime-dts.ts`'s `RUNTIME_DTS` here (phase-8 Task 7). */
  readonly runtimeDts?: string;
  readonly checkManifest?: GatePorts["checkManifest"];
}

export function createGateRunnerAdapter(deps: GateRunnerAdapterDeps): GateRunner {
  const treeTypeCheck = createTreeTypeCheckStage(deps.tscExePath, deps.runtimeDts);

  async function runManifestSlice(input: {
    readonly manifestText: string;
    readonly treePaths: readonly string[];
  }): Promise<ManifestSliceResultV1> {
    return checkManifestSlice(input);
  }

  async function runPage(input: {
    readonly source: string;
    readonly slug: PageSlug;
    readonly treeRoot: string;
    readonly expectedFiles: readonly DesignFileEntryV1[];
    readonly entryRelPath: string;
    readonly closure?: ClosureV1;
  }): Promise<GateRunResultV1> {
    const fileName = input.entryRelPath;
    // The smoke stage mounts the page's whole closure off a real tree on disk (see this file's
    // header, "CLOSED (was FLAGGED)", and `gate/model/smoke.ts`). `treeRoot`/`expectedFiles` are
    // required on this port now (task 16), so no caller can reach this adapter with no tree to
    // mount.
    const smokeContext = {
      treeRoot: input.treeRoot,
      expectedFiles: input.expectedFiles,
    };
    const ports: GatePorts = {
      ...(deps.checkManifest !== undefined ? { checkManifest: deps.checkManifest } : {}),
      smokeRender: createSmokeRender(deps.smokeRenderer, smokeContext, fileName),
    };
    return runGate(
      {
        source: input.source,
        slug: input.slug,
        entryRelPath: input.entryRelPath,
        ...(input.closure !== undefined ? { closure: input.closure } : {}),
      },
      ports,
    );
  }

  /**
   * THE WHOLE-TREE PASS — the single place a tree is judged (design §8 steps 4 and 5). Three
   * stages, in this order, and the order is load-bearing rather than incidental:
   *
   * 1. `runTreeImports` — the flat import allowlist over every code file the tree names.
   *    `gate/model/gate.ts`'s own function is synchronous (it does no I/O, only token-scanning
   *    over the text it is handed).
   * 2. {@link resolveTreeClosures} — every manifest entry's closure. The flat scan's findings
   *    are an INPUT here, not merely concatenated afterwards: which files it managed to read,
   *    and which it found to carry an edge form the closure walk does not follow, is what
   *    decides both whether a closure may be called complete and whether a fact already has a
   *    diagnostic.
   * 3. the whole-tree type check, when a compiler was supplied. Its diagnostics are attributed
   *    through {@link createClosureIndex} over step 2's OWN closures — the pass never walks the
   *    import graph a second time to answer "which pages reach this file".
   *
   * `warnings` (design-tree phase 2 Task 4, design §8 steps 2/3) is {@link findImportCycles} and
   * {@link findDeadModules} over step 2's OWN `closures`/`edges` — the SAME data, not a fourth
   * stage reading the tree again.
   *
   * WHY THE TYPE CHECK RUNS UNCONDITIONALLY rather than only when the earlier stages are clean,
   * unlike `runGate`'s manifest/smoke stages. Those two MOUNT and EXECUTE the candidate, so
   * running them on a page that failed its contract would be unsafe. The type check only reads
   * text, and an agent fixing a rejected turn is better served by both the import violation and
   * the type errors in one report than by discovering them one attempt at a time — there are
   * only four attempts.
   */
  async function runTree(input: {
    readonly files: ReadonlyMap<string, string>;
    readonly treePaths: readonly string[];
    readonly pages: readonly PageEntryV1[];
  }): Promise<RunTreeResultV1> {
    const resolved = resolveTreeClosures({ ...input, scanErrors: runTreeImports(input) });
    // Both derived from `resolved`'s own `edges`/`closures`/`anyClosureBlocked` — see each
    // function's doc for why neither re-reads a file or re-derives the import graph.
    const warnings: GateWarning[] = [
      ...findImportCycles(resolved.edges),
      ...findDeadModules({
        files: input.files,
        closures: resolved.closures,
        anyClosureBlocked: resolved.anyClosureBlocked,
      }),
    ];
    if (treeTypeCheck === undefined) {
      return { errors: resolved.errors, warnings, closures: resolved.closures };
    }

    const blockedBy = createClosureIndex(resolved.closures);
    const typeErrors = (await treeTypeCheck({ files: input.files })).map((error) => {
      const blockedPages = blockedBy(error.file);
      return blockedPages === undefined ? error : { ...error, blockedPages };
    });
    return {
      errors: [...resolved.errors, ...typeErrors],
      warnings,
      closures: resolved.closures,
    };
  }

  /**
   * The page-contract stage alone (see the port's own doc for why this is deliberately not
   * `runPage`). `checkPageContract` is pure and synchronous — no compiler, no smoke child, no
   * `GatePorts` at all — but it can still THROW past its own return type: deep JSX nesting
   * raises `./jsx`'s `JsxNestingTooDeepError` past `MAX_JSX_NESTING_DEPTH` (fix round 1,
   * Important 2 — the prior wording claimed this method already "re-labels its errors the way
   * `runGate` itself does", which was false: it only checked `contract instanceof Error` for
   * the RETURNED `SourceStreamTruncatedError` and let the THROWN case escape uncaught, leaving
   * `core/kernel`'s errors-as-values discipline entirely — this method's one non-test caller,
   * `core/kernel/model/handlers/preview-export.ts`'s `extractAndCachePageMeta` (:213, reached
   * through :256), does not wrap this call either).
   * So this wraps the call in the SAME `errore.try` shape `runGate` uses around the identical
   * call (`gate/model/gate.ts`'s `errore.try` around `checkPageContract`) and re-labels its
   * errors the way `runGate` itself does (`kind: "contract"`, `file` set to the display name),
   * rather than mapping them a second, divergent way.
   */
  async function extractPageMeta(input: {
    readonly source: string;
    readonly slug: PageSlug;
    readonly entryRelPath: string;
  }): Promise<PageMetaExtractionV1> {
    const fileName = input.entryRelPath;
    // The entry's own extension decides the reading. It used to be assumed JSX off a
    // slug-built `${slug}.tsx`, which is wrong for the legal `pages/a.ts` entry shape
    // `entryPathSchema` permits — the residual this method's own doc registered.
    const contract = errore.try({
      try: () => checkPageContract(input.source, parsesJsx(input.entryRelPath)),
      catch: (cause) => new PageSourceUnscannableError({ file: fileName, cause }),
    });
    if (contract instanceof Error) {
      // A source whose token stream does not cover it (returned `SourceStreamTruncatedError`),
      // or whose read threw past the engine's own limits (caught above, wrapped the same way
      // `runGate` wraps it), has no readable `meta` — reporting `meta: null` with the real
      // reason beats reporting "this page declares no settings", which would be a false
      // diagnosis (this method's own doc: a page that fails one stage still has a perfectly
      // readable `meta`, and the converse must be just as honest).
      return {
        meta: null,
        errors: [
          {
            kind: "contract" as const,
            code: "UNSCANNABLE_SOURCE",
            message: `${fileName}: ${unscannableMessage(contract)}`,
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

  return { runManifestSlice, runPage, runTree, extractPageMeta };
}

type _Conforms = AssertConforms<GateRunner, ReturnType<typeof createGateRunnerAdapter>>;
