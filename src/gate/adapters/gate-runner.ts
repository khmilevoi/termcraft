import type {
  AssertConforms,
  GateRunResultV1,
  GateRunner,
  ManifestSliceResultV1,
  PageMetaExtractionV1,
} from "core/ports";
import type { PageSlug } from "entities/page";

// Relative (not `gate`'s own barrel): `gate/index.ts` re-exports this adapter (Task 6's own
// change), so importing the barrel back from here would be a self-referencing cycle.
import { runGate } from "../model/gate";
import type { GatePorts } from "../model/gate";
import { checkManifestSlice } from "../model/manifest";
import { checkPageContract } from "../model/page-contract";
import { createSmokeRender } from "../model/smoke";
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
    readonly presentSlugs: readonly PageSlug[];
  }): Promise<ManifestSliceResultV1> {
    return checkManifestSlice(input);
  }

  async function runPage(input: {
    readonly source: string;
    readonly slug: PageSlug;
    readonly fileName?: string;
    readonly sourcePath?: string;
  }): Promise<GateRunResultV1> {
    const fileName = input.fileName ?? `${input.slug}.tsx`;
    // The smoke stage needs a path it can actually resolve on disk (see this file's header,
    // "CLOSED (was FLAGGED)") — `sourcePath` is preferred when a caller staged a real
    // candidate file; `fileName` stays the diagnostics-facing display name regardless.
    const smokeSourcePath = input.sourcePath ?? fileName;
    const ports: GatePorts = {
      ...(typeCheck !== undefined ? { typeCheck } : {}),
      ...(deps.checkManifest !== undefined ? { checkManifest: deps.checkManifest } : {}),
      smokeRender: createSmokeRender(deps.smokeRenderer, smokeSourcePath),
    };
    return runGate({ source: input.source, slug: input.slug, fileName }, ports);
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

  return { runManifestSlice, runPage, extractPageMeta };
}

type _Conforms = AssertConforms<GateRunner, ReturnType<typeof createGateRunnerAdapter>>;
