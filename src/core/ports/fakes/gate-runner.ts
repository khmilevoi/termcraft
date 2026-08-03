import type { ClosureV1, DesignFileEntryV1, PageEntryV1 } from "entities/design-tree";
import type { PageSlug } from "entities/page";

import type {
  GateRunResultV1,
  GateRunner,
  ManifestSliceResultV1,
  PageMetaExtractionV1,
  RunTreeResultV1,
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
      readonly treeRoot: string;
      readonly expectedFileCount: number;
      readonly entryRelPath: string;
    }
  | {
      readonly method: "runTree";
      readonly fileCount: number;
      readonly treePathCount: number;
      readonly pageCount: number;
    }
  | { readonly method: "extractPageMeta"; readonly slug: PageSlug; readonly entryRelPath: string };

export interface FakeGateRunner extends GateRunner {
  readonly calls: readonly GateRunnerCall[];
  /** Queues the next `runPage()` result (FIFO), one shot. */
  queueRunPageResult(result: GateRunResultV1): void;
  /** Queues the next `runManifestSlice()` result (FIFO), one shot. */
  queueRunManifestSliceResult(result: ManifestSliceResultV1): void;
  /** Queues the next `runTree()` result (FIFO), one shot. */
  queueRunTreeResult(result: RunTreeResultV1): void;
  /** Queues the next `extractPageMeta()` result (FIFO), one shot — a failing extraction is one with `meta: null` and a non-empty `errors`. */
  queueExtractPageMetaResult(result: PageMetaExtractionV1): void;
}

export function createFakeGateRunner(): FakeGateRunner {
  const calls: GateRunnerCall[] = [];
  const pageResults: GateRunResultV1[] = [];
  const manifestResults: ManifestSliceResultV1[] = [];
  const treeResults: RunTreeResultV1[] = [];
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

  function queueRunTreeResult(result: RunTreeResultV1): void {
    treeResults.push(result);
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
    /** Required alongside the port's own required fields (`core/ports/gate-runner.ts`) — this
     *  in-memory fake never touches disk, so the tree coordinates only reach the call log below
     *  for test observability; they never affect the result returned. */
    treeRoot: string;
    expectedFiles: readonly DesignFileEntryV1[];
    entryRelPath: string;
    closure?: ClosureV1;
  }): Promise<GateRunResultV1> {
    calls.push({
      method: "runPage",
      slug: input.slug,
      treeRoot: input.treeRoot,
      // The COUNT, not the list: a caller asserting on this log wants "the tree travelled",
      // not a copy of every hash, and a full inventory would make every such assertion a
      // fixture-hash transcription exercise.
      expectedFileCount: input.expectedFiles.length,
      entryRelPath: input.entryRelPath,
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

  async function runTree(input: {
    files: ReadonlyMap<string, string>;
    treePaths: readonly string[];
    pages: readonly PageEntryV1[];
  }): Promise<RunTreeResultV1> {
    calls.push({
      method: "runTree",
      fileCount: input.files.size,
      treePathCount: input.treePaths.length,
      pageCount: input.pages.length,
    });
    const queued = treeResults.shift();
    if (queued !== undefined) return queued;
    // Honest empty, not a fabricated closure walk or a fabricated type check: this in-memory
    // fake has neither an import scanner nor a compiler to derive an answer from (both live in
    // `gate`, which `core/ports` may not import) — a test that wants specific closures or
    // diagnostics scripts them via `queueRunTreeResult` instead of relying on a synthesized
    // default.
    //
    // TRAP FOR ANY CALLER OF THIS FAKE (task-13 review round 2, Minor M-d), NAMED LOUDLY: the
    // REAL adapter (`gate/adapters/gate-runner.ts`) returns one closure per `input.pages` entry
    // whose closure it can PROVE complete — corrected from round 2's "per RESOLVING entry",
    // which became inaccurate the moment an entry could resolve and still be omitted (a code
    // file with no source text, an edge form the walk does not follow: see the port's own
    // CONTRACT) — this fake never returns one, for ANY `pages` you pass it, unless you
    // `queueRunTreeResult(...)` first. A test built against this default sees
    // `closures: []` unconditionally, so `selectChangedPages(...)` against it always reports
    // "nothing changed for any page" — the EXACT silent-nothing-changed failure mode design §7
    // and this whole task exist to prevent, now reproduced by a fixture default instead of
    // production code. Anyone wiring `core/turns`/`core/kernel` against this fake (Task 14) and
    // asserting on `changedPageSlugs`/pin resolution MUST queue a real closure list — the
    // silent honest-empty default here will otherwise look identical to "no page changed" in
    // every test that forgets to.
    //
    // THE SECOND HALF OF THE SAME TRAP, since design-tree phase 2 Task 3 moved the TYPE CHECK
    // in here: `errors: []` means "this fake ran nothing", never "the tree type-checks". A
    // descriptor/turn test that wants to prove a type error reaches its subject must queue one.
    return { errors: [], warnings: [], closures: [] };
  }

  async function extractPageMeta(input: {
    source: string;
    slug: PageSlug;
    entryRelPath: string;
  }): Promise<PageMetaExtractionV1> {
    calls.push({ method: "extractPageMeta", slug: input.slug, entryRelPath: input.entryRelPath });
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
    runTree,
    extractPageMeta,
    calls,
    queueRunPageResult,
    queueRunManifestSliceResult,
    queueRunTreeResult,
    queueExtractPageMetaResult,
  };
}

type _Conforms = AssertConforms<GateRunner, FakeGateRunner>;
