import { describe, expect, test } from "bun:test"
import { context } from "@reatom/core"

import { isUuidv7, type PageRemovePlanV1, type Sha256Hex } from "core/protocol"
import { parsePageSlug, type PageSlug } from "entities/page"

import {
  PageRemovePlanMintError,
  buildPageRemovePlan,
  computeFallbackPageSlug,
  computePageOrderHash,
  createPageRemovePlanLedger,
  detectPageRemovePlanDrift,
  type FreshPageRemoveFactsV1,
} from "./page-remove-plan"

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value)
  if (parsed instanceof Error) throw parsed
  return parsed
}

const HASH_A = "a".repeat(64) as Sha256Hex
const HASH_B = "b".repeat(64) as Sha256Hex
const HASH_C = "c".repeat(64) as Sha256Hex

describe("computePageOrderHash", () => {
  test("is deterministic for the same order", () => {
    const order = [slug("home"), slug("about")]
    const first = computePageOrderHash(order)
    const second = computePageOrderHash([...order])
    expect(first).not.toBeInstanceOf(Error)
    expect(first).toEqual(second)
  })

  test("differs when the order differs — array order is meaning, not incidental", () => {
    const forward = computePageOrderHash([slug("home"), slug("about")])
    const backward = computePageOrderHash([slug("about"), slug("home")])
    expect(forward).not.toEqual(backward)
  })
})

describe("computeFallbackPageSlug", () => {
  const order = [slug("home"), slug("about"), slug("contact")]

  test("is null when the removed page is not the active page", () => {
    expect(computeFallbackPageSlug(order, slug("about"), slug("home"))).toBeNull()
  })

  test("picks the next page when a middle active page is removed", () => {
    expect(computeFallbackPageSlug(order, slug("about"), slug("about"))).toBe(slug("contact"))
  })

  test("picks the previous page when the LAST active page is removed", () => {
    expect(computeFallbackPageSlug(order, slug("contact"), slug("contact"))).toBe(slug("about"))
  })

  test("is null when removing the only page", () => {
    expect(computeFallbackPageSlug([slug("home")], slug("home"), slug("home"))).toBeNull()
  })
})

describe("buildPageRemovePlan", () => {
  const input = {
    pageSlug: slug("about"),
    sourceHash: HASH_A,
    orderedPageSlugs: [slug("home"), slug("about"), slug("contact")],
    activePageSlug: slug("about"),
  }

  test("mints a plan with a fresh UUIDv7 id and the given revision", () => {
    const plan = buildPageRemovePlan(input, "1")
    if (plan instanceof Error) throw plan
    expect(isUuidv7(plan.pageRemovePlanId)).toBe(true)
    expect(plan.planRevision).toBe("1")
    expect(plan.pageSlug).toBe(slug("about"))
    expect(plan.sourceHash).toBe(HASH_A)
    expect(plan.orderedPageSlugs).toEqual(input.orderedPageSlugs)
  })

  test("computes pageOrderHash and fallbackPageSlug from the same rules as the standalone helpers", () => {
    const plan = buildPageRemovePlan(input, "1")
    if (plan instanceof Error) throw plan
    const expectedHash = computePageOrderHash(input.orderedPageSlugs)
    if (expectedHash instanceof Error) throw expectedHash
    expect(plan.pageOrderHash).toEqual(expectedHash)
    expect(plan.fallbackPageSlug).toBe(
      computeFallbackPageSlug(input.orderedPageSlugs, input.pageSlug, input.activePageSlug),
    )
  })

  test("rejects a pageSlug that is not listed in orderedPageSlugs", () => {
    const result = buildPageRemovePlan(
      { ...input, pageSlug: slug("missing"), orderedPageSlugs: [slug("home")] },
      "1",
    )
    expect(result).toBeInstanceOf(PageRemovePlanMintError)
  })
})

function samplePlan(overrides?: Partial<PageRemovePlanV1>): PageRemovePlanV1 {
  const orderedPageSlugs = [slug("home"), slug("about")]
  return {
    pageRemovePlanId: "0192f6f0-0000-7000-8000-000000000001",
    pageSlug: slug("about"),
    sourceHash: HASH_A,
    orderedPageSlugs,
    pageOrderHash: computePageOrderHash(orderedPageSlugs) as Sha256Hex,
    activePageSlug: slug("about"),
    fallbackPageSlug: slug("home"),
    planRevision: "1",
    ...overrides,
  }
}

function matchingFreshFacts(plan: PageRemovePlanV1): FreshPageRemoveFactsV1 {
  return {
    sourceHash: plan.sourceHash,
    orderedPageSlugs: plan.orderedPageSlugs as readonly PageSlug[],
    activePageSlug: plan.activePageSlug as PageSlug | null,
    planRevision: plan.planRevision,
  }
}

