import type { FailureDtoV1 } from "core/protocol";

/**
 * `GitHistory` — DECLARED ONLY. No MVP implementation exists or is planned this phase:
 * ROADMAP's out-of-scope list defers Restore and `history.open`'s service to a later phase
 * (this slice's plan §1, Tier C — "their guards return `available: false` with a typed
 * reason, so no service is ever reached"), and `docs/architecture/code-structure.md`'s own
 * anchor for the Git adapter says plainly: "no code implements either side of this yet."
 *
 * The shape below transcribes `docs/superpowers/specs/2026-07-16-git-backed-page-history-
 * design.md` §4's illustrative interface as closely as that document fixes it. Several
 * referenced shapes (`GitProjectState`, `PageGitState`, `PageIndexState`) are sketched only
 * in prose there — §3's row-precedence rules and §4's paragraph on `PageIndexState` are the
 * closest the design gets to a field list — so the types below are this port's own
 * best-faith reading, not a verbatim transcription, and MUST be revisited against the real
 * design section once a future phase actually builds the adapter. `PageHistoryRequest`/
 * `PageHistoryPage` are "the bounded cursor/generation types defined by the projections and
 * scale design §8" per that same document — default page size 50, hard maximum 200 — and
 * are redrawn here to the same bound.
 *
 * `core` consumes this port; `store`'s (not-yet-written) Git adapter would implement it
 * (code-structure.md item 4: "core consumes GitHistory... so it declares [it] in
 * core/ports/; the Git adapter inside store implements them").
 */

export type GitRepositoryStateV1 = "unborn" | "no-repository" | "normal";

export interface GitProjectStateV1 {
  readonly repository: GitRepositoryStateV1;
  /** Full Git object id of `HEAD`; `null` when unborn or no repository. */
  readonly headCommitId: string | null;
}

/** The page's Git-tracking state (design §3's row-precedence inputs: unborn / untracked(±ancestry) / tracked(=HEAD?)). */
export type PageTrackingStateV1 =
  | { readonly kind: "unborn" }
  | { readonly kind: "untracked"; readonly hasFirstParentAncestry: boolean }
  | { readonly kind: "tracked"; readonly matchesHead: boolean };

export interface PageGitStateV1 {
  readonly tracking: PageTrackingStateV1;
  readonly currentSourceHash: string;
}

/** Bounded cursor/generation history request (projections-observability §8). Default 50, hard maximum 200. */
export interface PageHistoryRequestV1 {
  readonly sourcePath: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/** One committed history entry — identified by full object id; short hash/author/timestamp/subject are display-only (design §3). */
export interface CommitEntryV1 {
  readonly commitId: string;
  readonly shortHash: string;
  readonly author: string;
  readonly committerTimestamp: string;
  readonly subject: string;
}

export interface PageHistoryPageV1 {
  readonly entries: readonly CommitEntryV1[];
  readonly nextCursor: string | null;
}

/** Whether the path has index/working-tree changes Restore planning must warn about or refuse against (design §7: "a staged source blocks Restore"). */
export interface PageIndexStateV1 {
  readonly staged: boolean;
  readonly unstagedChangePresent: boolean;
}

export interface GitHistory {
  inspectProject(projectPath: string): Promise<FailureDtoV1 | GitProjectStateV1>;
  inspectPage(sourcePath: string): Promise<FailureDtoV1 | PageGitStateV1>;
  listPageCommits(request: PageHistoryRequestV1): Promise<FailureDtoV1 | PageHistoryPageV1>;
  readPageSource(commitId: string, sourcePath: string): Promise<FailureDtoV1 | Uint8Array>;
  inspectIndex(sourcePath: string): Promise<FailureDtoV1 | PageIndexStateV1>;
}
