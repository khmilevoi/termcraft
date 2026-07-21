import type { FailureDtoV1, Sha256Hex } from "core/protocol"
import type { AssertConforms } from "../index"
import type { GitIdentityV1, TrustGate, TrustSubjectV1 } from "../trust"

/**
 * In-memory {@link TrustGate} fake (6D task brief). `isGranted` NEVER FAILS OPEN by
 * construction — it is a plain `Set.has` lookup with no failure queue at all, mirroring
 * the port's own doc ("`isGranted` never fails open") and the fact its signature has no
 * `FailureDtoV1` variant to inject one through.
 */

/** A deterministic, valid-looking 64-hex-char {@link Sha256Hex} derived from a seed — no crypto, no randomness. */
function fakeSha256Hex(seed: string): Sha256Hex {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) | 0
  const base = (h >>> 0).toString(16).padStart(8, "0")
  return base.repeat(8).slice(0, 64)
}

export type TrustGateFailableMethod = "buildSubject" | "grant"

export type TrustGateCall =
  | { readonly method: "buildSubject"; readonly root: string; readonly projectId: string }
  | { readonly method: "isGranted"; readonly key: Sha256Hex; readonly result: boolean }
  | { readonly method: "grant"; readonly key: Sha256Hex }

export interface FakeTrustGate extends TrustGate {
  readonly calls: readonly TrustGateCall[]
  failNext(method: TrustGateFailableMethod, failure: FailureDtoV1): void
}

export function createFakeTrustGate(): FakeTrustGate {
  const grants = new Set<Sha256Hex>()
  const calls: TrustGateCall[] = []

  const queues: Record<TrustGateFailableMethod, FailureDtoV1[]> = {
    buildSubject: [],
    grant: [],
  }

  function failNext(method: TrustGateFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure)
  }

  async function buildSubject(root: string, projectId: string, git: GitIdentityV1 | null): Promise<FailureDtoV1 | TrustSubjectV1> {
    calls.push({ method: "buildSubject", root, projectId })
    const queued = queues.buildSubject.shift()
    if (queued !== undefined) return queued
    const key = fakeSha256Hex(`${root}|${projectId}|${git?.canonicalGitCommonDir ?? "no-git"}|${git?.gitCommonDirFilesystemIdentity ?? ""}`)
    return {
      canonicalProjectPath: root,
      projectFilesystemIdentity: `fake-fsid:${root}`,
      projectId,
      git,
      key,
    }
  }

  async function isGranted(subject: TrustSubjectV1): Promise<boolean> {
    const result = grants.has(subject.key)
    calls.push({ method: "isGranted", key: subject.key, result })
    return result
  }

  async function grant(subject: TrustSubjectV1): Promise<FailureDtoV1 | undefined> {
    calls.push({ method: "grant", key: subject.key })
    const queued = queues.grant.shift()
    if (queued !== undefined) return queued
    grants.add(subject.key)
    return undefined
  }

  return { buildSubject, isGranted, grant, calls, failNext }
}

type _Conforms = AssertConforms<TrustGate, FakeTrustGate>
