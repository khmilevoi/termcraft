import type { PageSlug } from "entities/page";

import type {
  GateRunResultV1,
  GateRunner,
  ManifestSliceResultV1,
  PageMetaExtractionV1,
} from "../gate-runner";
import type { AssertConforms } from "../index";

/**
 * In-memory {@link GateRunner} fake (6D task brief). `gate`'s own result types carry no
 * `FailureDtoV1` (they are plain data per the port's own doc) — so "programmable failure"
 * here means queuing the WHOLE scripted result (a failing `GateRunResultV1`/
 * `ManifestSliceResultV1` is just a result with a non-empty `errors` array), rather than a
 * separate failure channel layered on top.
 */

export type GateRunnerCall =
  | { readonly method: "runManifestSlice"; readonly presentSlugCount: number }
  | { readonly method: "runPage"; readonly slug: PageSlug; readonly sourcePath?: string }
  | { readonly method: "extractPageMeta"; readonly slug: PageSlug };

export interface FakeGateRunner extends GateRunner {
  readonly calls: readonly GateRunnerCall[];
  /** Queues the next `runPage()` result (FIFO), one shot. */
  queueRunPageResult(result: GateRunResultV1): void;
  /** Queues the next `runManifestSlice()` result (FIFO), one shot. */
  queueRunManifestSliceResult(result: ManifestSliceResultV1): void;
  /** Queues the next `extractPageMeta()` result (FIFO), one shot — a failing extraction is one with `meta: null` and a non-empty `errors`. */
  queueExtractPageMetaResult(result: PageMetaExtractionV1): void;
}

export function createFakeGateRunner(): FakeGateRunner {
  const calls: GateRunnerCall[] = [];
  const pageResults: GateRunResultV1[] = [];
  const manifestResults: ManifestSliceResultV1[] = [];
  const extractionResults: PageMetaExtractionV1[] = [];

  function queueRunPageResult(result: GateRunResultV1): void {
    pageResults.push(result);
  }

  function queueExtractPageMetaResult(result: PageMetaExtractionV1): void {
    extractionResults.push(result);
  }

  function queueRunManifestSliceResult(result: ManifestSliceResultV1): void {
    manifestResults.push(result);
  }

  async function runManifestSlice(input: {
    manifestText: string;
    presentSlugs: readonly PageSlug[];
  }): Promise<ManifestSliceResultV1> {
    calls.push({ method: "runManifestSlice", presentSlugCount: input.presentSlugs.length });
    const queued = manifestResults.shift();
    if (queued !== undefined) return queued;
    return { errors: [], slice: { pages: input.presentSlugs, active: null } };
  }

  async function runPage(input: {
    source: string;
    slug: PageSlug;
    fileName?: string;
    /** Widened alongside the port's own additive field (`core/ports/gate-runner.ts`) — this in-memory fake never touches disk, so `sourcePath` only reaches the call log below for test observability; it never affects the result returned. */
    sourcePath?: string;
  }): Promise<GateRunResultV1> {
    calls.push({
      method: "runPage",
      slug: input.slug,
      ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
    });
    const queued = pageResults.shift();
    if (queued !== undefined) return queued;
    return {
      ok: true,
      errors: [],
      warnings: [],
      descriptor: {
        slug: input.slug,
        meta: { kitApiVersion: 1, title: input.slug, minSize: { w: 80, h: 24 }, theme: "default" },
      },
    };
  }

  async function extractPageMeta(input: {
    source: string;
    slug: PageSlug;
  }): Promise<PageMetaExtractionV1> {
    calls.push({ method: "extractPageMeta", slug: input.slug });
    const queued = extractionResults.shift();
    if (queued !== undefined) return queued;
    return {
      meta: { kitApiVersion: 1, title: input.slug, minSize: { w: 80, h: 24 }, theme: "default" },
      errors: [],
    };
  }

  return {
    runManifestSlice,
    runPage,
    extractPageMeta,
    calls,
    queueRunPageResult,
    queueRunManifestSliceResult,
    queueExtractPageMetaResult,
  };
}

type _Conforms = AssertConforms<GateRunner, FakeGateRunner>;
