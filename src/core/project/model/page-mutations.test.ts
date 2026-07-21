import { describe, expect, test } from "bun:test"
import { context, wrap } from "@reatom/core"

import type { FailureDtoV1 } from "core/protocol"
import { parsePageSlug, type PageSlug } from "entities/page"
import { createFakePageStore, createFakeProjectStore, createFakeProjectWriteCoordinator } from "core/ports/fakes"

import { createPageRemovePlanLedger, type PageRemovePlanLedger } from "./page-remove-plan"
import { confirmPageRemove, discardPageRemovePlan, renameTitle, reorder } from "./page-mutations"

/**
 * TESTING NOTE: `PageRemovePlanLedger` is backed by real Reatom atoms, and `context.start(cb)`
 * pops its isolated frame the instant `cb()` returns — immediately, even for an `async cb`,
 * as soon as it hits its first internal `await` (matching `core/mailbox/model/dispatch.test.ts`'s
 * own documented note: "A direct read is unreliable across this test file's `context.start(...)`
 * boundary"). So every test below (1) calls the function under test SYNCHRONOUSLY inside
 * `context.start(() => {...})` (capturing its returned promise, never awaiting INSIDE the
 * callback) so the function's own internal `wrap(...)` calls capture the right frame, and
 * (2) reads `planLedger.current()` only through a `wrap(() => planLedger.current())` reader
 * built in that SAME synchronous window, never a bare post-await `planLedger.current()` call.
 * Every OTHER fake in this ring (`pageStore`, `projectStore`, `mutex`) is plain JS state, not
 * a Reatom atom, so their `.calls` logs and awaited methods are safe to read from anywhere.
 */

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value)
  if (parsed instanceof Error) throw parsed
  return parsed
}

function readerFor(planLedger: PageRemovePlanLedger) {
  return wrap(() => planLedger.current())
}

const FAILURE: FailureDtoV1 = { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: "disk unavailable", details: {} }

describe("renameTitle", () => {
  test("rewrites the title through the page store and invalidates any active remove plan", async () => {
    const { call, readCurrent, pageStore } = context.start(() => {
      const pageStore = createFakePageStore({
        order: [slug("home")],
        sources: new Map([[slug("home"), { bytes: new Uint8Array(), sourceHash: "a".repeat(64) }]]),
      })
      const planLedger = createPageRemovePlanLedger()
      planLedger.mint({ pageSlug: slug("home"), sourceHash: "a".repeat(64), orderedPageSlugs: [slug("home")], activePageSlug: slug("home") })
      return { call: renameTitle({ pageStore, planLedger }, slug("home"), "New title"), readCurrent: readerFor(planLedger), pageStore }
    })

    const result = await call

    expect(result).toBeUndefined()
    expect(pageStore.calls).toEqual([{ method: "renameTitle", pageSlug: slug("home"), title: "New title" }])
    expect(readCurrent()).toBeNull()
  })

  test("propagates a page-store failure and leaves an active plan untouched", async () => {
    const { call, readCurrent } = context.start(() => {
      const pageStore = createFakePageStore({ order: [slug("home")] })
      pageStore.failNext("renameTitle", FAILURE)
      const planLedger = createPageRemovePlanLedger()
      planLedger.mint({ pageSlug: slug("home"), sourceHash: "a".repeat(64), orderedPageSlugs: [slug("home")], activePageSlug: slug("home") })
      return { call: renameTitle({ pageStore, planLedger }, slug("home"), "New title"), readCurrent: readerFor(planLedger) }
    })

    const result = await call

    expect(result).toEqual(FAILURE)
    expect(readCurrent()).not.toBeNull()
  })
})

