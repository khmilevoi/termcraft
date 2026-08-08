import { wrap } from "@reatom/core";

import type { ExportAction, ExportState, StateMachine } from "core/machines";
import type {
  DesignTreeReader,
  ExportPublishPlanV1,
  ExportPublishPort,
  ExportRenderResultV1,
  ProjectWriteCoordinator,
} from "core/ports";
import { readPageEntrySource, readPageOrder } from "core/project";
import type { CommandRejectionCode, FailureDtoV1 } from "core/protocol";
import type { PageSlug } from "entities/page";
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

import type { ExportPageInputV1, ExportSnapshotV1 } from "../types";
import type { ExportPackageFileV1 } from "./package";
import { buildExportPublishOperations } from "./publish-plan";

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
 *    the design tree — the one live fact `currentPages` cannot carry on its own — and compares
 *    it against the snapshot's captured hash.
 * Either mismatch is staleness, never a distinct code — §12.5 names exactly one failure
 * for this whole precondition class, `EXPORT_SNAPSHOT_STALE`.
 *
 * PUBLICATION ITSELF, STILL UNDER THE SAME PERMIT (WP-5 Task B3): once revalidation passes,
 * this function reads the current export pointer (`ExportPublishPort.readPointer`, WP-5
 * Phase C) — `null` for a project's first publish, an existing {@link ExportPointerV1} on a
 * later one, or a `FailureDtoV1` if the durable pointer is itself corrupt (treated the same
 * as any other pre-intent failure below) — then hands `input.files` (the caller's already-
 * assembled package, `assembleExportPackage`'s output) plus that pointer to
 * `buildExportPublishOperations` (`./publish-plan.ts`) to build the REAL
 * `ExportPublishPlanV1.operations`/`.payloads`, and calls `ExportPublishPort.publish` before
 * the permit is released — the transaction's own commit/recovery boundary (`turn-durability`
 * §10 steps 4-6) is what actually makes the generation durable, not this function. A
 * `FailureDtoV1` back from the port is `failBeforeIntent` exactly like a revalidation
 * failure — its own `EXPORT_SNAPSHOT_STALE` (the store engine's lower-level precondition
 * re-check) maps to `stale`, every other code (e.g. `EXPORT_PUBLICATION_FAILED`) maps to
 * `failed` — only on success does the machine `complete`.
 *
 * REATOM NOTE: every port call (`readPointer` included) is `await wrap(...)`-ed, matching
 * `snapshot.ts`'s / `finalize.ts`'s identical rule.
 */

export interface PublishExportRenderOutcomeV1 {
  readonly pageSlug: PageSlug;
  readonly outcome: FailureDtoV1 | ExportRenderResultV1;
}

export interface PublishExportDeps {
  readonly machine: StateMachine<ExportState, ExportAction>;
  readonly projectWrite: ProjectWriteCoordinator;
  /**
   * RETYPED BY TASK 14 (was `pageReader: PageReader`, a port `core/ports` had already
   * deleted, so this field was silently `any`). A page's bytes come from the entry
   * `design/pages.json` binds to its slug — `core/project`'s `readPageEntrySource` — never
   * from a path computed out of the slug.
   */
  readonly designReader: DesignTreeReader;
  readonly clock: Clock;
  readonly exportPublish: ExportPublishPort;
}

export interface PublishExportInputV1 {
  readonly snapshot: ExportSnapshotV1;
  /** The current, freshly-resolved page list/settings to revalidate against the captured snapshot (§12.5). */
  readonly currentPages: readonly ExportPageInputV1[];
  readonly renders: readonly PublishExportRenderOutcomeV1[];
  /** The assembled package's in-memory file list (`assembleExportPackage`'s output, WP-5 Task B3) — the source `buildExportPublishOperations` turns into the real plan. */
  readonly files: readonly ExportPackageFileV1[];
}

/** The durable publication fact this Kernel slice can record — `export/current.json`'s real write is a later slice's job (this module never touches disk). */
export interface ExportPublicationIntentV1 {
  readonly generationId: string;
  readonly pageCount: number;
  readonly recordedAt: string;
}

export type PublishExportResultV1 =
  | { readonly kind: "illegal"; readonly code: CommandRejectionCode }
  | { readonly kind: "failed"; readonly failure: FailureDtoV1 }
  | { readonly kind: "stale"; readonly failure: FailureDtoV1 }
  | { readonly kind: "published"; readonly intent: ExportPublicationIntentV1 };

function staleFailure(reason: string): FailureDtoV1 {
  return { code: "EXPORT_SNAPSHOT_STALE", retryable: true, safeMessage: reason, details: {} };
}

