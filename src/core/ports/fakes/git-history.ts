import type { FailureDtoV1 } from "core/protocol"
import type { AssertConforms } from "../index"
import type {
  GitHistory,
  GitProjectStateV1,
  PageGitStateV1,
  PageHistoryPageV1,
  PageHistoryRequestV1,
  PageIndexStateV1,
} from "../git-history"

/**
 * In-memory {@link GitHistory} fake (6D task brief). `GitHistory` is DECLARED ONLY — no
 * MVP adapter exists (Tier C: `history.open`'s guard rejects with `available: false`
 * before this port is ever called) — so every default here is a plausible "no history"
 * answer, overridable at construction for the rare test exercising the declared shape
 * directly rather than through a guard that always short-circuits it.
 */

export type GitHistoryFailableMethod = "inspectProject" | "inspectPage" | "listPageCommits" | "readPageSource" | "inspectIndex"

export type GitHistoryCall =
  | { readonly method: "inspectProject"; readonly projectPath: string }
  | { readonly method: "inspectPage"; readonly sourcePath: string }
  | { readonly method: "listPageCommits"; readonly sourcePath: string }
  | { readonly method: "readPageSource"; readonly commitId: string; readonly sourcePath: string }
  | { readonly method: "inspectIndex"; readonly sourcePath: string }

export interface FakeGitHistory extends GitHistory {
  readonly calls: readonly GitHistoryCall[]
  failNext(method: GitHistoryFailableMethod, failure: FailureDtoV1): void
}

export function createFakeGitHistory(options?: {
  readonly project?: GitProjectStateV1
  readonly page?: PageGitStateV1
  readonly commits?: PageHistoryPageV1
  readonly index?: PageIndexStateV1
}): FakeGitHistory {
  const calls: GitHistoryCall[] = []
  const queues: Record<GitHistoryFailableMethod, FailureDtoV1[]> = {
    inspectProject: [],
    inspectPage: [],
    listPageCommits: [],
    readPageSource: [],
    inspectIndex: [],
  }

  function failNext(method: GitHistoryFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure)
  }

  async function inspectProject(projectPath: string): Promise<FailureDtoV1 | GitProjectStateV1> {
    calls.push({ method: "inspectProject", projectPath })
    return queues.inspectProject.shift() ?? options?.project ?? { repository: "no-repository", headCommitId: null }
  }

  async function inspectPage(sourcePath: string): Promise<FailureDtoV1 | PageGitStateV1> {
    calls.push({ method: "inspectPage", sourcePath })
    return queues.inspectPage.shift() ?? options?.page ?? { tracking: { kind: "unborn" }, currentSourceHash: "0".repeat(64) }
  }

  async function listPageCommits(request: PageHistoryRequestV1): Promise<FailureDtoV1 | PageHistoryPageV1> {
    calls.push({ method: "listPageCommits", sourcePath: request.sourcePath })
    return queues.listPageCommits.shift() ?? options?.commits ?? { entries: [], nextCursor: null }
  }

  async function readPageSource(commitId: string, sourcePath: string): Promise<FailureDtoV1 | Uint8Array> {
    calls.push({ method: "readPageSource", commitId, sourcePath })
    return queues.readPageSource.shift() ?? new Uint8Array(0)
  }

  async function inspectIndex(sourcePath: string): Promise<FailureDtoV1 | PageIndexStateV1> {
    calls.push({ method: "inspectIndex", sourcePath })
    return queues.inspectIndex.shift() ?? options?.index ?? { staged: false, unstagedChangePresent: false }
  }

  return { inspectProject, inspectPage, listPageCommits, readPageSource, inspectIndex, calls, failNext }
}

type _Conforms = AssertConforms<GitHistory, FakeGitHistory>
