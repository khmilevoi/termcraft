import type {
  AssertConforms,
  GateRunResultV1,
  GateRunner,
  ManifestSliceResultV1,
} from "core/ports";
import type { PageSlug } from "entities/page";

// Relative (not `gate`'s own barrel): `gate/index.ts` re-exports this adapter (Task 6's own
// change), so importing the barrel back from here would be a self-referencing cycle.
import { runGate } from "../model/gate";
import type { GatePorts } from "../model/gate";
import { checkManifestSlice } from "../model/manifest";
import { createSmokeRender } from "../model/smoke";
import { materializeCompiler } from "../model/tsc-extract";
import type { CompilerAssets } from "../model/tsc-extract";
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
 * FLAGGED: `typeCheck` is wired ONLY when BOTH `compilerAssets` and `runtimeDts` are
 * supplied. `createTypeChecker` (`gate/model/type-check.ts`) needs the ambient
 * `@termcraft/runtime` `.d.ts` TEXT, and no production source for that text exists
 * anywhere in the codebase yet (`gate/model/tsc-extract.ts`'s own comment: "phase 8 will
 * embed + inject the curated 88-file set"; today only a hand-written test fixture exists
 * in `type-check.test.ts`). Until phase 8 lands it, omitting `typeCheck` here is honest —
 * `runGate`'s own `ports.typeCheck` parameter is optional for exactly this reason.
 */

/** Bounded plain text (host-supervision §13 convention gate itself follows in `type-check.ts`). */
function boundedPlainText(raw: string): string {
  return raw.length > 200 ? `${raw.slice(0, 197)}...` : raw;
}

function createTypeCheckPort(
  compilerAssets: CompilerAssets | undefined,
  runtimeDts: string | undefined,
): ((source: string, fileName: string) => Promise<GateError[]>) | undefined {
  if (compilerAssets === undefined || runtimeDts === undefined) return undefined;

  let cachedChecker: ((source: string, fileName: string) => Promise<GateError[]>) | null = null;
  let materializeFailure: GateError | null = null;

  return async (source, fileName) => {
    if (materializeFailure !== null) return [materializeFailure];
    if (cachedChecker === null) {
      const exePath = materializeCompiler(compilerAssets);
      if (exePath instanceof Error) {
        materializeFailure = {
          kind: "type",
          code: "TYPE_CHECK_UNAVAILABLE",
          message: boundedPlainText(
            `type check unavailable — failed to materialize the TypeScript compiler: ${exePath.message}`,
          ),
        };
        return [materializeFailure];
      }
      cachedChecker = createTypeChecker({ tscExePath: exePath, runtimeDts });
    }
    return cachedChecker(source, fileName);
  };
}

export interface GateRunnerAdapterDeps {
  readonly smokeRenderer: SmokeRenderer;
  readonly compilerAssets?: CompilerAssets;
  /** See this file's header note — no production source exists for this yet. */
  readonly runtimeDts?: string;
  readonly checkManifest?: GatePorts["checkManifest"];
}

export function createGateRunnerAdapter(deps: GateRunnerAdapterDeps): GateRunner {
  const typeCheck = createTypeCheckPort(deps.compilerAssets, deps.runtimeDts);

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

  return { runManifestSlice, runPage };
}

type _Conforms = AssertConforms<GateRunner, ReturnType<typeof createGateRunnerAdapter>>;
