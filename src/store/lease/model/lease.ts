import { FFIType, dlopen, suffix } from "bun:ffi";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as errore from "errore";
import { z } from "zod";

import { rfc3339UtcSchema } from "infrastructure/clock";
import type { Clock } from "infrastructure/clock";

import type {
  AbsPath,
  LeaseAdvisory,
  LeaseLockApi,
  LeaseLockHandle,
  LeaseProcessIdentity,
  LeaseStore,
  LeaseStoreDeps,
  ProjectLease,
} from "../types";

// ---- errors -------------------------------------------------------------------

/**
 * Another process holds the project's OS lock (storage-identity §9). `advisory` is
 * bounded metadata read out of the lock file and is ALWAYS advisory: it never proves
 * ownership, and a PID that looks absent, stale, or reused never authorizes deleting
 * or stealing the lock. The held OS lock is the sole authority.
 */
export class LeaseHeldError extends errore.createTaggedError({
  name: "LeaseHeldError",
  message:
    "project $root is already held by another termcraft instance; lock-file metadata is advisory only",
}) {
  readonly advisory: LeaseAdvisory;

  constructor(args: { root: string; advisory: LeaseAdvisory; cause?: unknown }) {
    super(args);
    this.advisory = args.advisory;
  }
}

/**
 * The OS-lock primitive is a Windows `bun:ffi` call into `kernel32.dll`. When the
 * library cannot be loaded — a non-Windows host, or a `dlopen` failure — acquisition
 * fails closed rather than pretending the project is exclusively owned.
 */
export class LeaseUnavailableError extends errore.createTaggedError({
  name: "LeaseUnavailableError",
  message: "project-lease OS lock is unavailable on this platform: $reason",
}) {}

/** The lock file or its directory could not be opened, locked, read, or rewritten. */
export class LeaseIoError extends errore.createTaggedError({
  name: "LeaseIoError",
  message: "lease lock $operation failed for $path: $detail",
}) {}

// ---- layout + bounds ----------------------------------------------------------

/** The lock lives at `<root>/.termcraft/lock` (storage-identity §9). */
export function leaseLockPath(root: AbsPath): AbsPath {
  return path.join(root, ".termcraft", "lock");
}

/**
 * Advisory metadata is BOUNDED (storage-identity §9 says "bounded" without fixing a
 * number). Judgment call for this implementation: a lock file larger than 4 KiB is
 * refused unread, a hostname longer than 255 characters is rejected, and the record
 * carries exactly the four §9 fields. Anything else on disk is ignored.
 */
const MAX_ADVISORY_BYTES = 4096;
const MAX_HOSTNAME_CHARS = 255;

/** `leaseNonce` is a 128-bit random rendered base64url — 16 bytes → 22 unpadded characters. */
const LEASE_NONCE_BYTES = 16;
const LEASE_NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

const EMPTY_ADVISORY: LeaseAdvisory = { pid: null, startedAt: null, hostname: null, nonce: null };

/**
 * Mint a `leaseNonce`: 128 bits from the CSPRNG, base64url-encoded. Deliberately NOT
 * a UUIDv7 (roadmap identity registry) — the nonce distinguishes acquisitions and must
 * leak neither a timestamp nor an ordering, unlike every other durable identity.
 * Storage-identity §9 calls the diagnostic field "a UUIDv7 lease instance"; the roadmap
 * supersedes that with the random-nonce rule, and this code follows the roadmap.
 */
