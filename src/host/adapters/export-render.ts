import os from "node:os";

import type {
  AssertConforms,
  ExportRenderPoolBoundsV1,
  ExportRenderPort,
  ExportRenderResultV1,
  ExportRenderTaskV1,
  RuntimeDeclarationBundleV1,
} from "core/ports";
import type { FailureDtoV1 } from "core/protocol";

import { EMBEDDED_RUNTIME_DECLARATION, ProtocolError } from "../protocol";
import type { PublicLimits } from "../protocol";
import {
  SupervisorError,
  createExportPool,
  resolveExportWorkerCount,
  runOneShotSession,
} from "../supervisor";
import type { Clock, ExportTask, PreviewFrame, SpawnCommand, SpawnFn } from "../supervisor";
import type { HostSessionSpec, TerminalCapabilities } from "../types";

/**
 * `createExportRenderAdapter`: the production `ExportRenderPort` over `host`'s real
 * `createExportPool`/`resolveExportWorkerCount`/`runOneShotSession` (adapter-ring plan,
 * Task 5). Concurrency across MANY tasks is Export's own orchestration job
 * (`core/export/model/render-jobs.ts` reads `poolBounds` to size its own scheduling,
 * per `core/ports/export-render.ts`'s header) — this adapter's `renderOne` still runs each
 * task THROUGH the pool (a single-element `run()` call) so every render goes through the
 * same all-or-nothing one-shot machinery the pool already proves, rather than calling
 * `runOneShotSession` a second, parallel way.
 *
 * KNOWN GAPS (documented, not fabricated — flagged in the WP-2 lane report):
 * - `ExportRenderTaskV1` (core/ports/export-render.ts) carries no `capabilities` field,
 *   even though `HostSessionSpec` requires one. Exported packages want maximum color
 *   fidelity, so this fills the gap with a fixed 24-bit truecolor default
 *   (`EXPORT_CAPABILITIES` below) — a reasoned interim value, not a guess at a load-
 *   bearing color, and flagged for the maintainer in case a caller-chosen depth is
 *   needed later (that would need an additive `ExportRenderTaskV1` field).
 * - `renderOne`'s `layout` output is always an empty `Uint8Array` today. The one-shot
 *   capture (`host/supervisor/model/one-shot.ts`) seals a single styled `PreviewFrame`;
 *   it does NOT produce a resolved layout tree — that file's own header calls this "the
 *   documented non-conformant MVP stand-in", deferred "until the 2A bulk schema lands".
 *   An empty payload is the faithful "not yet available" marker; the maintainer should
 *   confirm this is acceptable for WP-2's scope before Export's packaging step (WP-5)
 *   starts consuming `layout` for real.
 */

const EXPORT_CAPABILITIES: TerminalCapabilities = { colorDepth: 24 };

function toExportSessionSpec(task: ExportRenderTaskV1): HostSessionSpec {
  return {
    mode: "export",
    interactionMode: "static",
    pageSlug: task.pageSlug,
    sourcePath: task.sourcePath,
    sourceHash: task.sourceHash,
    kitApiVersion: task.kitApiVersion,
    size: task.size,
    theme: task.theme,
    capabilities: EXPORT_CAPABILITIES,
  };
}

function encodeStyledFrame(frame: PreviewFrame): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ width: frame.width, height: frame.height, rows: frame.rows }),
  );
}

function encodeTextFrame(frame: PreviewFrame): Uint8Array {
  const lines = frame.rows.map((row) => row.map((run) => run.text).join(""));
  return new TextEncoder().encode(lines.join("\n"));
}

function toExportFailureDto(error: ProtocolError | SupervisorError): FailureDtoV1 {
  return {
    code: "EXPORT_RENDER_FAILED",
    retryable: false,
    safeMessage: error.message,
    details: { errorTag: error._tag },
  };
}

export interface ExportRenderAdapterDeps {
  readonly spawn: SpawnFn;
  readonly command: SpawnCommand;
  readonly clock: Clock;
  readonly runtimeDeclaration?: RuntimeDeclarationBundleV1;
  readonly offeredLimits?: PublicLimits;
  /** Defaults to `os.cpus().length` (Spike-free — no test needs to fake CPU topology). */
  readonly cpuCount?: number;
  /** Machine-local worker override (§11.4: clamped 1-8 by `resolveExportWorkerCount`). */
  readonly workers?: number;
}

export function createExportRenderAdapter(deps: ExportRenderAdapterDeps): ExportRenderPort {
  const runtimeDeclaration = deps.runtimeDeclaration ?? EMBEDDED_RUNTIME_DECLARATION;
  // `host/protocol`'s own `RuntimeDeclarationBundleV1` carries mutable arrays while the
  // core port's version (what `runtimeDeclaration` above is typed as, for the port field
  // below) declares them `readonly` — the two are otherwise identical. `runOneShotSession`
  // needs the mutable-array shape, so this is an honest field-by-field copy, not a cast.
  const oneShotRuntimeDeclaration = {
    module: runtimeDeclaration.module,
    currentKitApiVersion: runtimeDeclaration.currentKitApiVersion,
    supportedKitApiVersions: [...runtimeDeclaration.supportedKitApiVersions],
    publicCapabilityIds: [...runtimeDeclaration.publicCapabilityIds],
  };
  const cpuCount = deps.cpuCount ?? os.cpus().length;
  const poolBounds: ExportRenderPoolBoundsV1 = {
    minWorkers: 1,
    maxWorkers: resolveExportWorkerCount(cpuCount, deps.workers),
    readyQueueMultiplier: 2,
  };
  const pool = createExportPool({
    runTask: (task) =>
      runOneShotSession(task.spec, {
        spawn: deps.spawn,
        command: deps.command,
        clock: deps.clock,
        runtimeDeclaration: oneShotRuntimeDeclaration,
        offeredLimits: deps.offeredLimits,
      }),
    cpuCount,
    workers: deps.workers,
  });

  async function renderOne(task: ExportRenderTaskV1): Promise<FailureDtoV1 | ExportRenderResultV1> {
    const exportTask: ExportTask = {
      spec: toExportSessionSpec(task),
      manifestIndex: task.manifestIndex,
    };
    const outcomes = await pool.run([exportTask]);
    if (outcomes instanceof Error) return toExportFailureDto(outcomes);
    const outcome = outcomes[0];
    if (outcome === undefined) {
      return toExportFailureDto(
        new SupervisorError({
          code: "TRANSPORT_ERROR",
          reason: "export pool returned no outcome for a single-task run",
        }),
      );
    }
    if (outcome.result instanceof Error) return toExportFailureDto(outcome.result);
    const { frame } = outcome.result;
    return {
      manifestIndex: task.manifestIndex,
      styledFrame: encodeStyledFrame(frame),
      textFrame: encodeTextFrame(frame),
      layout: new Uint8Array(0), // see this file's header note — no layout-tree source yet
    };
  }

  return { poolBounds, runtimeDeclaration, renderOne };
}

type _Conforms = AssertConforms<ExportRenderPort, ReturnType<typeof createExportRenderAdapter>>;
