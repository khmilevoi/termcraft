import type { FailureDtoV1 } from "core/protocol";

import type {
  ExportRenderPoolBoundsV1,
  ExportRenderPort,
  ExportRenderResultV1,
  ExportRenderTaskV1,
  RuntimeDeclarationBundleV1,
} from "../export-render";
import type { AssertConforms } from "../index";

/**
 * In-memory {@link ExportRenderPort} fake (6D task brief). `renderOne` defaults to empty
 * opaque `styledFrame`/`textFrame` payloads — Export's orchestration only needs
 * manifest/(w,h) ordering to be exercised, not real terminal-cell content — with an optional
 * `render` override for tests that need to assert on specific rendered bytes. `layout`
 * defaults to a small, genuinely valid JSON `LayoutNode`-shaped tree sized to the requested
 * task (WP-5 Task B1): `core/export/model/package.ts` now JSON-validates every render's
 * `layout` bytes before assembling `layout/<slug>.json`, so an empty/non-JSON default here
 * would make every caller that exercises the real assemble step fail wholesale.
 */

const DEFAULT_POOL_BOUNDS: ExportRenderPoolBoundsV1 = {
  minWorkers: 1,
  maxWorkers: 4,
  readyQueueMultiplier: 2,
};
const DEFAULT_RUNTIME_DECLARATION: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: [],
};

export type ExportRenderFailableMethod = "renderOne";

/**
 * The WHOLE task is recorded, not just its manifestIndex. Recording only the index makes
 * the payload unassertable, and a renderer handed the wrong size/theme/sourceHash then
 * ships a snapshot file NAMED for the requested size but CONTAINING a different render —
 * i.e. a mislabeled acceptance fixture, which is the one failure the export package exists
 * to prevent.
 */
export type ExportRenderCall = {
  readonly method: "renderOne";
  readonly manifestIndex: number;
  readonly task: ExportRenderTaskV1;
};

export interface FakeExportRenderPort extends ExportRenderPort {
  readonly calls: readonly ExportRenderCall[];
  failNext(method: ExportRenderFailableMethod, failure: FailureDtoV1): void;
}

/** A minimal, genuinely valid JSON `LayoutNode`-shaped tree sized to the task's requested viewport — mirrors the real shape `host/adapters/export-render.ts` produces (`id`/`kind`/`box`/`children`, no `text` yet — D-Q6). */
function defaultLayoutBytes(task: ExportRenderTaskV1): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      id: "root",
      kind: "BoxRenderable",
      box: { x: 0, y: 0, width: task.size.w, height: task.size.h },
      children: [],
    }),
  );
}

export function createFakeExportRenderPort(options?: {
  readonly poolBounds?: ExportRenderPoolBoundsV1;
  readonly runtimeDeclaration?: RuntimeDeclarationBundleV1;
  readonly render?: (task: ExportRenderTaskV1) => ExportRenderResultV1;
}): FakeExportRenderPort {
  const calls: ExportRenderCall[] = [];
  const queues: Record<ExportRenderFailableMethod, FailureDtoV1[]> = { renderOne: [] };

  function failNext(method: ExportRenderFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure);
  }

  async function renderOne(task: ExportRenderTaskV1): Promise<FailureDtoV1 | ExportRenderResultV1> {
    calls.push({ method: "renderOne", manifestIndex: task.manifestIndex, task });
    const queued = queues.renderOne.shift();
    if (queued !== undefined) return queued;
    if (options?.render !== undefined) return options.render(task);
    return {
      manifestIndex: task.manifestIndex,
      styledFrame: new Uint8Array(0),
      textFrame: new Uint8Array(0),
      layout: defaultLayoutBytes(task),
    };
  }

  return {
    poolBounds: options?.poolBounds ?? DEFAULT_POOL_BOUNDS,
    runtimeDeclaration: options?.runtimeDeclaration ?? DEFAULT_RUNTIME_DECLARATION,
    renderOne,
    calls,
    failNext,
  };
}

type _Conforms = AssertConforms<ExportRenderPort, FakeExportRenderPort>;
