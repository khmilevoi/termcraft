import { action, atom, type Atom } from "@reatom/core"
import * as errore from "errore"

import {
  canonicalHash,
  encodeUint64String,
  type CanonicalHashError,
  type PageRemovePlanV1,
  type Sha256Hex,
  type UInt64String,
  type UUIDv7,
} from "core/protocol"
import type { PageSlug } from "entities/page"
import { uuidv7 } from "infrastructure/uuid"

/**
 * `PageRemovePlanV1` minting and its invalidation rules (kernel-command-contract §7.1,
 * lines 214-220; §12.6, lines 1162-1180).
 *
 * §7.1: "`PageRemovePlanV1` contains exactly `pageRemovePlanId`, `pageSlug`, the current
 * canonical `sourceHash`, the exact ordered slug list and its canonical `pageOrderHash`,
 * the current active-page slug, the planned fallback slug or `null`, and `planRevision`.
 * A source write, page-order change, active-page change, project recovery, or trust
 * change invalidates the plan." This module owns exactly that: the pure construction and
 * drift-detection math, plus the single-slot Reatom ledger holding "at most one immutable
 * `PageRemovePlanV1`" (§7.1's own project-state phrasing). It does NOT own the I/O that
 * gathers fresh facts from the page/project ports, or the project-write mutex — those are
 * `page-mutations.ts`'s `confirmPageRemove`/`discardPageRemovePlan` orchestration, which
 * calls into this ledger rather than duplicating its rules.
 *
 * INVALIDATION CALL SITES: §7.1 names five triggers. This file exposes one generic
 * `invalidate()` rather than five named methods, because every trigger has the identical
 * effect ("clear the plan unconditionally") and a plan's bound facts can drift from ANY of
 * them regardless of which page/project aspect changed — §7.1 does not qualify "a source
 * write" as "to the SAME page the plan targets", so this errs conservative. The five call
 * sites are NOT all in this slice's file list: `page-mutations.ts`'s `renameTitle`/`reorder`
 * (source write / page-order change) call it directly since this agent owns both; project
 * recovery and trust change are 6E1's `recovery-routing.ts`/`trust.ts`, and active-page
 * change is whichever code writes `ProjectStore.writeWorkspaceState({ activePageSlug })` —
 * neither is this agent's file to edit, so those call sites are a documented integration
 * seam, not a gap silently left unwired.
 */

/** `mint()` was asked to plan a page that is not in its own `orderedPageSlugs` — a caller bug. */
export class PageRemovePlanMintError extends errore.createTaggedError({
  name: "PageRemovePlanMintError",
  message: "cannot mint a page-remove plan for $pageSlug: $reason",
}) {}

/** The canonical `pageOrderHash` (§7.1) — array order is meaning, matching `canonicalHash`'s own rule for `page.reorder` permutations. */
export function computePageOrderHash(orderedPageSlugs: readonly PageSlug[]): CanonicalHashError | Sha256Hex {
  return canonicalHash(orderedPageSlugs)
}

/**
 * The "planned fallback slug or `null`" (§7.1). Not spec-fixed beyond that phrase, so this
 * module picks one concrete, documented rule: fallback only matters when the removed page
 * IS the active page (removing an inactive page never needs to move the active selection,
 * so the fallback is `null`); when it is, the fallback is the next remaining page in order,
 * or the previous one if the removed page was last, or `null` if it was the only page.
 */
export function computeFallbackPageSlug(
  orderedPageSlugs: readonly PageSlug[],
  removedPageSlug: PageSlug,
  activePageSlug: PageSlug | null,
): PageSlug | null {
  if (activePageSlug !== removedPageSlug) return null

  const index = orderedPageSlugs.indexOf(removedPageSlug)
  if (index === -1) return null

  const remaining = orderedPageSlugs.filter((slug) => slug !== removedPageSlug)
  if (remaining.length === 0) return null

  if (index < orderedPageSlugs.length - 1) return orderedPageSlugs[index + 1] ?? null
  return orderedPageSlugs[index - 1] ?? null
}

export interface MintPageRemovePlanInputV1 {
  readonly pageSlug: PageSlug
  readonly sourceHash: Sha256Hex
  /** The manifest's own ordering authority at mint time (storage-identity §5.1). */
  readonly orderedPageSlugs: readonly PageSlug[]
  readonly activePageSlug: PageSlug | null
}

/** Pure construction: given already-gathered fresh facts and a revision, builds the immutable plan. */
export function buildPageRemovePlan(
  input: MintPageRemovePlanInputV1,
  planRevision: UInt64String,
): CanonicalHashError | PageRemovePlanMintError | PageRemovePlanV1 {
  if (!input.orderedPageSlugs.includes(input.pageSlug)) {
    return new PageRemovePlanMintError({
      pageSlug: input.pageSlug,
      reason: "page is not listed in orderedPageSlugs",
    })
  }

  const pageOrderHash = computePageOrderHash(input.orderedPageSlugs)
  if (pageOrderHash instanceof Error) return pageOrderHash

  const fallbackPageSlug = computeFallbackPageSlug(input.orderedPageSlugs, input.pageSlug, input.activePageSlug)

  return {
    pageRemovePlanId: uuidv7(),
    pageSlug: input.pageSlug,
    sourceHash: input.sourceHash,
    orderedPageSlugs: input.orderedPageSlugs,
    pageOrderHash,
    activePageSlug: input.activePageSlug,
    fallbackPageSlug,
    planRevision,
  }
}

