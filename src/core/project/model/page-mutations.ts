import { wrap } from "@reatom/core";

import type {
  DesignTreeReader,
  PageMutations,
  ProjectStore,
  ProjectWriteCoordinator,
} from "core/ports";
import type { FailureDtoV1, PageRemovePlanV1, UUIDv7 } from "core/protocol";
import type { PageSlug } from "entities/page";

import { readPageEntrySource, readPageOrder } from "./descriptors";
import {
  type FreshPageRemoveFactsV1,
  type PageRemovePlanLedger,
  type PlanDriftFieldV1,
  detectPageRemovePlanDrift,
} from "./page-remove-plan";

/**
 * MIGRATED (task 14, red-debt.md's `src/core/kernel/**` row): the local `LegacyPageReader`
 * shim this module carried — a verbatim copy of the `PageReader` shape task 7 deleted from
 * `core/ports` — is gone. Both facts it supplied now come from `./descriptors`'
 * `readPageOrder`/`readPageEntrySource`, i.e. from `design/pages.json` and the entry it binds
 * to a slug, never from a path derived from the slug.
 */

/**
 * The four page mutation commands (kernel-command-contract §8.2): `page.renameTitle`,
 * `page.reorder`, `page.removeConfirm`, `page.removeDiscardPlan`. `page.removePlan`'s own
 * mint orchestration lives in `page-remove-plan.ts` (see that file's header) — this module
 * is the other three-and-a-half.
 *
 * Every mutation here goes through `DesignTreeReader`/`PageMutations`/`ProjectStore`/
 * `ProjectWriteCoordinator` (`core/ports`) — no direct I/O. `renameTitle`/`reorder` do not
 * build a `page.descriptorsChanged` event themselves: that requires re-running Gate over
 * the mutated page (`core/ports/gate-runner.ts`), a capability outside this module; the
 * caller composes this mutation's success with a fresh descriptor read and
 * `descriptors.ts`'s `buildPageDescriptorsChangedPayload`.
 *
 * Every port call below is `await wrap(...)`-ed (Reatom rule RTM-A04): a plain `await` on a
 * port's promise loses the active `context.start(...)` frame the moment control returns to
 * the event loop, so code AFTER that await touching `planLedger` (itself Reatom actions)
 * would silently run outside any context. `wrap` re-associates the resumed continuation
 * with the frame captured at the `wrap(...)` call site, matching `core/mailbox/model/
 * dispatch.ts`'s own use of the same rule for the identical reason.
 */

// ---------------------------------------------------------------------------
// page.renameTitle
// ---------------------------------------------------------------------------

export interface RenameTitleDeps {
  readonly pageStore: DesignTreeReader & PageMutations;
  readonly planLedger: PageRemovePlanLedger;
}

/**
 * `page.renameTitle` (§8.2): "Mechanically rewrite static `meta.title` through one
 * `project-mutation` transaction." The rewrite changes the page's on-disk bytes, so it is
 * "a source write" (§7.1) and unconditionally invalidates any active page-removal plan —
 * see `page-remove-plan.ts`'s header on why `invalidate()` is unconditional rather than
 * scoped to the SAME page.
 */
export async function renameTitle(
  deps: RenameTitleDeps,
  pageSlug: PageSlug,
  title: string,
): Promise<FailureDtoV1 | undefined> {
  // `PageMutations.renameTitle` returns `FailureDtoV1 | undefined` — a plain DTO, never an
  // `Error` instance (this ring's own idiom, see `project/model/trust.ts`'s identical note:
  // "the ring's own idiom for a `FailureDtoV1 | T` union where `T` is a plain DTO"). Success
  // here is exactly `undefined`, so presence is the failure check.
  const result = await wrap(deps.pageStore.renameTitle(pageSlug, title));
  if (result !== undefined) return result;
  deps.planLedger.invalidate();
  return undefined;
}

// ---------------------------------------------------------------------------
// page.reorder
// ---------------------------------------------------------------------------

export type ReorderPagesResultV1 =
  | { readonly kind: "reordered" }
  | { readonly kind: "invalid-permutation" };

export interface ReorderDeps {
  readonly pageStore: DesignTreeReader & PageMutations;
  readonly planLedger: PageRemovePlanLedger;
}

/** True when `candidate` is exactly a reordering of `current` — same slugs, same count, no additions/removals/duplicates. */
function isExactPermutation(current: readonly PageSlug[], candidate: readonly PageSlug[]): boolean {
  if (current.length !== candidate.length) return false;
  const currentCounts = new Map<PageSlug, number>();
  for (const slug of current) currentCounts.set(slug, (currentCounts.get(slug) ?? 0) + 1);
  for (const slug of candidate) {
    const remaining = currentCounts.get(slug);
    if (remaining === undefined || remaining === 0) return false;
    currentCounts.set(slug, remaining - 1);
  }
  return true;
}

/**
 * `page.reorder` (§8.2): "Replace only portable page order through one transaction." The
 * port's own doc states `order` must be "the exact permutation of already-listed slugs —
 * never a subset or an added/removed identity" but does not enforce it (the fake blindly
 * overwrites) — this function is the one place that check runs, before any write.
 */
export async function reorder(
  deps: ReorderDeps,
  order: readonly PageSlug[],
): Promise<FailureDtoV1 | ReorderPagesResultV1> {
  const pages = await wrap(readPageOrder(deps.pageStore));
  if ("code" in pages) return pages;
  const current = pages.map((entry) => entry.slug);

  if (!isExactPermutation(current, order)) return { kind: "invalid-permutation" };

  const result = await wrap(deps.pageStore.reorder(order));
  if (result !== undefined) return result;

  deps.planLedger.invalidate();
  return { kind: "reordered" };
}

