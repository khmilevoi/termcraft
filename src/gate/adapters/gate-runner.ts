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
import { runGate, runTreeImports } from "../model/gate";
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
 * (`treePaths`) the flat allowlist scan already resolves against. One whole-tree pass now
 * produces both results; `core` still never imports `gate` — only this adapter, behind the
 * port, does the resolving.
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
   * that is not code ({@link isCodeFile}) or whose text `files` does not hold answers `[]` —
   * no edges to walk, not a resolution failure: an asset can be a legal closure member (design
   * §6 places no extension restriction on a resolution TARGET) and simply has nothing to scan.
   */
  function edgesOf(files: ReadonlyMap<string, string>, relPath: string): readonly string[] {
    if (!isCodeFile(relPath)) return [];
    const source = files.get(relPath);
    if (source === undefined) return [];
    return scanModuleEdges(source);
  }

  /**
   * Resolves every manifest entry's closure (design §7) over the SAME whole-tree inventory
   * `treePaths` the flat allowlist scan below already resolves against. A closure that cannot
   * be resolved (an edge anywhere in it is illegal or missing — {@link resolveClosure}'s own
   * doc: "an illegal edge ANYWHERE in the closure is fatal here rather than merely skipped")
   * reports a `GateErrorV1` naming the page and is simply ABSENT from `closures` — never a
   * fabricated partial file list. This does not fail open: the SAME edge is independently
   * caught by the flat per-file scan below too (`scanTreeImports` scans every code file
   * unconditionally, reachable or not), so a candidate whose closure fails to resolve already
   * carries a fatal error and never reaches a caller that would consult its (absent) closure.
   */
  function resolveClosuresFor(input: {
    readonly pages: readonly PageEntryV1[];
    readonly files: ReadonlyMap<string, string>;
    readonly treePaths: readonly string[];
  }): { readonly closures: readonly GateClosureV1[]; readonly errors: readonly GateError[] } {
    const present = new Set(input.treePaths);
    const has = (relPath: string) => present.has(relPath);
    const closures: GateClosureV1[] = [];
    const errors: GateError[] = [];
    for (const page of input.pages) {
      const resolved = resolveClosure({
        entry: page.entry,
        has,
        edgesOf: (relPath) => edgesOf(input.files, relPath),
      });
      if (resolved instanceof Error) {
        // Same code mapping `scanImportAllowlist` uses for the identical `SpecifierRejectedError`
        // (`gate/model/import-scan.ts`): "UNRESOLVED" is usually a typo or a missing file, every
        // other code is a rule violation.
        errors.push({
          kind: "import",
          code: resolved.code === "UNRESOLVED" ? "UNRESOLVED_IMPORT" : "FORBIDDEN_IMPORT",
          message: `page "${page.slug}": ${resolved.message}`,
          file: String(resolved.from),
        });
        continue;
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