/** Everything `confirmPageRemove` must re-read fresh, under the project-write mutex, before it may write (§12.6 item 2). */
export interface FreshPageRemoveFactsV1 {
  readonly sourceHash: Sha256Hex
  readonly orderedPageSlugs: readonly PageSlug[]
  readonly activePageSlug: PageSlug | null
  readonly planRevision: UInt64String
}

/** §12.6's exact enumerated comparison set: "source hash, exact ordered slug list/page-order hash, active-page/fallback facts, and plan revision" — six independent fields. */
export type PlanDriftFieldV1 =
  | "sourceHash"
  | "orderedPageSlugs"
  | "pageOrderHash"
  | "activePageSlug"
  | "fallbackPageSlug"
  | "planRevision"

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

/**
 * §7.1/§12.6's revalidation: compares the immutable stored `plan` against fresh facts
 * gathered right now, field by field. Returns the empty array when everything still
 * matches; any non-empty result means `page.removeConfirm` must return `PLAN_STALE`
 * (§12.6 item 2) and perform NO write. Each of the six checks is independent — a caller
 * can drift exactly one fact without touching the others (see this file's own tests).
 */
export function detectPageRemovePlanDrift(
  plan: PageRemovePlanV1,
  fresh: FreshPageRemoveFactsV1,
): CanonicalHashError | readonly PlanDriftFieldV1[] {
  const freshPageOrderHash = computePageOrderHash(fresh.orderedPageSlugs)
  if (freshPageOrderHash instanceof Error) return freshPageOrderHash

  const freshFallbackPageSlug = computeFallbackPageSlug(
    fresh.orderedPageSlugs,
    plan.pageSlug as PageSlug,
    fresh.activePageSlug,
  )

  const drift: PlanDriftFieldV1[] = []
  if (plan.sourceHash !== fresh.sourceHash) drift.push("sourceHash")
  if (!arraysEqual(plan.orderedPageSlugs, fresh.orderedPageSlugs)) drift.push("orderedPageSlugs")
  if (plan.pageOrderHash !== freshPageOrderHash) drift.push("pageOrderHash")
  if (plan.activePageSlug !== fresh.activePageSlug) drift.push("activePageSlug")
  if (plan.fallbackPageSlug !== freshFallbackPageSlug) drift.push("fallbackPageSlug")
  if (plan.planRevision !== fresh.planRevision) drift.push("planRevision")
  return drift
}

export interface PageRemovePlanLedger {
  readonly currentAtom: Atom<PageRemovePlanV1 | null>
  current(): PageRemovePlanV1 | null
  /** Mints a fresh plan, replacing whatever was active ("at most one", §7.1). */
  mint(input: MintPageRemovePlanInputV1): CanonicalHashError | PageRemovePlanMintError | PageRemovePlanV1
  /** Unconditionally clears the active plan — the effect every §7.1 invalidation trigger shares. */
  invalidate(): void
  /** Clears the active plan only if `planId` still names it (§7.1: "Clears only the matching active plan"). */
  discard(planId: UUIDv7): "discarded" | "not-found"
}

/**
 * Builds one Kernel's page-remove-plan ledger. A factory, not module-level atoms — the
 * project-wide convention (`kernel/model/counters.ts`'s own header) applies here too: two
 * kernels, or two tests, must never share one plan slot.
 */
export function createPageRemovePlanLedger(): PageRemovePlanLedger {
  const currentAtom = atom<PageRemovePlanV1 | null>(null, "kernel.project.pageRemovePlan")
  const revisionAtom = atom(0n, "kernel.project.pageRemovePlanRevision")

  const mint = action(
    (input: MintPageRemovePlanInputV1): CanonicalHashError | PageRemovePlanMintError | PageRemovePlanV1 => {
      const nextRevision = revisionAtom() + 1n
      const plan = buildPageRemovePlan(input, encodeUint64String(nextRevision))
      if (plan instanceof Error) return plan
      revisionAtom.set(nextRevision)
      currentAtom.set(plan)
      return plan
    },
    "kernel.project.pageRemovePlan.mint",
  )

  const invalidate = action(() => {
    currentAtom.set(null)
  }, "kernel.project.pageRemovePlan.invalidate")

  const discard = action((planId: UUIDv7): "discarded" | "not-found" => {
    const plan = currentAtom()
    if (plan === null || plan.pageRemovePlanId !== planId) return "not-found"
    currentAtom.set(null)
    return "discarded"
  }, "kernel.project.pageRemovePlan.discard")

  return {
    currentAtom,
    current: () => currentAtom(),
    mint,
    invalidate,
    discard,
  }
}
