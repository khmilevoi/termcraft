import type { Clock } from "infrastructure/clock";

import type { TrustLedgerError, TrustSubjectError } from "./model/trust-store";

/** Any failure `store/trust` can return — a `_tag`-discriminated union for propagating callers. */
export type TrustError = TrustSubjectError | TrustLedgerError;

/**
 * An OS-absolute path handed in by the composition root — never a caller-built managed
 * relative path. `store/types.ts` (T19) owns the shared alias; this local declaration
 * keeps the submodule self-contained until then.
 */
export type AbsPath = string;

/** Lowercase-hex SHA-256. The trust key is one of these (storage-identity §8). */
export type Sha256Hex = string;

/**
 * The local Git repository storage and the project's location within its worktree
 * (storage-identity §8). It deliberately contains NO branch name, `HEAD`, commit id,
 * index checksum, remote URL, or Git user identity: those change constantly and must
 * never revoke a trust grant. Initializing, replacing, or moving within the repository
 * does change these three fields, and therefore does require a new trust decision.
 */
export interface GitIdentity {
  /** Canonical (`/`-separated, drive-uppercased, no trailing separator) Git common dir. */
  readonly canonicalGitCommonDir: string;
  /** `infrastructure/fs-guard`'s canonical identity string for that directory. */
  readonly gitCommonDirFilesystemIdentity: string;
  /** NFC repo-relative project path; `""` when the project IS the worktree root. */
  readonly projectPathRelativeToWorktreeRoot: string;
}

/**
 * The four ordered inputs of the `TrustSubjectV1` byte encoding (storage-identity §8).
 * Separated from `TrustSubject` so the encoder is a pure total function of exactly the
 * digested fields — nothing else can leak into the trust key.
 */
export interface TrustSubjectInput {
  readonly canonicalProjectPath: string;
  readonly projectFilesystemIdentity: string;
  readonly projectId: string;
  readonly git: GitIdentity | null;
}

/** A built subject: its digested inputs plus the derived trust key (storage-identity §8). */
export interface TrustSubject extends TrustSubjectInput {
  /** Lowercase-hex SHA-256 of the complete `TrustSubjectV1` byte string. */
  readonly key: Sha256Hex;
}

/** Which kind of thing a trust grant names (project-design-systems §8.4). */
export type TrustSubjectKind = "project" | "source";

/**
 * The four ordered inputs of the `TrustSubjectSourceV1` byte encoding (project-design-systems
 * §8.4). A design-system source is a trust subject DISTINCT FROM PROJECT TRUST: adding one is an
 * explicit, recorded decision, and an unrecorded remote source is never queried.
 *
 * Deliberately carries nothing that churns — no branch, no last-fetched time, no package list.
 * `locationFilesystemIdentity` is present only for a filesystem-backed source, so replacing the
 * directory at the same path is a new decision exactly as it is for a project; a remote carries
 * `null` and encodes the same `absent` tag a missing `GitIdentity` does.
 */
export interface SourceTrustSubjectInput {
  /** The adapter family: `"local"`, `"github"`. */
  readonly sourceKind: string;
  /** The port's `id`: `"local"`, `"github:acme/design-systems"`. */
  readonly sourceId: string;
  /** Canonical absolute path for a filesystem source; canonical remote address otherwise. */
  readonly canonicalLocation: string;
  /** `infrastructure/fs-guard`'s identity string, or `null` for a source with no local directory. */
  readonly locationFilesystemIdentity: string | null;
}

/** A built source subject: its digested inputs plus the derived trust key. */
export interface SourceTrustSubject extends SourceTrustSubjectInput {
  /** Lowercase-hex SHA-256 of the complete `TrustSubjectSourceV1` byte string. */
  readonly key: Sha256Hex;
}

/**
 * The impure boundary the trust store needs, injected so tests drive alias resolution,
 * directory replacement, and durable-write failure against fakes. `nodeTrustFsDeps` is
 * the production wiring (`fs.realpathSync.native`, `infrastructure/fs-guard`'s
 * `formatFsIdentity`, `infrastructure/durability`'s `durableFileWrite`).
 */
export interface TrustFsDeps {
  /** Resolve path aliases (junctions, symlinks) and, on Windows, the true on-disk casing. */
  readonly realpath: (absPath: AbsPath) => string | Error;
  /** The canonical `unix:`/`windows:` filesystem-identity string (storage-identity §8). */
  readonly fsIdentity: (absPath: AbsPath) => string | Error;
  /** Create the ledger directory when it does not exist yet. */
  readonly ensureDir: (absDir: AbsPath) => Error | undefined;
  /** Read a grant record; `null` means "no such file", which is simply "not granted". */
  readonly readFile: (absPath: AbsPath) => Uint8Array | null | Error;
  /** Durable atomic install (storage-identity §4.2) — the ledger's only write path. */
  readonly durableWrite: (absPath: AbsPath, bytes: Uint8Array) => Error | undefined;
}

/** Everything `createTrustStore` needs; every impure boundary is injected. */
export interface TrustStoreDeps {
  /** The OS per-user termcraft state root that owns the machine trust ledger (§4). */
  readonly userStateRoot: AbsPath;
  readonly clock: Clock;
  readonly fs: TrustFsDeps;
}

/**
 * The machine-local trust ledger (storage-identity §8). A grant matches only the same
 * COMPLETE subject: no page source is imported, rendered, smoke tested, or exported
 * before the current subject has a grant. A repository can copy a `projectId` but cannot
 * copy the machine-local path, filesystem identity, Git identity, or the grant.
 */
export interface TrustStore {
  buildSubject(
    root: AbsPath,
    projectId: string,
    git: GitIdentity | null,
  ): Promise<TrustError | TrustSubject>;
  /** `false` on a missing, unreadable, corrupt, or tampered grant — it never fails open. */
  isGranted(subject: TrustSubject): Promise<boolean>;
  /** Records the grant durably; `undefined` on success. */
  grant(subject: TrustSubject): Promise<TrustError | undefined>;
  /**
   * A design-system source subject (project-design-systems §8.4). Synchronous and total: unlike
   * a project subject it resolves no path and reads no filesystem identity — the caller supplies
   * the canonical location and, for a filesystem-backed source, its identity string, exactly as
   * it already supplies a `GitIdentity`.
   */
  buildSourceSubject(input: SourceTrustSubjectInput): SourceTrustSubject;
  /** `false` on a missing, unreadable, corrupt, tampered, or wrong-KIND record — never fails open. */
  isSourceGranted(subject: SourceTrustSubject): Promise<boolean>;
  /** Records the source grant durably; `undefined` on success. */
  grantSource(subject: SourceTrustSubject): Promise<TrustError | undefined>;
}