// ---------------------------------------------------------------------------
// page.removeDiscardPlan
// ---------------------------------------------------------------------------

export type DiscardPageRemovePlanResultV1 =
  | { readonly kind: "discarded" }
  | { readonly kind: "not-found" };

export interface DiscardPageRemovePlanDeps {
  readonly planLedger: PageRemovePlanLedger;
}

/** `page.removeDiscardPlan` (§7.1): "Clears only the matching active plan and performs no project write." Synchronous — no port I/O at all. */
export function discardPageRemovePlan(
  deps: DiscardPageRemovePlanDeps,
  planId: UUIDv7,
): DiscardPageRemovePlanResultV1 {
  const outcome = deps.planLedger.discard(planId);
  return outcome === "discarded" ? { kind: "discarded" } : { kind: "not-found" };
}

// ---------------------------------------------------------------------------
// page.removeConfirm
// ---------------------------------------------------------------------------

export type ConfirmPageRemoveResultV1 =
  | { readonly kind: "removed"; readonly pageSlug: PageSlug }
  | { readonly kind: "not-found" }
  | { readonly kind: "stale"; readonly driftedFields: readonly PlanDriftFieldV1[] }
  | { readonly kind: "failure"; readonly failure: FailureDtoV1 };

export interface ConfirmPageRemoveDeps {
  readonly pageStore: DesignTreeReader & PageMutations;
  readonly projectStore: ProjectStore;
  readonly planLedger: PageRemovePlanLedger;
  readonly mutex: ProjectWriteCoordinator;
}

/**
 * `page.removeConfirm` (§8.2, §12.6 item 2): "Revalidate the complete active plan under
 * the project-write mutex and execute its one bound `project-mutation`; no acknowledgement
 * or page identity is accepted from the UI." `payload` upstream of this function is
 * ALREADY reduced to just `pageRemovePlanId` (§7.1) — this function accepts only `planId`.
 *
 * The mutex is acquired BEFORE any revalidation read, and every return path releases it —
 * including "not-found" and every failure — so a rejected/stale confirm never leaks the
 * lock. The transaction (`pageStore.remove`) runs ONLY when `detectPageRemovePlanDrift`
 * reports zero drifted fields.
 */
export async function confirmPageRemove(
  deps: ConfirmPageRemoveDeps,
  planId: UUIDv7,
): Promise<ConfirmPageRemoveResultV1> {
  const permit = await wrap(deps.mutex.acquire());

  const plan = deps.planLedger.current();
  if (plan === null || plan.pageRemovePlanId !== planId) {
    deps.mutex.release(permit);
    return { kind: "not-found" };
  }

  const fresh = await wrap(gatherFreshFacts(deps, plan));
  if ("code" in fresh) {
    deps.mutex.release(permit);
    return { kind: "failure", failure: fresh };
  }

  const drift = detectPageRemovePlanDrift(plan, fresh);
  if (drift instanceof Error) {
    deps.mutex.release(permit);
    return {
      kind: "failure",
      failure: {
        code: "PERSISTENCE_FAILED",
        retryable: false,
        safeMessage: drift.message,
        details: {},
      },
    };
  }
  if (drift.length > 0) {
    deps.mutex.release(permit);
    return { kind: "stale", driftedFields: drift };
  }

  // Re-read the ledger AFTER the awaits above. `gatherFreshFacts` can only report the
  // plan's own `planRevision` back to itself — it has no fresher source for it — so the
  // §12.6 plan-revision comparison is `x !== x` and can never fire on its own. That
  // matters because §7.1's other invalidation triggers ("project recovery, or trust
  // change") clear the plan WITHOUT touching any of the five observable facts and WITHOUT
  // holding this mutex, so an invalidation landing inside this window is reachable, not
  // theoretical: without this check the page is deleted against a plan that no longer exists.
  const stillActive = deps.planLedger.current();
  if (stillActive === null || stillActive.pageRemovePlanId !== plan.pageRemovePlanId) {
    deps.mutex.release(permit);
    return { kind: "stale", driftedFields: ["planRevision"] };
  }

  const removed = await wrap(deps.pageStore.remove(plan));
  if (removed !== undefined) {
    deps.mutex.release(permit);
    return { kind: "failure", failure: removed };
  }

  deps.planLedger.discard(plan.pageRemovePlanId);
  deps.mutex.release(permit);
  return { kind: "removed", pageSlug: plan.pageSlug as PageSlug };
}

async function gatherFreshFacts(
  deps: Pick<ConfirmPageRemoveDeps, "pageStore" | "projectStore">,
  plan: PageRemovePlanV1,
): Promise<FailureDtoV1 | FreshPageRemoveFactsV1> {
  // ONE manifest read backs both facts, so the frozen order and the entry whose bytes give
  // `sourceHash` can never come from two different reads of `design/pages.json`.
  const pages = await wrap(readPageOrder(deps.pageStore));
  if ("code" in pages) return pages;
  const orderedPageSlugs = pages.map((entry) => entry.slug);

  const source = await wrap(readPageEntrySource(deps.pageStore, plan.pageSlug as PageSlug, pages));
  if ("code" in source) return source;

  const workspace = await wrap(deps.projectStore.readWorkspaceState());
  if ("code" in workspace) return workspace;

  return {
    sourceHash: source.sourceHash,
    orderedPageSlugs,
    activePageSlug: workspace.state.activePageSlug,
    planRevision: plan.planRevision,
  };
}
