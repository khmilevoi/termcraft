import type { FailureDtoV1, PageRemovePlanV1, Sha256Hex } from "core/protocol";
import type { PageSlug } from "entities/page";

import type { PageMutations } from "../design-store";
import type { AssertConforms } from "../index";

/**
 * TEMPORARY COMPATIBILITY SHIM — plan Task 7's own debt, not a real port fake.
 *
 * `PageReader` (`readSource(pageSlug)`/`listSlugs()`) was retired from `core/ports` by this
 * task, replaced by `DesignTreeReader` (`readTreeFile(relPath)`/`listTree()`/
 * `readManifest()`) — `fakes/design-store.ts` is the REAL fake for that new port. But 16
 * production test files (`core/kernel/**`, `core/export/**`, `core/project/**` — none of
 * them in this task's own file list, none of them owned by any task in red-debt.md) import
 * `createFakePageStore` from this barrel to build an UNRELATED test harness (turn handling,
 * export publishing, chat handling, …) — the fake's OWN `PageReader` contract is usually not
 * what those 254 tests are even exercising. Measured directly (`git stash` + `bun test`
 * against the pre-Task-7 tree): those 16 files carry **254 passing tests, 0 failing** today.
 *
 * Retiring `createFakePageStore` outright — the honest, brief-literal reading of "delete
 * `page-store.ts`" — makes every one of those 16 files fail to LOAD AT ALL (Bun aborts an
 * entire test file on a missing named export), turning 254 green tests into an opaque
 * `SyntaxError` with zero individual test names, none of them about the design-tree rekey.
 * Correctly updating all 16 files to the new `DesignTreeReader`/`PagesManifestV1` shape needs
 * real per-test decisions (what tree, what pages, what content) this task's brief does not
 * make and this plan assigns to whichever task actually wires `core` onto `DesignTreeReader`
 * for real (kernel-assembly Task 13/14, or Task 9 — TBD by the controller; see the task-7
 * report's "adjacent files" section). Rather than either silently corrupt those 254 tests'
 * behavior (a blind rename to `createFakeDesignStore`'s incompatible `{manifest, files}`
 * constructor) or silently delete their coverage (do nothing), this file keeps the OLD
 * `PageReader`/`PageMutations`-shaped fake alive, UNCHANGED in behavior, under its OLD name —
 * every one of the 16 files' existing imports resolves exactly as before, zero edits needed
 * to any of them.
 *
 * DELETE THIS FILE (and its `fakes/index.ts` re-export) the moment the task that rewires
 * those 16 files onto `DesignTreeReader` for real lands — it must not survive past that
 * point, and no NEW caller should ever start importing from it.
 */

const NOT_FOUND = (pageSlug: PageSlug): FailureDtoV1 => ({
  code: "PERSISTENCE_FAILED",
  retryable: false,
  safeMessage: `no page source for pageSlug ${pageSlug}`,
  details: { pageSlug },
});

/** The retired `PageReader`'s own page-source shape (`core/ports/page-store.ts`, before this task deleted it) — kept locally, verbatim, for this shim only. */
export interface LegacyPageSourceV1 {
  readonly bytes: Uint8Array;
  readonly sourceHash: Sha256Hex;
}

/** The retired `PageReader` port shape (`core/ports/page-store.ts`, before this task deleted it) — kept locally, verbatim, for this shim only; never re-exported as a real port. */
export interface LegacyPageReader {
  readSource(pageSlug: PageSlug): Promise<FailureDtoV1 | LegacyPageSourceV1>;
  listSlugs(): Promise<FailureDtoV1 | readonly PageSlug[]>;
}

export type PageStoreFailableMethod =
  | "readSource"
  | "listSlugs"
  | "renameTitle"
  | "reorder"
  | "remove";

export type PageStoreCall =
  | { readonly method: "readSource"; readonly pageSlug: PageSlug }
  | { readonly method: "listSlugs" }
  | { readonly method: "renameTitle"; readonly pageSlug: PageSlug; readonly title: string }
  | { readonly method: "reorder"; readonly order: readonly PageSlug[] }
  | { readonly method: "remove"; readonly pageSlug: PageSlug };

export interface FakePageStore extends LegacyPageReader, PageMutations {
  readonly calls: readonly PageStoreCall[];
  failNext(method: PageStoreFailableMethod, failure: FailureDtoV1): void;
}

export function createFakePageStore(options: {
  readonly order: readonly PageSlug[];
  readonly sources?: ReadonlyMap<PageSlug, LegacyPageSourceV1>;
}): FakePageStore {
  let order = [...options.order];
  const sources = new Map(options.sources ?? []);
  const titles = new Map<PageSlug, string>();
  const calls: PageStoreCall[] = [];

  const queues: Record<PageStoreFailableMethod, FailureDtoV1[]> = {
    readSource: [],
    listSlugs: [],
    renameTitle: [],
    reorder: [],
    remove: [],
  };

  function failNext(method: PageStoreFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure);
  }

  async function readSource(pageSlug: PageSlug): Promise<FailureDtoV1 | LegacyPageSourceV1> {
    calls.push({ method: "readSource", pageSlug });
    const queued = queues.readSource.shift();
    if (queued !== undefined) return queued;
    const source = sources.get(pageSlug);
    if (source === undefined) return NOT_FOUND(pageSlug);
    return source;
  }

  async function listSlugs(): Promise<FailureDtoV1 | readonly PageSlug[]> {
    calls.push({ method: "listSlugs" });
    const queued = queues.listSlugs.shift();
    if (queued !== undefined) return queued;
    return [...order];
  }

  async function renameTitle(pageSlug: PageSlug, title: string): Promise<FailureDtoV1 | undefined> {
    calls.push({ method: "renameTitle", pageSlug, title });
    const queued = queues.renameTitle.shift();
    if (queued !== undefined) return queued;
    titles.set(pageSlug, title);
    return undefined;
  }

  async function reorder(newOrder: readonly PageSlug[]): Promise<FailureDtoV1 | undefined> {
    calls.push({ method: "reorder", order: newOrder });
    const queued = queues.reorder.shift();
    if (queued !== undefined) return queued;
    order = [...newOrder];
    return undefined;
  }

  async function remove(plan: PageRemovePlanV1): Promise<FailureDtoV1 | undefined> {
    calls.push({ method: "remove", pageSlug: plan.pageSlug as PageSlug });
    const queued = queues.remove.shift();
    if (queued !== undefined) return queued;
    order = order.filter((slug) => slug !== plan.pageSlug);
    sources.delete(plan.pageSlug as PageSlug);
    return undefined;
  }

  return { readSource, listSlugs, renameTitle, reorder, remove, calls, failNext };
}

type _MutationsConforms = AssertConforms<PageMutations, FakePageStore>;