/** True when `current` matches the captured snapshot's identity/settings exactly, in order. */
function settingsStillMatch(
  snapshot: ExportSnapshotV1,
  currentPages: readonly ExportPageInputV1[],
): boolean {
  if (snapshot.pages.length !== currentPages.length) return false;
  for (let i = 0; i < snapshot.pages.length; i++) {
    const captured = snapshot.pages[i];
    const current = currentPages[i];
    if (captured === undefined || current === undefined) return false;
    if (captured.pageSlug !== current.pageSlug) return false;
    if (captured.manifestIndex !== current.manifestIndex) return false;
    if (captured.theme !== current.theme) return false;
    if (captured.kitApiVersion !== current.kitApiVersion) return false;
    if (captured.minSize.w !== current.minSize.w || captured.minSize.h !== current.minSize.h)
      return false;
    // A PAGE IS ITS CLOSURE, SO STALENESS IS A CLOSURE QUESTION (design-tree phase 3 Task 8).
    // The five fields above describe the page's SETTINGS; none of them moves when a shared
    // module is rewritten between capture and publish, so a drifted design used to publish
    // without a word. `null` on EITHER side is STALE, never a match — an uncomputable closure
    // hash means "cannot prove which bytes this page is made of", which is exactly the state a
    // publish may not proceed from (design-tree phase 2 decision 3, `ExportPageInputV1
    // .closureHash`'s own doc).
    if (captured.closureHash === null || current.closureHash === null) return false;
    if (captured.closureHash !== current.closureHash) return false;
  }
  return true;
}

export async function publishExport(
  deps: PublishExportDeps,
  input: PublishExportInputV1,
): Promise<PublishExportResultV1> {
  const failedRender = input.renders.find(
    (render): render is PublishExportRenderOutcomeV1 & { readonly outcome: FailureDtoV1 } =>
      "code" in render.outcome,
  );
  if (failedRender !== undefined) return { kind: "failed", failure: failedRender.outcome };

  const began = deps.machine.apply("kernel.export.beginPublication");
  if (began.kind === "illegal") return { kind: "illegal", code: began.code };

  const permit = await wrap(deps.projectWrite.acquire());

  if (!settingsStillMatch(input.snapshot, input.currentPages)) {
    deps.projectWrite.release(permit);
    deps.machine.apply("kernel.export.failBeforeIntent");
    return {
      kind: "stale",
      failure: staleFailure(
        "the page list or resolved settings changed since the snapshot was captured",
      ),
    };
  }

  // Read ONCE for the whole revalidation window — see `snapshot.ts`'s own note.
  const entries = await wrap(readPageOrder(deps.designReader));
  if ("code" in entries) {
    deps.projectWrite.release(permit);
    deps.machine.apply("kernel.export.failBeforeIntent");
    return { kind: "failed", failure: entries };
  }

  for (const page of input.snapshot.pages) {
    const source = await wrap(readPageEntrySource(deps.designReader, page.pageSlug, entries));
    if ("code" in source) {
      deps.projectWrite.release(permit);
      deps.machine.apply("kernel.export.failBeforeIntent");
      return { kind: "failed", failure: source };
    }
    if (source.sourceHash !== page.sourceHash) {
      deps.projectWrite.release(permit);
      deps.machine.apply("kernel.export.failBeforeIntent");
      return {
        kind: "stale",
        failure: staleFailure(
          `page "${page.pageSlug}" source changed since the snapshot was captured`,
        ),
      };
    }
  }

  const intent: ExportPublicationIntentV1 = {
    generationId: uuidv7(),
    pageCount: input.snapshot.pages.length,
    recordedAt: deps.clock.now().toISOString(),
  };

  // D-Q5: read the current pointer (still under the reacquired permit) so the plan can
  // both CAS `export/current.json`'s own oldImage correctly and clean up the old
  // generation's files. `null` means this project has never published before — a valid
  // "no previous generation to clean up" case, never a failure.
  const previousPointer = await wrap(deps.exportPublish.readPointer());
  if (previousPointer !== null && "code" in previousPointer) {
    deps.projectWrite.release(permit);
    deps.machine.apply("kernel.export.failBeforeIntent");
    return { kind: "failed", failure: previousPointer };
  }

  const { operations, payloads } = buildExportPublishOperations({
    files: input.files,
    generationId: intent.generationId,
    previousPointer,
  });

  const plan: ExportPublishPlanV1 = {
    generationId: intent.generationId,
    pageCount: intent.pageCount,
    createdAt: intent.recordedAt,
    operations,
    payloads,
  };

  const publication = await wrap(deps.exportPublish.publish(plan));

  deps.projectWrite.release(permit);

  if ("code" in publication) {
    deps.machine.apply("kernel.export.failBeforeIntent");
    if (publication.code === "EXPORT_SNAPSHOT_STALE")
      return { kind: "stale", failure: publication };
    return { kind: "failed", failure: publication };
  }

  const completed = deps.machine.apply("kernel.export.complete");
  if (completed.kind === "illegal") {
    // Defensive only: unreachable in practice — nothing between `beginPublication` and here
    // can move this machine — kept explicit per errore's rule against assuming success.
    return { kind: "illegal", code: completed.code };
  }

  return { kind: "published", intent };
}
