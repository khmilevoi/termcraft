// The `ProjectLease` (storage-identity §9): a non-blocking exclusive OS lock held on an
// open `.termcraft/lock` handle for the whole project lifetime. The held lock is the
// SOLE authority on write ownership — the PID, start time, hostname, and nonce in the
// file are bounded advisory diagnostics, never proof, and termcraft never deletes or
// steals a lock because a PID looks absent, stale, or reused (§14.5). A crashed owner's
// lock is released by the kernel; the next process reopens the same file, takes the
// lock, and only then rewrites the diagnostics.
export type {
  AbsPath,
  LeaseAdvisory,
  LeaseError,
  LeaseLockApi,
  LeaseLockHandle,
  LeaseProcessIdentity,
  LeaseStore,
  LeaseStoreDeps,
  ProjectLease,
} from "./types";
export { LeaseHeldError, LeaseIoError, LeaseUnavailableError } from "./model/lease";
export {
  createLeaseStore,
  leaseLockPath,
  leaseNonce,
  systemLeaseIdentity,
  windowsLeaseLockApi,
} from "./model/lease";
