import type { FailureDtoV1 } from "core/protocol"
import type { AssertConforms } from "../index"
import type {
  ExportRenderPoolBoundsV1,
  ExportRenderPort,
  ExportRenderResultV1,
  ExportRenderTaskV1,
  RuntimeDeclarationBundleV1,
} from "../export-render"

/**
 * In-memory {@link ExportRenderPort} fake (6D task brief). `renderOne` defaults to empty
 * opaque byte payloads — Export's orchestration only needs manifest/(w,h) ordering to be
 * exercised, not real terminal-cell content — with an optional `render` override for tests
 * that need to assert on specific rendered bytes.
 */

const DEFAULT_POOL_BOUNDS: ExportRenderPoolBoundsV1 = { minWorkers: 1, maxWorkers: 4, readyQueueMultiplier: 2 }
const DEFAULT_RUNTIME_DECLARATION: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: [],
}

export type ExportRenderFailableMethod = "renderOne"

export type ExportRenderCall = { readonly method: "renderOne"; readonly manifestIndex: number }

export interface FakeExportRenderPort extends ExportRenderPort {
  readonly calls: readonly ExportRenderCall[]
  failNext(method: ExportRenderFailableMethod, failure: FailureDtoV1): void
}

export function createFakeExportRenderPort(options?: {
  readonly poolBounds?: ExportRenderPoolBoundsV1
  readonly runtimeDeclaration?: RuntimeDeclarationBundleV1
  readonly render?: (task: ExportRenderTaskV1) => ExportRenderResultV1
}): FakeExportRenderPort {
  const calls: ExportRenderCall[] = []
  const queues: Record<ExportRenderFailableMethod, FailureDtoV1[]> = { renderOne: [] }

  function failNext(method: ExportRenderFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure)
  }

  async function renderOne(task: ExportRenderTaskV1): Promise<FailureDtoV1 | ExportRenderResultV1> {
    calls.push({ method: "renderOne", manifestIndex: task.manifestIndex })
    const queued = queues.renderOne.shift()
    if (queued !== undefined) return queued
    if (options?.render !== undefined) return options.render(task)
    return { manifestIndex: task.manifestIndex, styledFrame: new Uint8Array(0), textFrame: new Uint8Array(0), layout: new Uint8Array(0) }
  }

  return {
    poolBounds: options?.poolBounds ?? DEFAULT_POOL_BOUNDS,
    runtimeDeclaration: options?.runtimeDeclaration ?? DEFAULT_RUNTIME_DECLARATION,
    renderOne,
    calls,
    failNext,
  }
}

type _Conforms = AssertConforms<ExportRenderPort, FakeExportRenderPort>