describe("detectPageRemovePlanDrift", () => {
  test("reports no drift when every fresh fact still matches the plan", () => {
    const plan = samplePlan()
    const drift = detectPageRemovePlanDrift(plan, matchingFreshFacts(plan))
    expect(drift).toEqual([])
  })

  test("field 1/6 — sourceHash drift is reported independently", () => {
    const plan = samplePlan()
    const fresh = { ...matchingFreshFacts(plan), sourceHash: HASH_B }
    expect(detectPageRemovePlanDrift(plan, fresh)).toEqual(["sourceHash"])
  })

  test("field 2/6 — orderedPageSlugs drift is reported independently", () => {
    const plan = samplePlan()
    const fresh = { ...matchingFreshFacts(plan), orderedPageSlugs: [slug("about"), slug("home")] }
    const drift = detectPageRemovePlanDrift(plan, fresh)
    expect(drift).toContain("orderedPageSlugs")
  })

  test("field 3/6 — pageOrderHash drift is reported independently of the raw list", () => {
    // The stored plan carries a pageOrderHash that does not match its OWN orderedPageSlugs
    // (a corrupted/forged plan) while the fresh order is unchanged — isolates the hash
    // comparison from the list comparison, which a real drift always changes together.
    const plan = samplePlan({ pageOrderHash: HASH_C })
    const fresh = matchingFreshFacts(plan)
    expect(detectPageRemovePlanDrift(plan, fresh)).toEqual(["pageOrderHash"])
  })

  test("field 4/6 — activePageSlug drift is reported independently", () => {
    const plan = samplePlan()
    const fresh = { ...matchingFreshFacts(plan), activePageSlug: slug("home") }
    const drift = detectPageRemovePlanDrift(plan, fresh)
    expect(drift).toContain("activePageSlug")
  })

  test("field 5/6 — fallbackPageSlug drift is reported independently of activePageSlug", () => {
    // The stored plan's fallback disagrees with what the SAME fresh facts would recompute —
    // isolates the fallback comparison from the activePageSlug comparison above.
    const plan = samplePlan({ fallbackPageSlug: null })
    const fresh = matchingFreshFacts(plan)
    expect(detectPageRemovePlanDrift(plan, fresh)).toEqual(["fallbackPageSlug"])
  })

  test("field 6/6 — planRevision drift is reported independently", () => {
    const plan = samplePlan()
    const fresh = { ...matchingFreshFacts(plan), planRevision: "99" }
    expect(detectPageRemovePlanDrift(plan, fresh)).toEqual(["planRevision"])
  })

  test("reports every drifted field at once, not just the first", () => {
    const plan = samplePlan()
    const fresh = { ...matchingFreshFacts(plan), sourceHash: HASH_B, planRevision: "99" }
    const drift = detectPageRemovePlanDrift(plan, fresh)
    if (drift instanceof Error) throw drift
    expect(drift).toContain("sourceHash")
    expect(drift).toContain("planRevision")
    expect(drift.length).toBe(2)
  })
})

describe("createPageRemovePlanLedger", () => {
  const orderedPageSlugs = [slug("home"), slug("about")]
  const mintInput = {
    pageSlug: slug("about"),
    sourceHash: HASH_A,
    orderedPageSlugs,
    activePageSlug: slug("about"),
  }

  test("starts with no active plan", () => {
    context.start(() => {
      const ledger = createPageRemovePlanLedger()
      expect(ledger.current()).toBeNull()
    })
  })

  test("mint() stores the plan and starts revision at \"1\"", () => {
    context.start(() => {
      const ledger = createPageRemovePlanLedger()
      const plan = ledger.mint(mintInput)
      if (plan instanceof Error) throw plan
      expect(plan.planRevision).toBe("1")
      expect(ledger.current()).toEqual(plan)
    })
  })

  test("a second mint() replaces the first and advances the revision", () => {
    context.start(() => {
      const ledger = createPageRemovePlanLedger()
      const first = ledger.mint(mintInput)
      if (first instanceof Error) throw first
      const second = ledger.mint({ ...mintInput, pageSlug: slug("home"), activePageSlug: slug("home") })
      if (second instanceof Error) throw second
      expect(second.planRevision).toBe("2")
      expect(ledger.current()).toEqual(second)
      expect(ledger.current()?.pageRemovePlanId).not.toBe(first.pageRemovePlanId)
    })
  })

  test("mint() with an unlisted page fails and leaves the ledger untouched", () => {
    context.start(() => {
      const ledger = createPageRemovePlanLedger()
      const result = ledger.mint({ ...mintInput, pageSlug: slug("missing") })
      expect(result).toBeInstanceOf(PageRemovePlanMintError)
      expect(ledger.current()).toBeNull()
    })
  })

  test("invalidate() clears the current plan", () => {
    context.start(() => {
      const ledger = createPageRemovePlanLedger()
      ledger.mint(mintInput)
      ledger.invalidate()
      expect(ledger.current()).toBeNull()
    })
  })

  test("discard() clears the plan when the id matches and reports \"discarded\"", () => {
    context.start(() => {
      const ledger = createPageRemovePlanLedger()
      const plan = ledger.mint(mintInput)
      if (plan instanceof Error) throw plan
      expect(ledger.discard(plan.pageRemovePlanId)).toBe("discarded")
      expect(ledger.current()).toBeNull()
    })
  })

  test("discard() leaves a non-matching plan untouched and reports \"not-found\"", () => {
    context.start(() => {
      const ledger = createPageRemovePlanLedger()
      const plan = ledger.mint(mintInput)
      if (plan instanceof Error) throw plan
      expect(ledger.discard("0192f6f0-0000-7000-8000-000000000099")).toBe("not-found")
      expect(ledger.current()).toEqual(plan)
    })
  })

  test("discard() on an empty ledger reports \"not-found\"", () => {
    context.start(() => {
      const ledger = createPageRemovePlanLedger()
      expect(ledger.discard("0192f6f0-0000-7000-8000-000000000099")).toBe("not-found")
    })
  })

  test("atoms carry hierarchical trace names rooted at kernel.project", () => {
    context.start(() => {
      const ledger = createPageRemovePlanLedger()
      expect(ledger.currentAtom.name).toBe("kernel.project.pageRemovePlan")
    })
  })
})