export function leaseNonce(): string {
  const bytes = new Uint8Array(LEASE_NONCE_BYTES);
  crypto.webcrypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/**
 * The real process's advisory facts (storage-identity §9: PID, process start time,
 * hostname). `startedAt` is derived from the injected clock minus the process uptime,
 * so a fake clock produces a deterministic value in tests.
 */
export function systemLeaseIdentity(clock: Clock): () => LeaseProcessIdentity {
  return () => ({
    pid: process.pid,
    hostname: os.hostname().slice(0, MAX_HOSTNAME_CHARS),
    startedAt: new Date(clock.now().getTime() - Math.round(process.uptime() * 1000)).toISOString(),
  });
}

// ---- the Windows OS lock ------------------------------------------------------

const GENERIC_WRITE = 0x40000000;
const FILE_SHARE_READ = 0x1;
const FILE_SHARE_WRITE = 0x2;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const LOCKFILE_FAIL_IMMEDIATELY = 0x1;
const LOCKFILE_EXCLUSIVE_LOCK = 0x2;
const ERROR_LOCK_VIOLATION = 33;

/**
 * The lock is taken on a one-byte region at a 1 GiB offset rather than on byte zero.
 * A Windows byte-range lock is mandatory — locking the bytes that hold the advisory
 * JSON would make the file unreadable to the very processes §9 expects to display it.
 * The region is far past any lock file's real length, where nothing is ever stored.
 */
const LOCK_REGION_OFFSET_LOW = 0x40000000;
const LOCK_REGION_OFFSET_HIGH = 0;
const LOCK_REGION_BYTES = 1;

/** `OVERLAPPED` on x64: two `ULONG_PTR`, then `Offset`/`OffsetHigh` `DWORD`s, then `hEvent`. */
const OVERLAPPED_SIZE = 32;
const OVERLAPPED_OFFSET_LOW = 16;
const OVERLAPPED_OFFSET_HIGH = 20;

const KERNEL32_SYMBOLS = {
  CreateFileW: {
    args: [
      FFIType.ptr,
      FFIType.u32,
      FFIType.u32,
      FFIType.ptr,
      FFIType.u32,
      FFIType.u32,
      FFIType.ptr,
    ],
    returns: FFIType.ptr,
  },
  LockFileEx: {
    args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
  UnlockFileEx: {
    args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
} as const;

type Kernel32 = ReturnType<typeof dlopen<typeof KERNEL32_SYMBOLS>>;

let cachedKernel32: Kernel32 | LeaseUnavailableError | null = null;

/**
 * Lazily `dlopen` `kernel32.dll` once. On a non-Windows host the name cannot resolve
 * and `dlopen` throws — the only raw boundary `try` here — so it is wrapped in a value.
 *
 * NOTE for T19/architecture: `LockFileEx`/`UnlockFileEx` are domain-free fs facts and
 * arguably belong beside the existing `infrastructure/durability` and
 * `infrastructure/fs-guard` kernel32 bindings. They live here only because this task
 * may not add files outside `store/lease`; the binding is injected through
 * `LeaseLockApi`, so moving it later changes no caller.
 */
function loadKernel32(): Kernel32 | LeaseUnavailableError {
  if (cachedKernel32 !== null) return cachedKernel32;
  cachedKernel32 = errore.try({
    try: () => dlopen(`kernel32.${suffix}`, KERNEL32_SYMBOLS),
    catch: (cause) => new LeaseUnavailableError({ reason: cause.message, cause }),
  });
  return cachedKernel32;
}

/** UTF-16LE, NUL-terminated buffer for a Win32 `LPCWSTR` (Spike G: `*W` APIs need wide strings). */
function toWideString(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf16le");
}

/** `INVALID_HANDLE_VALUE` is `(void*)-1`; `bun:ffi` may surface it as `null`, a number, or a bigint. */
function isInvalidHandle(handle: number | bigint | null): boolean {
  if (handle === null) return true;
  if (typeof handle === "bigint") return handle === 0xffffffffffffffffn;
  return handle === -1;
}

function lockRegionOverlapped(): Buffer {
  const overlapped = Buffer.alloc(OVERLAPPED_SIZE);
  overlapped.writeUInt32LE(LOCK_REGION_OFFSET_LOW, OVERLAPPED_OFFSET_LOW);
  overlapped.writeUInt32LE(LOCK_REGION_OFFSET_HIGH, OVERLAPPED_OFFSET_HIGH);
  return overlapped;
}

/**
 * The production OS lock: `CreateFileW(OPEN_ALWAYS)` on `.termcraft/lock` followed by a
 * non-blocking `LockFileEx(LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY)`
 * (storage-identity §9). The handle is never shared for delete, so the lock file cannot
 * be removed or renamed out from under a live owner; the kernel closes the handle on
 * abrupt termination, which releases the lock while the file stays on disk.
 *
 * Returns `null` — not an error — when another handle already holds the lock.
 */
export const windowsLeaseLockApi: LeaseLockApi = {
  acquire(lockPath: AbsPath): LeaseUnavailableError | LeaseIoError | LeaseLockHandle | null {
    const k32 = loadKernel32();
    if (k32 instanceof Error) return k32;

    const handle = k32.symbols.CreateFileW(
      toWideString(lockPath),
      GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      null,
      OPEN_ALWAYS,
      FILE_ATTRIBUTE_NORMAL,
      null,
    );
    if (isInvalidHandle(handle)) {
      return new LeaseIoError({
        path: lockPath,
        operation: "open",
        detail: `Win32 error ${k32.symbols.GetLastError()}`,
      });
    }

    const locked = k32.symbols.LockFileEx(
      handle,
      LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
      0,
      LOCK_REGION_BYTES,
      0,
      lockRegionOverlapped(),
    );
    if (locked === 0) {
      const lastError = k32.symbols.GetLastError();
      k32.symbols.CloseHandle(handle);
      if (lastError === ERROR_LOCK_VIOLATION) return null;
      return new LeaseIoError({
        path: lockPath,
        operation: "lock",
        detail: `Win32 error ${lastError}`,
      });
    }

    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        k32.symbols.UnlockFileEx(handle, 0, LOCK_REGION_BYTES, 0, lockRegionOverlapped());
        k32.symbols.CloseHandle(handle);
      },
    };
  },
};

// ---- advisory metadata --------------------------------------------------------

/**
 * Every field is independently optional: a forged, truncated, or partially written
 * lock file degrades field-by-field to `null` instead of failing the read, because
 * nothing here is ever consulted for a decision (storage-identity §9).
 */
const advisorySchema = z.object({
  pid: z.number().int().min(1).max(0xffffffff).nullable().catch(null),
  startedAt: rfc3339UtcSchema.nullable().catch(null),
  hostname: z.string().min(1).max(MAX_HOSTNAME_CHARS).nullable().catch(null),
  nonce: z.string().regex(LEASE_NONCE_PATTERN).nullable().catch(null),
});

/** Read the lock file within its byte bound; `null` when it is missing, oversized, or unreadable. */
function readLockFile(lockPath: AbsPath): string | null {
  const text = errore.try({
    try: () => {
      const stat = fs.statSync(lockPath);
      if (!stat.isFile()) return null;
      if (stat.size > MAX_ADVISORY_BYTES) {
        // Refused unread rather than buffered: §9's metadata is bounded by construction.
        console.warn(
          "lease: advisory refused, lock file exceeds",
          MAX_ADVISORY_BYTES,
          "bytes:",
          lockPath,
        );
        return null;
      }
      return fs.readFileSync(lockPath, "utf8");
    },
    catch: (cause) =>
      new LeaseIoError({ path: lockPath, operation: "read", detail: cause.message, cause }),
  });
  if (text instanceof Error) {
    // Never propagated: an unreadable lock file only means "no advisory to show".
    if (!isMissingFile(text.cause)) console.warn("lease: advisory read failed:", text.message);
    return null;
  }
  return text;
}

/** `ENOENT` is the ordinary "no owner has ever written here" case, not a fault worth logging. */
function isMissingFile(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Decode the bounded advisory record (storage-identity §9). Returns `null` when the
 * lock file is missing or does not decode at all; individually invalid fields become
 * `null` inside an otherwise usable record.
 */
function readAdvisoryFile(lockPath: AbsPath): LeaseAdvisory | null {
  const text = readLockFile(lockPath);
  if (text === null) return null;

  const parsed = errore.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) =>
      new LeaseIoError({ path: lockPath, operation: "decode", detail: "not valid JSON", cause }),
  });
  if (parsed instanceof Error) {
    console.warn("lease: advisory decode failed:", parsed.message);
    return null;
  }

  const decoded = advisorySchema.safeParse(parsed);
  if (!decoded.success) {
    console.warn("lease: advisory decode failed:", `${lockPath} is not an advisory record`);
    return null;
  }
  return decoded.data;
}

