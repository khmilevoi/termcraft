import type { FailureDtoV1, PageRemovePlanV1 } from "core/protocol"
import type { PageSlug } from "entities/page"
import type { AssertConforms } from "../index"
import type { PageMutations, PageReader, PageSourceV1 } from "../page-store"

/**
 * In-memory {@link PageReader}/{@link PageMutations} fake (6D task brief). `order` is the
 * manifest's own ordering authority (storage-identity §5.1) — the single array both
 * `listSlugs()` reads and `reorder()`/`remove()` mutate; `sources` is a separate map so a
 * test can seed page bytes independently of manifest order (a page can be tracked in the
 * manifest before its source is staged, matching real turn workflows).
 */

const NOT_FOUND = (pageSlug: PageSlug): FailureDtoV1 => ({
  code: "PERSISTENCE_FAILED",
  retryable: false,
  safeMessage: `no page source for pageSlug ${pageSlug}`,
  details: { pageSlug },
})

export type PageStoreFailableMethod = "readSource" | "listSlugs" | "renameTitle" | "reorder" | "remove"

export type PageStoreCall =
  | { readonly method: "readSource"; readonly pageSlug: PageSlug }
  | { readonly method: "listSlugs" }
  | { readonly method: "renameTitle"; readonly pageSlug: PageSlug; readonly title: string }
  | { readonly method: "reorder"; readonly order: readonly PageSlug[] }
  | { readonly method: "remove"; readonly pageSlug: PageSlug }

export interface FakePageStore extends PageReader, PageMutations {
  readonly calls: readonly PageStoreCall[]
  failNext(method: PageStoreFailableMethod, failure: FailureDtoV1): void
}

export function createFakePageStore(options: {
  readonly order: readonly PageSlug[]
  readonly sources?: ReadonlyMap<PageSlug, PageSourceV1>
}): FakePageStore {
  let order = [...options.order]
  const sources = new Map(options.sources ?? [])
  const titles = new Map<PageSlug, string>()
  const calls: PageStoreCall[] = []

  const queues: Record<PageStoreFailableMethod, FailureDtoV1[]> = {
    readSource: [],
    listSlugs: [],
    renameTitle: [],
    reorder: [],
    remove: [],
  }

  function failNext(method: PageStoreFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure)
  }

  async function readSource(pageSlug: PageSlug): Promise<FailureDtoV1 | PageSourceV1> {
    calls.push({ method: "readSource", pageSlug })
    const queued = queues.readSource.shift()
    if (queued !== undefined) return queued
    const source = sources.get(pageSlug)
    if (source === undefined) return NOT_FOUND(pageSlug)
    return source
  }

  async function listSlugs(): Promise<FailureDtoV1 | readonly PageSlug[]> {
    calls.push({ method: "listSlugs" })
    const queued = queues.listSlugs.shift()
    if (queued !== undefined) return queued
    return [...order]
  }

  async function renameTitle(pageSlug: PageSlug, title: string): Promise<FailureDtoV1 | undefined> {
    calls.push({ method: "renameTitle", pageSlug, title })
    const queued = queues.renameTitle.shift()
    if (queued !== undefined) return queued
    titles.set(pageSlug, title)
    return undefined
  }

  async function reorder(newOrder: readonly PageSlug[]): Promise<FailureDtoV1 | undefined> {
    calls.push({ method: "reorder", order: newOrder })
    const queued = queues.reorder.shift()
    if (queued !== undefined) return queued
    order = [...newOrder]
    return undefined
  }

  async function remove(plan: PageRemovePlanV1): Promise<FailureDtoV1 | undefined> {
    calls.push({ method: "remove", pageSlug: plan.pageSlug as PageSlug })
    const queued = queues.remove.shift()
    if (queued !== undefined) return queued
    order = order.filter((slug) => slug !== plan.pageSlug)
    sources.delete(plan.pageSlug as PageSlug)
    return undefined
  }

  return { readSource, listSlugs, renameTitle, reorder, remove, calls, failNext }
}

type _ReaderConforms = AssertConforms<PageReader, FakePageStore>
type _MutationsConforms = AssertConforms<PageMutations, FakePageStore>
