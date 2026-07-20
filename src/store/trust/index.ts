// The `TrustSubject` and the machine-local trust ledger (storage-identity §8, Spike F §8).
//
// A trust grant is keyed by the lowercase-hex SHA-256 of a byte-exact `TrustSubjectV1`
// encoding of the COMPLETE subject: canonical project path, that directory's filesystem
// identity, the portable `projectId`, and an optional `GitIdentity`. Moving or copying
// the project, replacing the directory at the same path, changing `projectId`, creating
// or replacing its Git repository, or moving it within a worktree therefore all require a
// new decision — while `HEAD`, ref, commit, rebase, and index values, which the subject
// deliberately excludes, never revoke a grant. Two path aliases resolving to the same
// filesystem object collapse to ONE subject.
//
// The encoder is verified against both normative §8 vectors in `model/subject.test.ts`;
// the ledger lives under `{userStateRoot}`, outside every project, so a repository can
// copy a `projectId` but never a grant. `store/trust` assembles the domain subject; the
// raw `statSync`/identity-string formatting stays domain-free in `infrastructure/fs-guard`.
export type {
  AbsPath,
  GitIdentity,
  Sha256Hex,
  TrustError,
  TrustFsDeps,
  TrustStore,
  TrustStoreDeps,
  TrustSubject,
  TrustSubjectInput,
} from "./types"

export {
  TRUST_SUBJECT_V1_PREFIX,
  canonicalizeRepoRelativePath,
  canonicalizeTrustPath,
  encodeTrustSubjectV1,
  trustSubjectKey,
} from "./model/subject"

export {
  TrustLedgerError,
  TrustSubjectError,
  createTrustStore,
  nodeTrustFsDeps,
  trustGrantPath,
  trustLedgerDir,
} from "./model/trust-store"
