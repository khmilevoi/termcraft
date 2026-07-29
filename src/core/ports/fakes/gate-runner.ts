import type { ClosureV1 } from "entities/design-tree";
import type { PageSlug } from "entities/page";

import type {
  GateErrorV1,
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
  | { readonly method: "runManifestSlice"; readonly treePathCount: number }
  | {
      readonly method: "runPage";
      readonly slug: PageSlug;
      readonly sourcePath?: string;
      readonly entryRelPath?: string;
    }
  | {
      readonly method: "runTreeImports";
      readonly fileCount: number;
      readonly treePathCount: number;
    }
  | { readonly method: "extractPageMeta"; readonly slug: PageSlug };

export interface FakeGateRunner extends GateRunner {
  readonly calls: readonly GateRunnerCall[];
  /** Queues the next `runPage()` result (FIFO), one shot. */
  queueRunPageResult(result: GateRunResultV1): void;
  /** Queues the next `runManifestSlice()` result (FIFO), one shot. */
  queueRunManifestSliceResult(result: ManifestSliceResultV1): void;
  /** Queues the next `runTreeImports()` result (FIFO), one shot. */
  queueRunTreeImportsResult(result: readonly GateErrorV1[]): void;
  /** Queues the next `extractPageMeta()` result (FIFO), one shot — a failing extraction is one with `meta: null` and a non-empty `errors`. */
  queueExtractPageMetaResult(result: PageMetaExtractionV1): void;
}

export function createFakeGateRunner(): FakeGateRunner {
  const calls: GateRunnerCall[] = [];
  const pageResults: GateRunResultV1[] = [];
  const manifestResults: ManifestSliceResultV1[] = [];
  const treeImportsResults: (readonly GateErrorV1[])[] = [];
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

  function queueRunTreeImportsResult(result: readonly GateErrorV1[]): void {
    treeImportsResults.push(result);
  }

  async function runManifestSlice(input: {
    manifestText: string;
    treePaths: readonly string[];
  }): Promise<ManifestSliceResultV1> {
    calls.push({ method: "runManifestSlice", treePathCount: input.treePaths.length });
    const queued = manifestResults.shift();
    if (queued !== undefined) return queued;
    // Honest empty, not an echo: `treePaths` is a flat file-path inventory, not `PageEntryV1[]`
    // (design §4's `{slug, entry}` pairs) — this fake has no honest way to synthesize page
    // identities out of bare paths, so a caller that wants a specific slice scripts it via
    // `queueRunManifestSliceResult` instead of relying on a fabricated default.
    return { errors: [], slice: { pages: [], active: null } };
  }

  async function runPage(input: {
    source: string;
    slug: PageSlug;
    fileName?: string;
    /** Widened alongside the port's own additive field (`core/ports/gate-runner.ts`) — this in-memory fake never touches disk, so `sourcePath` only reaches the call log below for test observability; it never affects the result returned. */
    sourcePath?: string;
    entryRelPath?: string;
    closure?: ClosureV1;
  }): Promise<GateRunResultV1> {
    calls.push({
      method: "runPage",
      slug: input.slug,
      ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
      ...(input.entryRelPath === undefined ? {} : { entryRelPath: input.entryRelPath }),
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

  async function runTreeImports(input: {
    files: ReadonlyMap<string, string>;
    treePaths: readonly string[];
  }): Promise<readonly GateErrorV1[]> {
    calls.push({
      method: "runTreeImports",
      fileCount: input.files.size,
      treePathCount: input.treePaths.length,
    });
    const queued = treeImportsResults.shift();
    if (queued !== undefined) return queued;
    return [];
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
    runTreeImports,
    extractPageMeta,
    calls,
    queueRunPageResult,
    queueRunManifestSliceResult,
    queueRunTreeImportsResult,
    queueExtractPageMetaResult,
  };
}

type _Conforms = AssertConforms<GateRunner, FakeGateRunner>;
