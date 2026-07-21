import type { LeaseHeldError, LeaseIoError, LeaseUnavailableError } from "./model/lease";

/**
 * An OS-absolute path handed in by the composition root — never a caller-built
 * managed relative path. `store/types.ts` (T19) owns the shared alias; this local
 * declaration keeps the submodule self-contained until then.
 */
export type AbsPath = string;

/**
 * Bounded diagnostic metadata read out of `.termcraft/lock` (storage-identity §9).
 *
 * Every field is ALWAYS advisory and NEVER ownership proof: the held OS lock is the
 * sole authority. A field is `null` when it is absent, unreadable, or fails its
 * bound — a corrupt or forged lock file degrades to nulls, it never denies or
 * authorizes anything. termcraft never deletes or steals a lock because a `pid`
 * appears absent, stale, or reused.
 */
export interface LeaseAdvisory {
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly hostname: string | null;
  readonly nonce: string | null;
}

/**
 * A held project lease. The OS lock lives on an open `.termcraft/lock` handle for
 * the process lifetime (storage-identity §9); abrupt termination releases it while
 * the file itself remains on disk.
 */
export interface ProjectLease {
  /** This acquisition's `leaseNonce` — a 128-bit base64url random, not a UUIDv7. */
  readonly nonce: string;
  readonly lockPath: AbsPath;
  release(): Promise<void>;
}

/** A live OS lock plus the handle that owns it. Releasing closes the handle. */
export interface LeaseLockHandle {
  release(): void;
}

/**
 * The injected OS-lock boundary — the one impure seam of the lease. Production wires
 * `windowsLeaseLockApi` (`LockFileEx` over a `CreateFileW` handle); tests wire a fake.
 *
 * `acquire` is NON-BLOCKING: `null` means another handle already holds the lock (the
 * only "held" signal — it is never inferred from file contents), an `Error` means the
 * lock could not be attempted at all.
 */
export interface LeaseLockApi {
  acquire(lockPath: AbsPath): LeaseUnavailableError | LeaseIoError | LeaseLockHandle | null;
}

/** The advisory facts about the acquiring process (storage-identity §9: PID, start time, hostname). */
export interface LeaseProcessIdentity {
  readonly pid: number;
  readonly hostname: string;
  /** UTC RFC 3339 process start time. */
  readonly startedAt: string;
}

/** Everything `createLeaseStore` needs; every impure boundary is injected. */
export interface LeaseStoreDeps {
  readonly lock: LeaseLockApi;
  readonly identity: () => LeaseProcessIdentity;
  readonly mintNonce: () => string;
}

/**
 * The project-lease port (storage-identity §9). Every process that may mutate a
 * project holds one for its entire project lifetime; a failed acquisition refuses
 * mutation and may surface `LeaseAdvisory`, clearly labeled advisory.
 */
export interface LeaseStore {
  acquire(
    root: AbsPath,
  ): Promise<LeaseHeldError | LeaseUnavailableError | LeaseIoError | ProjectLease>;
  /** Bounded advisory read; `null` when the lock file is missing, unreadable, or undecodable. */
  readAdvisory(root: AbsPath): Promise<LeaseAdvisory | null>;
}

/** Any failure the lease can return — a `_tag`-discriminated union for propagating callers. */
export type LeaseError = LeaseHeldError | LeaseUnavailableError | LeaseIoError;
