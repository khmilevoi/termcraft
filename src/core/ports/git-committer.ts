import type { FailureDtoV1 } from "core/protocol"
import type { PageSlug } from "entities/page"

/**
 * `GitCommitter` — DECLARED ONLY, same status as `git-history.ts`: no MVP implementation
 * exists or is planned this phase (`/commit-*` is on ROADMAP's out-of-scope list; this
 * slice's plan §1 Tier C keeps `commit.plan`/`commit.confirm`/`commit.discardPlan` at
 * guard-only, `available: false` with `CAPABILITY_UNAVAILABLE`, so no service is ever
 * reached).
 *
 * Transcribes `docs/superpowers/specs/2026-07-16-git-backed-page-history-design.md` §4's
 * illustrative `GitCommitter` as closely as that document fixes it; `CommitPlan`'s exact
 * field list is prose-only there ("the expected `HEAD`, the selected paths and their
 * current states and content hashes") and is this port's own best-faith reading — revisit
 * against the real design section once a future phase builds the adapter.
 */

export type CommitScopeV1 = { readonly kind: "current-page"; readonly slug: PageSlug } | { readonly kind: "infrastructure" } | { readonly kind: "entire-project" }

/** Mirrors `turn-transactions.ts`'s `FileImageV1` — the same "does this path still match its planned state" fact, redeclared locally per this ring's own convention of not cross-importing between port files unless the type must be identical (project-write.ts's permit is the one case that must be). */
export type CommitPathImageV1 = { readonly state: "absent" } | { readonly state: "file"; readonly sha256: string; readonly size: number }

/**
 * The revalidatable commit plan (design §4-§5): "contains the expected `HEAD`, the selected
 * paths and their current states and content hashes... `commit` revalidates the plan before
 * invoking Git; it refuses a stale plan rather than silently committing a different file
 * set."
 */
export interface CommitPlanV1 {
  readonly expectedHeadCommitId: string
  readonly paths: readonly { readonly path: string; readonly currentImage: CommitPathImageV1 }[]
}

export interface CommitResultV1 {
  readonly commitId: string
}

export interface GitCommitter {
  planCommit(scope: CommitScopeV1): Promise<FailureDtoV1 | CommitPlanV1>
  /** Revalidates `plan` against the live repository before invoking Git; a stale plan is refused, never silently re-scoped. */
  commit(plan: CommitPlanV1, message: string): Promise<FailureDtoV1 | CommitResultV1>
}
