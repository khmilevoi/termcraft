import type { FailureDtoV1, Sha256Hex } from "core/protocol"

/**
 * `TrustGate`: the machine-local trust ledger (storage-identity §8) narrowed from
 * `store/trust`'s real `TrustStore` per decision C1. The method names and their contract
 * are unchanged — `store/trust`'s own `TrustStore` is already close to a minimal port — but
 * `GitIdentity`/`TrustSubject` are redrawn locally rather than imported, and `TrustError`
 * (a `store`-owned tagged-error union) is replaced by `FailureDtoV1` at this boundary.
 *
 * "A grant matches only the same COMPLETE subject... `isGranted` never fails open" —
 * `store/trust`'s own header, worth restating here because `project.setTrust`'s guard and
 * the implicit-grant-on-create path (kernel-command-contract §7.1) both depend on that
 * exact non-failing-open behavior.
 */

/**
 * The local Git repository storage and the project's location within its worktree
 * (storage-identity §8). Deliberately carries no branch, `HEAD`, commit id, index
 * checksum, remote URL, or Git user identity — those change constantly and must never
 * revoke a trust grant.
 */
export interface GitIdentityV1 {
  readonly canonicalGitCommonDir: string
  readonly gitCommonDirFilesystemIdentity: string
  readonly projectPathRelativeToWorktreeRoot: string
}

/** A built trust subject: its digested inputs plus the derived trust key (storage-identity §8). */
export interface TrustSubjectV1 {
  readonly canonicalProjectPath: string
  readonly projectFilesystemIdentity: string
  readonly projectId: string
  readonly git: GitIdentityV1 | null
  /** Lowercase-hex SHA-256 of the complete `TrustSubjectV1` byte encoding — the grant key. */
  readonly key: Sha256Hex
}

export interface TrustGate {
  buildSubject(root: string, projectId: string, git: GitIdentityV1 | null): Promise<FailureDtoV1 | TrustSubjectV1>
  /** `false` on a missing, unreadable, corrupt, or tampered grant — never fails open. */
  isGranted(subject: TrustSubjectV1): Promise<boolean>
  /** Records the grant durably; `undefined` on success. */
  grant(subject: TrustSubjectV1): Promise<FailureDtoV1 | undefined>
}
