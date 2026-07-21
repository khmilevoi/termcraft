import { wrap } from "@reatom/core"

import type { Clock } from "infrastructure/clock"
import type { PageSlug } from "entities/page"
import type { StateMachine, ExportAction, ExportState } from "core/machines"
import type { PageReader, ProjectWriteCoordinator } from "core/ports"
import type { CommandRejectionCode, FailureDtoV1 } from "core/protocol"

import type { ExportPageInputV1, ExportPageSnapshotV1, ExportSnapshotV1 } from "../types"

/**
 * `kernel.export.begin` / `beginRendering` — `idle -> preparing -> rendering`
 * (kernel-command-contract §7.5, §12.5).
 *
 * THE PERMIT DISCIPLINE: §12.5, verbatim: "Preparation acquires one short
 * `ProjectWritePermit`, reads the exact ordered page list, source bytes/hashes, and
 * resolved settings into one immutable snapshot, then releases the permit." This function
 * IS that acquire-read-release window — nothing downstream of it (`render-jobs.ts`,
 * `package.ts`) ever sees a `ProjectWriteCoordinator` at all, which is how "rendering holds
 * no permit/mutex" (§13.4) is a structural fact, not a runtime discipline someone could
 * forget.
 *
 * REFUSAL ORDERING (§7.5's `idle -> preparing` row: "trusted project, at least one page, no
 * active turn, no other export"). `PROJECT_NOT_READY`/`PROJECT_UNTRUSTED`/`TURN_RUNNING` are
 * cross-cutting guard-layer rejections (`core/capabilities/model/guards.ts`) evaluated at
 * command dispatch, BEFORE this function is ever called — `KernelStateSnapshot` (that
 * guard's only input) carries no page count, so `NO_PAGES` structurally cannot be checked
 * there. This function is the one place with `input.pages` in hand, so it owns exactly that
 * one precondition, checked FIRST and without ever touching the machine or the mutex — a
 * rejected command must cost nothing. "No other export" is `EXPORT_TRANSITION_TABLE`'s own
 * `idle`-only legality, enforced by `machine.apply` itself immediately after.
 *
 * CALLER-RESOLVED SETTINGS: `ExportPageInputV1`'s `sourcePath`/`minSize`/`theme`/
 * `kitApiVersion` are never derived here — mirroring `core/ports/staging.ts`'s
 * `StagingPageSourceV1` doc ("already resolved to a readable source path by the caller"),
 * this module only re-reads bytes/hash LIVE, under the permit, to prove the source has not
 * drifted since those settings were resolved (the last successful Gate-validated turn).
 *
 * ON A READ FAILURE: the permit is released (every exit path releases it) and the machine
 * is explicitly failed back to `idle` via `kernel.export.fail` (§7.5: "`preparing`,
 * `rendering` -> `kernel.export.fail` -> `idle`: No publication becomes visible") — never
 * left stranded in `preparing`, which would block every later export attempt with
 * `OPERATION_BUSY` forever.
 *
 * REATOM NOTE: every port call is `await wrap(...)`-ed, matching `admission.ts`'s /
 * `finalize.ts`'s identical rule — code after each await calls `deps.machine.apply` (a
 * Reatom write), and a plain unwrapped `await` would resume outside the caller's
 * `context.start(...)` frame.
 */

export interface CaptureExportSnapshotDeps {
  readonly machine: StateMachine<ExportState, ExportAction>
  readonly projectWrite: ProjectWriteCoordinator
  readonly pageReader: PageReader
  readonly clock: Clock
}

export interface CaptureExportSnapshotInputV1 {
  readonly pages: readonly ExportPageInputV1[]
}

export type CaptureExportSnapshotResultV1 =
  | { readonly kind: "illegal"; readonly code: CommandRejectionCode }
  | { readonly kind: "failed"; readonly failure: FailureDtoV1 }
  | { readonly kind: "captured"; readonly snapshot: ExportSnapshotV1 }

function pageReadFailure(pageSlug: PageSlug, cause: FailureDtoV1): FailureDtoV1 {
  return {
    code: "PERSISTENCE_FAILED",
    retryable: cause.retryable,
    safeMessage: `failed to read canonical source for page "${pageSlug}": ${cause.safeMessage}`,
    details: { pageSlug },
  }
}

export async function captureExportSnapshot(
  deps: CaptureExportSnapshotDeps,
  input: CaptureExportSnapshotInputV1,
): Promise<CaptureExportSnapshotResultV1> {
  if (input.pages.length === 0) return { kind: "illegal", code: "NO_PAGES" }

  const began = deps.machine.apply("kernel.export.begin")
  if (began.kind === "illegal") return { kind: "illegal", code: began.code }

  const permit = await wrap(deps.projectWrite.acquire())

  const pages: ExportPageSnapshotV1[] = []
  for (const page of input.pages) {
    const source = await wrap(deps.pageReader.readSource(page.pageSlug))
    if ("code" in source) {
      deps.projectWrite.release(permit)
      deps.machine.apply("kernel.export.fail")
      return { kind: "failed", failure: pageReadFailure(page.pageSlug, source) }
    }
    pages.push({ ...page, sourceHash: source.sourceHash, bytes: source.bytes })
  }

  deps.projectWrite.release(permit)

  const beganRendering = deps.machine.apply("kernel.export.beginRendering")
  if (beganRendering.kind === "illegal") {
    // Defensive only: unreachable in practice — nothing between `begin` and here can move
    // this machine — but per errore's rule against assuming success, it is an explicit
    // branch rather than a swallowed possibility.
    return { kind: "illegal", code: beganRendering.code }
  }

  return {
    kind: "captured",
    snapshot: { pages, capturedAt: deps.clock.now().toISOString() },
  }
}
