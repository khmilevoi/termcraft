import type { FailureDtoV1, Sha256Hex } from "core/protocol"
import type { AssertConforms } from "../index"
import type { CandidatePageSetV1, CreateTurnWorkspaceInputV1, StagedFileV1, StagingService, TurnWorkspaceV1 } from "../staging"

/**
 * In-memory {@link StagingService} fake (6D task brief). `createTurnWorkspace` synthesizes
 * a deterministic root path and file list from `input.turnId`/`pages`/`runtimeDocs`/
 * `manifestSlice` — no real disk write happens, so `snapshotToCandidate` and
 * `retireWorkspace` only need to track which workspace ids are live, not copy real bytes.
 */

/** A deterministic, valid-looking 64-hex-char {@link Sha256Hex} derived from a seed — no crypto, no randomness. */
function fakeSha256Hex(seed: string): Sha256Hex {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) | 0
  const base = (h >>> 0).toString(16).padStart(8, "0")
  return base.repeat(8).slice(0, 64)
}

export type StagingFailableMethod = "createTurnWorkspace" | "snapshotToCandidate" | "retireWorkspace"

export type StagingCall =
  | { readonly method: "createTurnWorkspace"; readonly input: CreateTurnWorkspaceInputV1 }
  | { readonly method: "snapshotToCandidate"; readonly turnId: string }
  | { readonly method: "retireWorkspace"; readonly turnId: string; readonly effective: boolean }

export interface FakeStagingService extends StagingService {
  readonly calls: readonly StagingCall[]
  failNext(method: StagingFailableMethod, failure: FailureDtoV1): void
}

export function createFakeStagingService(): FakeStagingService {
  const live = new Set<string>()
  const calls: StagingCall[] = []

  const queues: Record<StagingFailableMethod, FailureDtoV1[]> = {
    createTurnWorkspace: [],
    snapshotToCandidate: [],
    retireWorkspace: [],
  }

  function failNext(method: StagingFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure)
  }

  async function createTurnWorkspace(input: CreateTurnWorkspaceInputV1): Promise<FailureDtoV1 | TurnWorkspaceV1> {
    calls.push({ method: "createTurnWorkspace", input })
    const queued = queues.createTurnWorkspace.shift()
    if (queued !== undefined) return queued

    const pageFiles: StagedFileV1[] = input.pages.map((page) => ({
      relPath: `pages/${page.pageSlug}/index.tsx`,
      sha256: fakeSha256Hex(page.sourcePath),
      size: 0,
    }))
    const runtimeFiles: StagedFileV1[] = input.runtimeDocs.map((doc) => ({
      relPath: doc.relPath,
      sha256: fakeSha256Hex(doc.sourcePath),
      size: 0,
    }))
    const manifestFile: StagedFileV1 = {
      relPath: "pages.json",
      sha256: fakeSha256Hex(`manifest:${input.turnId}`),
      size: input.manifestSlice.byteLength,
    }
    const files = [manifestFile, ...pageFiles, ...runtimeFiles]

    live.add(input.turnId)
    return {
      turnId: input.turnId,
      root: `/fake-turn-workspace/${input.turnId}`,
      files,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      readSet: input.readSet,
    }
  }

  async function snapshotToCandidate(workspace: TurnWorkspaceV1): Promise<FailureDtoV1 | CandidatePageSetV1> {
    calls.push({ method: "snapshotToCandidate", turnId: workspace.turnId })
    const queued = queues.snapshotToCandidate.shift()
    if (queued !== undefined) return queued
    return { root: `/fake-candidate/${workspace.turnId}`, files: workspace.files, totalBytes: workspace.totalBytes }
  }

  async function retireWorkspace(workspace: TurnWorkspaceV1): Promise<FailureDtoV1 | undefined> {
    const effective = live.has(workspace.turnId)
    calls.push({ method: "retireWorkspace", turnId: workspace.turnId, effective })
    const queued = queues.retireWorkspace.shift()
    if (queued !== undefined) return queued
    live.delete(workspace.turnId)
    return undefined
  }

  return { createTurnWorkspace, snapshotToCandidate, retireWorkspace, calls, failNext }
}

type _Conforms = AssertConforms<StagingService, FakeStagingService>
