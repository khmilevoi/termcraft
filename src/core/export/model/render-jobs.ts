import type {
  ExportRenderKeyV1,
  ExportRenderPort,
  ExportRenderResultV1,
  ExportRenderTaskV1,
  RenderCache,
} from "core/ports";
import type { FailureDtoV1 } from "core/protocol";
import type { PageSlug, Size } from "entities/page";

import type { ExportPageSnapshotV1, ExportSnapshotV1 } from "../types";
import { computeExportSizeLadder } from "./size-ladder";

/**
 * The "rendering" phase's own dispatch (kernel-command-contract §7.5, §11.4, §13.4). No
 * `ProjectWriteCoordinator` appears anywhere in this file's Deps — that omission IS the
 * §13.4 negative ("rendering assertions prove no permit/mutex is held"): rendering
 * structurally cannot touch the mutex because nothing here is wired to it, not merely
 * because it happens not to call it. `snapshot.ts` already released the permit before this
 * module ever sees a page.
 *
 * `rendererVersion` is projections-observability §5's render-cache key component,
 * "defined nowhere and must be introduced by this phase" (mvp-phase-6-core plan §5) — it is
 * an injected string here (a caller-chosen build/renderer identity), never invented as a
 * literal inside this file.
 *
 * ORDERING: §11.4 fixes the rule this file exists to prove: "results still assemble in
 * manifest/(w,h) order at the caller, never completion order." Every task is dispatched
 * concurrently via `Promise.all`, whose OWN contract is to resolve with results in the same
 * order as its input array regardless of which promise settles first — so the ordering
 * guarantee comes from `computeExportSizeLadder`'s sort plus `Promise.all`'s array-order
 * semantics, not from any manual bookkeeping that could drift.
 */

export interface ExportRenderJobDeps {
  readonly renderPort: ExportRenderPort;
  readonly renderCache: RenderCache;
  readonly rendererVersion: string;
}

export interface ExportRenderJobResultV1 {
  readonly manifestIndex: number;
  readonly pageSlug: PageSlug;
  readonly size: Size;
  readonly outcome: FailureDtoV1 | ExportRenderResultV1;
  readonly cacheHit: boolean;
}

/** The §10.2 render-cache key for one (page, size) render. */
export function buildExportRenderKey(
  page: ExportPageSnapshotV1,
  size: Size,
  rendererVersion: string,
): ExportRenderKeyV1 {
  return {
    sourceHash: page.sourceHash,
    kitApiVersion: page.kitApiVersion,
    rendererVersion,
    size: { width: size.w, height: size.h },
    theme: page.theme,
    // No flag dimension is defined for export rendering in this MVP slice; the key shape
    // reserves the field so a future flag (e.g. a deterministic-render toggle) does not
    // require a key-shape migration.
    flags: {},
  };
}

function buildExportRenderTask(page: ExportPageSnapshotV1, size: Size): ExportRenderTaskV1 {
  return {
    pageSlug: page.pageSlug,
    sourcePath: page.sourcePath,
    sourceHash: page.sourceHash,
    kitApiVersion: page.kitApiVersion,
    size,
    theme: page.theme,
    manifestIndex: page.manifestIndex,
  };
}

async function renderJob(
  deps: ExportRenderJobDeps,
  page: ExportPageSnapshotV1,
  size: Size,
): Promise<ExportRenderJobResultV1> {
  const key = buildExportRenderKey(page, size, deps.rendererVersion);

  const cached = await deps.renderCache.get(key);
  if (cached !== null && "code" in cached) {
    // A cache I/O fault is never fatal to a render — it degrades to a miss, logged so the
    // fault stays visible per errore's rule against silently swallowing it.
    console.warn(
      `render-jobs: render cache read failed for page "${page.pageSlug}" — treating as a miss: ${cached.safeMessage}`,
    );
  } else if (cached !== null) {
    return {
      manifestIndex: page.manifestIndex,
      pageSlug: page.pageSlug,
      size,
      outcome: {
        manifestIndex: page.manifestIndex,
        styledFrame: cached.styledFrame,
        textFrame: cached.textFrame,
        layout: cached.layout,
      },
      cacheHit: true,
    };
  }

  const task = buildExportRenderTask(page, size);
  const rendered = await deps.renderPort.renderOne(task);
  if ("code" in rendered) {
    return {
      manifestIndex: page.manifestIndex,
      pageSlug: page.pageSlug,
      size,
      outcome: rendered,
      cacheHit: false,
    };
  }

  const putFailure = await deps.renderCache.put({
    key,
    styledFrame: rendered.styledFrame,
    textFrame: rendered.textFrame,
    layout: rendered.layout,
  });
  if (putFailure !== undefined) {
    console.warn(
      `render-jobs: failed to populate the render cache for page "${page.pageSlug}": ${putFailure.safeMessage}`,
    );
  }

  return {
    manifestIndex: page.manifestIndex,
    pageSlug: page.pageSlug,
    size,
    outcome: rendered,
    cacheHit: false,
  };
}

/** Dispatches every (page, ladder size) render for `snapshot`, ordered by (manifestIndex, w, h) — never completion order. */
export async function runExportRendering(
  deps: ExportRenderJobDeps,
  snapshot: ExportSnapshotV1,
): Promise<readonly ExportRenderJobResultV1[]> {
  const byPageSlug = new Map(snapshot.pages.map((page) => [page.pageSlug, page]));
  const ladder = computeExportSizeLadder(snapshot.pages);

  const jobs = ladder.map((entry) => {
    const page = byPageSlug.get(entry.pageSlug);
    if (page === undefined) {
      // Unreachable: the ladder is derived FROM `snapshot.pages`, so every entry's
      // `pageSlug` is present in this map by construction. Kept explicit rather than a
      // non-null assertion, per errore's rule against silently trusting an invariant.
      console.warn(`render-jobs: ladder entry for unknown page "${entry.pageSlug}" — skipped`);
      return null;
    }
    return renderJob(deps, page, entry.size);
  });

  const dispatched = jobs.filter((job): job is Promise<ExportRenderJobResultV1> => job !== null);
  return Promise.all(dispatched);
}
