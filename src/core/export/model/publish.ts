import { wrap } from "@reatom/core"

import type { Clock } from "infrastructure/clock"
import { uuidv7 } from "infrastructure/uuid"
import type { PageSlug } from "entities/page"
import type { StateMachine, ExportAction, ExportState } from "core/machines"
import type { ExportRenderResultV1, PageReader, ProjectWriteCoordinator } from "core/ports"
import type { CommandRejectionCode, FailureDtoV1 } from "core/protocol"

import type { ExportPageInputV1, ExportSnapshotV1 } from "../types"

/**
 * `kernel.export.beginPublication` / `complete` / `failBeforeIntent` —
 * `rendering -> publishing -> idle` (kernel-command-contract §7.5, §12.5, §13.4).
 *
 * §12.5, verbatim: "`beginPublication` reacquires the project-write mutex, compares the
 * current page list/source hashes/settings preconditions with the captured snapshot, and
 * either takes durable publication intent or executes `failBeforeIntent` ... `EXPORT_
 * SNAPSHOT_STALE`; only the publication phase is recoverable." This function is exactly
 * that window: reacquire, revalidate, then intent-or-stale — every exit path releases the
 * permit and leaves the machine at `idle` (never stuck in `publishing`).
 *
 * ALL RENDERS MUST HAVE SUCCEEDED (§7.5's `beginPublication` row: "All page/size renders
 * succeeded"). That is checked FIRST, before the machine or the mutex is ever touched — a
 * known-failed render is data already in hand, exactly like `snapshot.ts`'s `NO_PAGES`
 * check, so a doomed publication attempt costs nothing.
 *
 * REVALIDATION, TWO PARTS, BOTH UNDER THE REACQUIRED PERMIT:
 * 1. Identity/settings: `currentPages` (the caller's freshly-resolved page list — the SAME
 *    shape `snapshot.ts` originally took as input) must match the captured snapshot's page
 *    set, order, and resolved settings exactly.
 * 2. Live source hash: this function itself re-reads each page's CURRENT hash via
 *    `PageReader` — the one live fact `currentPages` cannot carry on its own — and compares
 *    it against the snapshot's captured hash.
 * Either mismatch is staleness, never a distinct code — §12.5 names exactly one failure
 * for this whole precondition class, `EXPORT_SNAPSHOT_STALE`.
 *
 * REATOM NOTE: every port call is `await wrap(...)`-ed, matching `snapshot.ts`'s /
 * `finalize.ts`'s identical rule.
 */

export interface PublishExportRenderOutcomeV1 {
  readonly pageSlug: PageSlug
  readonly outcome: FailureDtoV1 | ExportRenderResultV1
}

export interface PublishExportDeps {
  readonly machine: StateMachine<ExportState, ExportAction>
  readonly projectWrite: ProjectWriteCoordinator
  readonly pageReader: PageReader
  readonly clock: Clock
}

export interface PublishExportInputV1 {
  readonly snapshot: ExportSnapshotV1
  /** The current, freshly-resolved page list/settings to revalidate against the captured snapshot (§12.5). */
  readonly currentPages: readonly ExportPageInputV1[]
  readonly renders: readonly PublishExportRenderOutcomeV1[]
}

/** The durable publication fact this Kernel slice can record — `export/current.json`'s real write is a later slice's job (this module never touches disk). */
export interface ExportPublicationIntentV1 {
  readonly generationId: string
  readonly pageCount: number
  readonly recordedAt: string
}

export type PublishExportResultV1 =
  | { readonly kind: "illegal"; readonly code: CommandRejectionCode }
  | { readonly kind: "failed"; readonly failure: FailureDtoV1 }
  | { readonly kind: "stale"; readonly failure: FailureDtoV1 }
  | { readonly kind: "published"; readonly intent: ExportPublicationIntentV1 }

function staleFailure(reason: string): FailureDtoV1 {
  return { code: "EXPORT_SNAPSHOT_STALE", retryable: true, safeMessage: reason, details: {} }
}

/** True when `current` matches the captured snapshot's identity/settings exactly, in order. */
function settingsStillMatch(snapshot: ExportSnapshotV1, currentPages: readonly ExportPageInputV1[]): boolean {
  if (snapshot.pages.length !== currentPages.length) return false
  for (let i = 0; i < snapshot.pages.length; i++) {
    const captured = snapshot.pages[i]
    const current = currentPages[i]
    if (captured === undefined || current === undefined) return false
    if (captured.pageSlug !== current.pageSlug) return false
    if (captured.manifestIndex !== current.manifestIndex) return false
    if (captured.theme !== current.theme) return false
    if (captured.kitApiVersion !== current.kitApiVersion) return false
    if (captured.minSize.w !== current.minSize.w || captured.minSize.h !== current.minSize.h) return false
  }
  return true
}

export async function publishExport(deps: PublishExportDeps, input: PublishExportInputV1): Promise<PublishExportResultV1> {
  const failedRender = input.renders.find((render): render is PublishExportRenderOutcomeV1 & { readonly outcome: FailureDtoV1 } => "code" in render.outcome)
  if (failedRender !== undefined) return { kind: "failed", failure: failedRender.outcome }

  const began = deps.machine.apply("kernel.export.beginPublication")
  if (began.kind === "illegal") return { kind: "illegal", code: began.code }

  const permit = await wrap(deps.projectWrite.acquire())

  if (!settingsStillMatch(input.snapshot, input.currentPages)) {
    deps.projectWrite.release(permit)
    deps.machine.apply("kernel.export.failBeforeIntent")
    return { kind: "stale", failure: staleFailure("the page list or resolved settings changed since the snapshot was captured") }
  }

  for (const page of input.snapshot.pages) {
    const source = await wrap(deps.pageReader.readSource(page.pageSlug))
    if ("code" in source) {
      deps.projectWrite.release(permit)
      deps.machine.apply("kernel.export.failBeforeIntent")
      return { kind: "failed", failure: source }
    }
    if (source.sourceHash !== page.sourceHash) {
      deps.projectWrite.release(permit)
      deps.machine.apply("kernel.export.failBeforeIntent")
      return { kind: "stale", failure: staleFailure(`page "${page.pageSlug}" source changed since the snapshot was captured`) }
    }
  }

  deps.projectWrite.release(permit)

  const intent: ExportPublicationIntentV1 = {
    generationId: uuidv7(),
    pageCount: input.snapshot.pages.length,
    recordedAt: deps.clock.now().toISOString(),
  }

  const completed = deps.machine.apply("kernel.export.complete")
  if (completed.kind === "illegal") {
    // Defensive only: unreachable in practice — nothing between `beginPublication` and here
    // can move this machine — kept explicit per errore's rule against assuming success.
    return { kind: "illegal", code: completed.code }
  }

  return { kind: "published", intent }
}
