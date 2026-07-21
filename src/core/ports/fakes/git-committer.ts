import type { FailureDtoV1 } from "core/protocol"
import type { AssertConforms } from "../index"
import type { CommitPlanV1, CommitResultV1, CommitScopeV1, GitCommitter } from "../git-committer"

/**
 * In-memory {@link GitCommitter} fake (6D task brief). `GitCommitter` is DECLARED ONLY —
 * no MVP adapter exists (Tier C: `commit.*` guards reject with `available: false` before
 * this port is ever called) — so `planCommit` defaults to an empty, always-revalidatable
 * plan and `commit` mints a fresh id per call.
 */

export type GitCommitterFailableMethod = "planCommit" | "commit"

export type GitCommitterCall =
  | { readonly method: "planCommit"; readonly scope: CommitScopeV1 }
  | { readonly method: "commit"; readonly message: string }

export interface FakeGitCommitter extends GitCommitter {
  readonly calls: readonly GitCommitterCall[]
  failNext(method: GitCommitterFailableMethod, failure: FailureDtoV1): void
}

export function createFakeGitCommitter(): FakeGitCommitter {
  const calls: GitCommitterCall[] = []
  let counter = 0
  const queues: Record<GitCommitterFailableMethod, FailureDtoV1[]> = { planCommit: [], commit: [] }

  function failNext(method: GitCommitterFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure)
  }

  async function planCommit(scope: CommitScopeV1): Promise<FailureDtoV1 | CommitPlanV1> {
    calls.push({ method: "planCommit", scope })
    const queued = queues.planCommit.shift()
    if (queued !== undefined) return queued
    return { expectedHeadCommitId: "fake-head-commit", paths: [] }
  }

  async function commit(plan: CommitPlanV1, message: string): Promise<FailureDtoV1 | CommitResultV1> {
    calls.push({ method: "commit", message })
    const queued = queues.commit.shift()
    if (queued !== undefined) return queued
    counter += 1
    void plan
    return { commitId: `fake-commit-${counter}` }
  }

  return { planCommit, commit, calls, failNext }
}

type _Conforms = AssertConforms<GitCommitter, FakeGitCommitter>