/** Rewrite the diagnostics — only ever called WHILE HOLDING the lock (storage-identity §9). */
function writeAdvisoryFile(lockPath: AbsPath, advisory: LeaseAdvisory): LeaseIoError | undefined {
  const wrote = errore.try({
    try: () => fs.writeFileSync(lockPath, `${JSON.stringify(advisory)}\n`, "utf8"),
    catch: (cause) =>
      new LeaseIoError({ path: lockPath, operation: "write", detail: cause.message, cause }),
  });
  if (wrote instanceof Error) return wrote;
  return undefined;
}

/**
 * `.termcraft/` must already exist: project creation makes it with create-new semantics
 * and only then acquires the lease (storage-identity §9). Checked here so a missing
 * layout is a named error rather than a raw Win32 code from `CreateFileW`.
 */
function requireLockDirectory(root: AbsPath): LeaseIoError | undefined {
  const dir = path.dirname(leaseLockPath(root));
  const stat = errore.try({
    try: () => fs.statSync(dir),
    catch: (cause) =>
      new LeaseIoError({ path: dir, operation: "stat", detail: cause.message, cause }),
  });
  if (stat instanceof Error) return stat;
  if (!stat.isDirectory())
    return new LeaseIoError({ path: dir, operation: "stat", detail: "not a directory" });
  return undefined;
}