describe("reorder", () => {
  test("replaces the page order and invalidates any active remove plan", async () => {
    const { call, readCurrent, pageStore } = context.start(() => {
      const pageStore = createFakePageStore({ order: [slug("home"), slug("about")] })
      const planLedger = createPageRemovePlanLedger()
      planLedger.mint({
        pageSlug: slug("home"),
        sourceHash: "a".repeat(64),
        orderedPageSlugs: [slug("home"), slug("about")],
        activePageSlug: slug("home"),
      })
      return { call: reorder({ pageStore, planLedger }, [slug("about"), slug("home")]), readCurrent: readerFor(planLedger), pageStore }
    })

    const result = await call

    expect(result).toEqual({ kind: "reordered" })
    expect(pageStore.calls.some((c) => c.method === "reorder")).toBe(true)
    const listed = await pageStore.listSlugs()
    expect(listed).toEqual([slug("about"), slug("home")])
    expect(readCurrent()).toBeNull()
  })

  test("rejects a permutation that adds a slug, without writing", async () => {
    const { call, pageStore } = context.start(() => {
      const pageStore = createFakePageStore({ order: [slug("home")] })
      const planLedger = createPageRemovePlanLedger()
      return { call: reorder({ pageStore, planLedger }, [slug("home"), slug("about")]), pageStore }
    })

    const result = await call

    expect(result).toEqual({ kind: "invalid-permutation" })
    expect(pageStore.calls.some((c) => c.method === "reorder")).toBe(false)
  })

  test("rejects a permutation that drops a slug, without writing", async () => {
    const { call, pageStore } = context.start(() => {
      const pageStore = createFakePageStore({ order: [slug("home"), slug("about")] })
      const planLedger = createPageRemovePlanLedger()
      return { call: reorder({ pageStore, planLedger }, [slug("home")]), pageStore }
    })

    const result = await call

    expect(result).toEqual({ kind: "invalid-permutation" })
    expect(pageStore.calls.some((c) => c.method === "reorder")).toBe(false)
  })

  test("rejects a permutation with a duplicate slug, without writing", async () => {
    const { call, pageStore } = context.start(() => {
      const pageStore = createFakePageStore({ order: [slug("home"), slug("about")] })
      const planLedger = createPageRemovePlanLedger()
      return { call: reorder({ pageStore, planLedger }, [slug("home"), slug("home")]), pageStore }
    })

    const result = await call

    expect(result).toEqual({ kind: "invalid-permutation" })
    expect(pageStore.calls.some((c) => c.method === "reorder")).toBe(false)
  })
})

describe("discardPageRemovePlan", () => {
  test("discards the matching plan and performs no project write", () => {
    context.start(() => {
      const planLedger = createPageRemovePlanLedger()
      const plan = planLedger.mint({
        pageSlug: slug("home"),
        sourceHash: "a".repeat(64),
        orderedPageSlugs: [slug("home")],
        activePageSlug: slug("home"),
      })
      if (plan instanceof Error) throw plan

      const result = discardPageRemovePlan({ planLedger }, plan.pageRemovePlanId)

      expect(result).toEqual({ kind: "discarded" })
      expect(planLedger.current()).toBeNull()
    })
  })

  test("reports not-found for a non-matching plan id", () => {
    context.start(() => {
      const planLedger = createPageRemovePlanLedger()
      const result = discardPageRemovePlan({ planLedger }, "0192f6f0-0000-7000-8000-000000000099")
      expect(result).toEqual({ kind: "not-found" })
    })
  })
})

function setupConfirmScenario() {
  const pageStore = createFakePageStore({
    order: [slug("home"), slug("about")],
    sources: new Map([
      [slug("home"), { bytes: new Uint8Array(), sourceHash: "a".repeat(64) }],
      [slug("about"), { bytes: new Uint8Array(), sourceHash: "b".repeat(64) }],
    ]),
  })
  const projectStore = createFakeProjectStore({ root: "C:/proj", workspaceState: { activePageSlug: slug("about") } })
  const mutex = createFakeProjectWriteCoordinator()
  const planLedger = createPageRemovePlanLedger()
  const plan = planLedger.mint({
    pageSlug: slug("about"),
    sourceHash: "b".repeat(64),
    orderedPageSlugs: [slug("home"), slug("about")],
    activePageSlug: slug("about"),
  })
  if (plan instanceof Error) throw plan
  return { pageStore, projectStore, mutex, planLedger, plan }
}

