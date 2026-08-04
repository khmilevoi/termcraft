import type { AssertConforms } from "core/ports";
import type { SmokeRenderer, SmokeRequest, SmokeResult } from "gate";
import { DEFAULT_THEME_ID } from "runtime";

import type { RuntimeDeclarationBundleV1 } from "../protocol";
import { SupervisorError, runOneShotSession } from "../supervisor";
import type { Clock, SpawnCommand, SpawnFn } from "../supervisor";
import type { HostSessionSpec, TerminalCapabilities } from "../types";
import { resolveMountTreeRevision } from "./mount-tree-revision";

/**
 * `createSmokeRendererAdapter` (M4): `host` implements gate's `SmokeRenderer` port over
 * the real `runOneShotSession` in `smoke` mode (adapter-ring plan, Task 6). The dependency
 * points host → gate's port (imported type-only from `gate`, its own public barrel), never
 * the reverse — `gate` never imports `host`.
 *
 * `SmokeRequest` carries only the tree coordinates (`treeRoot`/`entryRelPath`/`expectedFiles`),
 * `sourceHash`, `size` and `kitApiVersion`, but
 * `HostSessionSpec` also requires `pageSlug`/`theme`/`capabilities`. A smoke render only
 * mounts the candidate and seals one frame to prove it renders at all — pass/fail never
 * depends on the slug, theme, or capability values — so these three fields are filled with
 * fixed, documented smoke defaults rather than invented per-call values:
 * - `pageSlug`: `SMOKE_PAGE_SLUG`, a fixed placeholder (no real page identity applies here).
 * - `theme`: `DEFAULT_THEME_ID` ("dark-default"), the design system's own MVP default theme
 *   (`runtime/model/tokens.ts`) — not invented, the project's real default.
 * - `capabilities`: 24-bit truecolor, mirroring `runtime/model/capabilities.ts`'s own
 *   documented `colorDepthAtom` MVP default.
 *
 * `treeRevision` is NOT in that list and is not a default: it is DERIVED from the request's own
 * `expectedFiles`, which is the candidate tree's inventory, so it is a real fact about what this
 * smoke render mounts. See `resolveMountTreeRevision`.
 */

const SMOKE_PAGE_SLUG = "smoke-check";
const SMOKE_CAPABILITIES: TerminalCapabilities = { colorDepth: 24 };

function toSmokeSessionSpec(request: SmokeRequest): SupervisorError | HostSessionSpec {
  // `SmokeRequest` carries the candidate's inventory but no revision — see
  // `resolveMountTreeRevision`'s own doc for why a one-shot derives it rather than threading it.
  const treeRevision = resolveMountTreeRevision(request.expectedFiles);
  if (treeRevision instanceof Error) return treeRevision;
  return {
    mode: "smoke",
    interactionMode: "static",
    pageSlug: SMOKE_PAGE_SLUG,
    treeRoot: request.treeRoot,
    entryRelPath: request.entryRelPath,
    expectedFiles: request.expectedFiles,
    sourceHash: request.sourceHash,
    treeRevision,
    kitApiVersion: request.kitApiVersion,
    size: request.size,
    theme: DEFAULT_THEME_ID,
    capabilities: SMOKE_CAPABILITIES,
  };
}

/** Bounded plain text (host-supervision §13) — a one-shot failure's reason must never be unbounded. */
function boundedMessage(raw: string): string {
  return raw.length > 200 ? `${raw.slice(0, 197)}...` : raw;
}

export interface SmokeRendererAdapterDeps {
  readonly spawnFor: (spec: HostSessionSpec) => SpawnCommand;
  readonly spawn: SpawnFn;
  readonly clock: Clock;
  readonly runtimeDeclaration: RuntimeDeclarationBundleV1;
}

export function createSmokeRendererAdapter(deps: SmokeRendererAdapterDeps): SmokeRenderer {
  async function render(request: SmokeRequest): Promise<SmokeResult> {
    const spec = toSmokeSessionSpec(request);
    if (spec instanceof Error) {
      return { ok: false, code: String(spec.code), message: boundedMessage(spec.message) };
    }
    const result = await runOneShotSession(spec, {
      spawn: deps.spawn,
      command: deps.spawnFor(spec),
      clock: deps.clock,
      runtimeDeclaration: deps.runtimeDeclaration,
    });
    if (result instanceof Error) {
      return { ok: false, code: String(result.code), message: boundedMessage(result.message) };
    }
    return { ok: true };
  }

  return { render };
}

type _Conforms = AssertConforms<SmokeRenderer, ReturnType<typeof createSmokeRendererAdapter>>;