// ---- the store ----------------------------------------------------------------

/**
 * The `ProjectLease` store (storage-identity §9). Acquisition is a non-blocking
 * exclusive OS lock held on an open `.termcraft/lock` handle for the process lifetime;
 * a crashed owner's lock is released by the kernel, so the next process opens the SAME
 * file, takes the lock, and only then rewrites the diagnostics. Nothing here ever
 * deletes the lock file, and no PID, hostname, or nonce in it is treated as ownership.
 */
export function createLeaseStore(deps: LeaseStoreDeps): LeaseStore {
  return {
    async acquire(root: AbsPath) {
      const layout = requireLockDirectory(root);
      if (layout instanceof Error) return layout;

      const lockPath = leaseLockPath(root);
      const handle = deps.lock.acquire(lockPath);
      if (handle instanceof Error) return handle;
      if (handle === null)
        return new LeaseHeldError({ root, advisory: readAdvisoryFile(lockPath) ?? EMPTY_ADVISORY });

      const identity = deps.identity();
      const nonce = deps.mintNonce();
      const wrote = writeAdvisoryFile(lockPath, {
        pid: identity.pid,
        startedAt: identity.startedAt,
        hostname: identity.hostname,
        nonce,
      });
      // Diagnostics are advisory: failing to write them does not undo a held OS lock.
      if (wrote instanceof Error) console.warn("lease: advisory write failed:", wrote.message);

      // Release is idempotent: a second call must never drop a lock a LATER acquisition
      // took on the same path, so the lease forgets its handle after the first release.
      let released = false;
      const lease: ProjectLease = {
        nonce,
        lockPath,
        async release() {
          if (released) return;
          released = true;
          handle.release();
        },
      };
      return lease;
    },

    async readAdvisory(root: AbsPath) {
      return readAdvisoryFile(leaseLockPath(root));
    },
  };
}