describe("confirmPageRemove", () => {
  test("acquires the mutex BEFORE revalidating, then removes the page and releases the mutex", async () => {
    const { call, readCurrent, pageStore, mutex, order } = context.start(() => {
      const { pageStore, projectStore, mutex, planLedger, plan } = setupConfirmScenario()
      const order: string[] = []
      const tracedProjectStore = {
        ...projectStore,
        readWorkspaceState: async () => {
          order.push("readWorkspaceState")
          return projectStore.readWorkspaceState()
        },
      }
      const tracedPageStore = {
        ...pageStore,
        readSource: async (pageSlug: PageSlug) => {
          order.push("readSource")
          return pageStore.readSource(pageSlug)
        },
        listSlugs: async () => {
          order.push("listSlugs")
          return pageStore.listSlugs()
        },
      }
      const tracedMutex = {
        ...mutex,
        acquire: async () => {
          order.push("acquire")
          return mutex.acquire()
        },
      }

      const call = confirmPageRemove(
        { pageStore: tracedPageStore, projectStore: tracedProjectStore, planLedger, mutex: tracedMutex },
        plan.pageRemovePlanId,
      )
      return { call, readCurrent: readerFor(planLedger), pageStore, mutex, order }
    })

    const result = await call

    expect(result).toEqual({ kind: "removed", pageSlug: slug("about") })
    expect(order[0]).toBe("acquire")
    expect(order.slice(1)).toEqual(expect.arrayContaining(["readSource", "listSlugs", "readWorkspaceState"]))
    expect(readCurrent()).toBeNull()
    const listed = await pageStore.listSlugs()
    expect(listed).toEqual([slug("home")])
    expect(mutex.calls.some((c) => c.method === "release")).toBe(true)
  })

  test("reports not-found and releases the mutex when the plan id does not match", async () => {
    const { call, pageStore, mutex } = context.start(() => {
      const { pageStore, projectStore, mutex, planLedger } = setupConfirmScenario()
      const call = confirmPageRemove(
        { pageStore, projectStore, planLedger, mutex },
        "0192f6f0-0000-7000-8000-000000000099",
      )
      return { call, pageStore, mutex }
    })

    const result = await call

    expect(result).toEqual({ kind: "not-found" })
    expect(pageStore.calls.some((c) => c.method === "remove")).toBe(false)
    expect(mutex.calls.some((c) => c.method === "release")).toBe(true)
  })

  test("returns PLAN_STALE-shaped drift and performs NO write when the source hash changed", async () => {
    const { call, mutex, mutated } = context.start(() => {
      const { projectStore, mutex, planLedger, plan } = setupConfirmScenario()
      // Simulate a concurrent write to the plan's target page, bypassing this module, by
      // reading the fresh facts from a store seeded with different source bytes for "about".
      const mutated = createFakePageStore({
        order: [slug("home"), slug("about")],
        sources: new Map([
          [slug("home"), { bytes: new Uint8Array(), sourceHash: "a".repeat(64) }],
          [slug("about"), { bytes: new Uint8Array(), sourceHash: "c".repeat(64) }],
        ]),
      })
      const call = confirmPageRemove({ pageStore: mutated, projectStore, planLedger, mutex }, plan.pageRemovePlanId)
      return { call, mutex, mutated }
    })

    const result = await call

    expect(result).toEqual({ kind: "stale", driftedFields: ["sourceHash"] })
    expect(mutated.calls.some((c) => c.method === "remove")).toBe(false)
    expect(mutex.calls.some((c) => c.method === "release")).toBe(true)
  })

  test("returns PLAN_STALE and performs NO write when the page order changed", async () => {
    const { call, pageStore, mutex } = context.start(() => {
      const { pageStore, projectStore, mutex, planLedger, plan } = setupConfirmScenario()
      const call = wrap(pageStore.reorder([slug("about"), slug("home")])).then(() =>
        confirmPageRemove({ pageStore, projectStore, planLedger, mutex }, plan.pageRemovePlanId),
      )
      return { call, pageStore, mutex }
    })

    const result = await call

    expect(result.kind).toBe("stale")
    if (result.kind === "stale") {
      expect(result.driftedFields).toContain("orderedPageSlugs")
    }
    expect(pageStore.calls.some((c) => c.method === "remove")).toBe(false)
    expect(mutex.calls.some((c) => c.method === "release")).toBe(true)
  })

  test("returns PLAN_STALE and performs NO write when the active page changed", async () => {
    const { call, pageStore, mutex } = context.start(() => {
      const { pageStore, projectStore, mutex, planLedger, plan } = setupConfirmScenario()
      const call = wrap(projectStore.writeWorkspaceState({ activePageSlug: slug("home") })).then(() =>
        confirmPageRemove({ pageStore, projectStore, planLedger, mutex }, plan.pageRemovePlanId),
      )
      return { call, pageStore, mutex }
    })

    const result = await call

    expect(result.kind).toBe("stale")
    if (result.kind === "stale") {
      expect(result.driftedFields).toContain("activePageSlug")
    }
    expect(pageStore.calls.some((c) => c.method === "remove")).toBe(false)
    expect(mutex.calls.some((c) => c.method === "release")).toBe(true)
  })

  test("propagates a page-store read failure while gathering fresh facts, without writing", async () => {
    const { call, pageStore, mutex } = context.start(() => {
      const { pageStore, projectStore, mutex, planLedger, plan } = setupConfirmScenario()
      pageStore.failNext("readSource", FAILURE)
      const call = confirmPageRemove({ pageStore, projectStore, planLedger, mutex }, plan.pageRemovePlanId)
      return { call, pageStore, mutex }
    })

    const result = await call

    expect(result).toEqual({ kind: "failure", failure: FAILURE })
    expect(pageStore.calls.some((c) => c.method === "remove")).toBe(false)
    expect(mutex.calls.some((c) => c.method === "release")).toBe(true)
  })

  test("propagates a page-store remove failure and still releases the mutex", async () => {
    const { call, mutex, readCurrent } = context.start(() => {
      const { pageStore, projectStore, mutex, planLedger, plan } = setupConfirmScenario()
      pageStore.failNext("remove", FAILURE)
      const call = confirmPageRemove({ pageStore, projectStore, planLedger, mutex }, plan.pageRemovePlanId)
      return { call, mutex, readCurrent: readerFor(planLedger) }
    })

    const result = await call

    expect(result).toEqual({ kind: "failure", failure: FAILURE })
    expect(mutex.calls.some((c) => c.method === "release")).toBe(true)
    // A failed remove must not silently discard the plan — it may still be valid to retry.
    expect(readCurrent()).not.toBeNull()
  })

  test("a plan invalidated mid-flight is stale and the page is NOT removed", async () => {
    // §7.1 lists "project recovery, or trust change" among the invalidation triggers.
    // Neither touches any of the five observable facts, and neither holds the project-write
    // mutex — so an invalidation can land between this confirm's ledger read and its write.
    // §12.6 names plan revision among the compared facts precisely to close that window;
    // comparing the plan's revision against itself (its only other available source) makes
    // that comparison `x !== x` and can never fire.
    const { result, pageStore } = await context.start(async () => {
      const { pageStore, projectStore, mutex, planLedger, plan } = setupConfirmScenario()

      // Invalidate exactly once, during the first revalidation read — i.e. after the
      // ledger has been read and before the write would happen.
      let invalidated = false
      const tracedPageStore = {
        ...pageStore,
        listSlugs: async () => {
          if (!invalidated) {
            invalidated = true
            planLedger.invalidate() // what recovery / a trust change does
          }
          return pageStore.listSlugs()
        },
      }

      const result = await confirmPageRemove(
        { pageStore: tracedPageStore, projectStore, mutex, planLedger },
        plan.pageRemovePlanId,
      )
      return { result, pageStore }
    })

    expect(result.kind).toBe("stale")
    expect(pageStore.calls.some((c) => c.method === "remove")).toBe(false)
  })
})
