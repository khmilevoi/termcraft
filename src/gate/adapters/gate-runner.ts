import type {
  AssertConforms,
  GateClosureV1,
  GateRunResultV1,
  GateRunner,
  ManifestSliceResultV1,
  PageMetaExtractionV1,
  RunTreeImportsResultV1,
} from "core/ports";
import { resolveClosure } from "entities/design-tree";
import type { ClosureV1, PageEntryV1 } from "entities/design-tree";
import type { PageSlug } from "entities/page";

// Relative (not `gate`'s own barrel): `gate/index.ts` re-exports this adapter (Task 6's own
// change), so importing the barrel back from here would be a self-referencing cycle.
import { hasTreePath, runGate, runTreeImports } from "../model/gate";
import type { GatePorts } from "../model/gate";
import { checkManifestSlice } from "../model/manifest";
import { checkPageContract } from "../model/page-contract";
import { createSmokeRender } from "../model/smoke";
import { isCodeFile, scanModuleEdges } from "../model/tree-scan";
import { createTypeChecker } from "../model/type-check";
import type { SmokeRenderer } from "../ports/smoke-renderer";
import type { GateError } from "../types";

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
 * CORRECTED (task-13 review round 2): round 1's own closure resolution had two gaps, both
 * fixed in `resolveClosuresFor`/`edgesOf` below — see their own doc comments for the full
 * rationale and the executed before/after: (Important 1) a code file the walk reached but had
 * no source text for silently truncated the closure with ZERO diagnostics anywhere; (Important
 * 2) every edge `resolveClosure` itself rejected was reported a SECOND time here, on top of the
 * flat scan's own independent report of the identical edge — measured as 4 near-identical
 * diagnostics for 1 real violation across 3 pages sharing one bad shared-module import.
 */

function createTypeCheckPort(
  tscExePath: string | undefined,
  runtimeDts: string | undefined,
): ((source: string, fileName: string) => Promise<GateError[]>) | undefined {
  if (tscExePath === undefined || runtimeDts === undefined) return undefined;
  return createTypeChecker({ tscExePath, runtimeDts });
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
   * One manifest entry's edge reader for {@link resolveClosure}: the SAME file text
   * `runTreeImports` itself scans, read back through `scanModuleEdges` (the raw-edge sibling
   * of `scanImportAllowlist` — both share `readStaticImportSpecifier`, so the closure walk
   * can never see a different import graph than the allowlist scan just checked). A relPath
   * that is not code ({@link isCodeFile}) answers `[]` — no edges to walk, not a resolution
   * failure: an asset can be a legal closure member (design §6 places no extension restriction
   * on a resolution TARGET) and simply has nothing to scan.
   *
   * A relPath that IS code but whose text `files` does not hold ALSO answers `[]` — there is
   * no other honest answer `edgesOf` itself can give — but records `relPath` into `unscanned`
   * first (task-13 review round 2, Important 1): the caller uses that set to refuse to report
   * this walk's closure at all, rather than silently returning it truncated at exactly the
   * point this scan ran out of text to read. See {@link resolveClosuresFor}'s own doc for the
   * full rationale and why this is NOT the same gap `UNSCANNED_IMPORT` already covers.
   */
  function edgesOf(
    files: ReadonlyMap<string, string>,
    relPath: string,
    unscanned: Set<string>,
  ): readonly string[] {
    if (!isCodeFile(relPath)) return [];
    const source = files.get(relPath);
    if (source === undefined) {
      unscanned.add(relPath);
      return [];
    }
    return scanModuleEdges(source);
  }

  /**
   * Resolves every manifest entry's closure (design §7) over the SAME whole-tree inventory
   * `treePaths` the flat allowlist scan below already resolves against, and the SAME `files`
   * text it reads. Two distinct failure shapes, both excluding the slug from `closures` —
   * never a fabricated partial file list — but only ONE of them adds its own diagnostic here:
   *
   * 1. `resolved instanceof Error` — an edge `resolveDesignSpecifier` itself rejects (illegal
   *    shape, escapes the tree, or genuinely unresolvable). NO error is added here for this
   *    case (task-13 review round 2, Important 2 — corrected from round 1, which double-
   *    reported every such edge): `edgesOf` above only ever returns a real edge for a file
   *    whose text is in `files`, and the flat scan below (`scanTreeImports`) scans every ONE
   *    of those same files' own imports unconditionally — so any edge this walk could reject,
   *    the flat scan has ALREADY rejected, same file, same specifier, same line/column.
   *    Measured: three pages sharing one bad edge in one shared module used to produce 4
   *    near-identical diagnostics for the ONE violation; this file's own test pins the fixed
   *    count.
   * 2. `unscanned.size > 0` — a code file this walk reached has NO text in `files` at all, so
   *    `edgesOf` had nothing to scan and the walk stopped there with no signal that anything
   *    was missing (task-13 review round 2, Important 1). This is NOT the same fact
   *    `UNSCANNED_IMPORT` (the flat scan's own vocabulary) reports: `UNSCANNED_IMPORT` fires
   *    only when some OTHER file the flat scan DID scan imports the missing one, and says
   *    nothing about which page's closure that endangers; a missing file that is this page's
   *    OWN entry, or reachable only through another file ALSO missing from `files`, produces
   *    NOTHING from the flat scan at all — silent truncation with zero diagnostics anywhere,
   *    which is the exact §7 bug this whole task exists to prevent. So this DOES add its own
   *    error here, under its own code, naming the page whose closure cannot be trusted.
   */
  function resolveClosuresFor(input: {
    readonly pages: readonly PageEntryV1[];
    readonly files: ReadonlyMap<string, string>;
    readonly treePaths: readonly string[];
  }): { readonly closures: readonly GateClosureV1[]; readonly errors: readonly GateError[] } {
    const has = hasTreePath(input.treePaths);
    const closures: GateClosureV1[] = [];
    const errors: GateError[] = [];
    for (const page of input.pages) {
      const unscanned = new Set<string>();
      const resolved = resolveClosure({
        entry: page.entry,
        has,
        edgesOf: (relPath) => edgesOf(input.files, relPath, unscanned),
      });
      if (resolved instanceof Error) continue; // see this function's own doc, case 1

      if (unscanned.size > 0) {
        for (const relPath of unscanned) {
          errors.push({
            kind: "import",
            code: "CLOSURE_SOURCE_MISSING",
            message: `page "${page.slug}": its closure reaches "${relPath}", whose source this pass was never given — the closure cannot be verified complete`,
            file: relPath,
          });
        }
        continue; // see this function's own doc, case 2
      }

      closures.push({ slug: page.slug, files: resolved.files });
    }
    return { closures, errors };
  }

  /**
   * The whole-tree import allowlist (design §8 step 4) plus every manifest entry's resolved
   * closure (task-13 review round 1, Critical C1 — see this file's header). `gate/model/
   * gate.ts`'s own `runTreeImports` is synchronous — it does no I/O, only token-scanning over
   * the text it is handed — so this only wraps it in a promise the same way every other method
   * on this port is async, keeping `core` looking at one uniform shape.
   */
  async function runTreeImportsPort(input: {
    readonly files: ReadonlyMap<string, string>;
    readonly treePaths: readonly string[];
    readonly pages: readonly PageEntryV1[];
  }): Promise<RunTreeImportsResultV1> {
    const scanErrors = runTreeImports(input);
    const { closures, errors: closureErrors } = resolveClosuresFor(input);
    return { errors: [...scanErrors, ...closureErrors], closures };
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
    const contract = checkPageContract(input.source);
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
