import { FFIType, dlopen, ptr, suffix } from "bun:ffi";
import type { Library, Pointer } from "bun:ffi";

import { log } from "infrastructure/debug-log";

import type { ProcessTree } from "../types";
import { ProcessTreeError } from "../types";

// NOTE (reatom convention): this module is a non-Reatom, domain-free
// `infrastructure/` adapter — it owns raw OS handles (job/process) with
// explicit lifetimes (adopt/terminate/close), never through an atom or a
// `withConnectHook` lifetime.

/** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (Spike I). */
export const KILL_ON_JOB_CLOSE = 0x2000;

/** Byte size of `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` on x64 (Spike I FINDINGS.md). */
const EXTENDED_LIMIT_INFO_SIZE = 144;
/** Offset of the `LimitFlags` DWORD inside `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`. */
const LIMIT_FLAGS_OFFSET = 16;

/** Byte size of `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION` on x64 (Spike I FINDINGS.md). */
const BASIC_ACCOUNTING_INFO_SIZE = 48;
/** Offset of the `ActiveProcesses` DWORD inside `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION`. */
const ACTIVE_PROCESSES_OFFSET = 40;

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
/** Exit code every job member is given by `TerminateJobObject` below. */
const TERMINATE_EXIT_CODE = 1;

/**
 * The 144-byte `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` with only `LimitFlags`
 * (offset 16) set to `KILL_ON_JOB_CLOSE` — every other field stays zero
 * (Spike I: hand-derived offsets, empirically confirmed via a working kill).
 */
export function buildExtendedLimitInfo(): Uint8Array {
  const buf = new Uint8Array(EXTENDED_LIMIT_INFO_SIZE);
  new DataView(buf.buffer).setUint32(LIMIT_FLAGS_OFFSET, KILL_ON_JOB_CLOSE, true);
  return buf;
}

/**
 * Deterministic, cross-platform test double. `activeProcesses()` walks the
 * scripted `counts` one step per call, holding at the last entry; `terminate`
 * appends a trailing `0` (confirmed exit) unless `neverZero` is set, for
 * scripting an unconfirmed-exit scenario. `ownershipConfirmed` starts at the
 * optional `script.ownershipConfirmed` (default `false`, i.e. "never
 * adopted") and can be flipped to "adopted fine" either up front via that
 * option or at runtime via `noteAdoptionOutcome(true)` — mirroring the real
 * tree's sticky-true semantics.
 */
export function createFakeProcessTree(script: {
  counts: number[];
  neverZero?: boolean;
  ownershipConfirmed?: boolean;
}): ProcessTree {
  let i = 0;
  let confirmed = script.ownershipConfirmed ?? false;
  const read = () => {
    const value = script.counts[Math.min(i, script.counts.length - 1)] ?? 0;
    if (i < script.counts.length - 1) i += 1;
    return value;
  };
  return {
    adopt: () => null,
    activeProcesses: () => read(),
    terminate: () => {
      if (!script.neverZero) script.counts.push(0);
      return null;
    },
    close: () => {},
    noteAdoptionOutcome: (ok: boolean) => {
      if (ok) confirmed = true;
    },
    ownershipConfirmed: () => confirmed,
  };
}

// --- real Windows Job Object implementation (Spike I) -----------------------

const KERNEL32_SYMBOLS = {
  CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  SetInformationJobObject: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
  QueryInformationJobObject: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
  OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
  TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
} as const;

type Kernel32 = Library<typeof KERNEL32_SYMBOLS>;

/** Strips `bun:ffi`'s `__ffi_function_callable` brand off a symbol's call signature. */
type Unbranded<T> = T extends (...args: infer A) => infer R ? (...args: A) => R : never;

/**
 * The kernel32 calls the helpers below actually make, derived from the real
 * symbol table minus `bun:ffi`'s unique-symbol brand. `dlopen`'s `symbols`
 * object satisfies this structurally (production passes it verbatim), and a
 * test can supply a scripted stub — which is the only deterministic way to
 * exercise the FFI *failure* branches (`result === 0` in `activeProcesses` /
 * `terminate`, and `AssignProcessToJobObject` returning 0 in `adopt`).
 * A real, healthy job handle cannot be made to fail those calls on demand,
 * which is precisely why finding [9]'s guard survived every mutation until
 * this seam existed.
 */
export type JobObjectSyscalls = {
  readonly [K in keyof Kernel32["symbols"]]: Unbranded<Kernel32["symbols"][K]>;
};

/** Process-wide cache: kernel32 only needs to be `dlopen`'d once. */
let cachedKernel32: Kernel32 | null = null;

/**
 * Renders a thrown FFI-boundary value into a stable message even when it is
 * not an `Error` (errore boundary caveat: `bun:ffi`'s `dlopen` is not
 * guaranteed to throw an `Error` instance, so this module uses a raw
 * try/catch here instead of `errore.try` — mirrors
 * `host/supervisor/model/spawn.ts`'s `describe`/`asError` helpers, which
 * exist for the same reason at the `Bun.spawn` boundary).
 */
function describeFailure(cause: unknown): string {
  const code = (cause as { code?: unknown } | undefined)?.code;
  const message = (cause as { message?: unknown } | undefined)?.message ?? cause;
  return code === undefined ? String(message) : `${String(code)}: ${String(message)}`;
}

function asError(cause: unknown): Error | undefined {
  return cause instanceof Error ? cause : undefined;
}

/** `GetLastError()` for a diagnostic message; never throws past this call. */
function lastErrorSafe(sys: JobObjectSyscalls): string {
  try {
    return String(sys.GetLastError());
  } catch {
    return "unknown";
  }
}

function openKernel32(): Kernel32 {
  if (cachedKernel32 !== null) return cachedKernel32;
  const lib = dlopen(`kernel32.${suffix}`, KERNEL32_SYMBOLS);
  cachedKernel32 = lib;
  return lib;
}

/** Releases a handle, logging (never throwing) on failure — errore rule 21: swallowed errors must be logged. */
function closeHandleQuietly(sys: JobObjectSyscalls, handle: Pointer): void {
  try {
    sys.CloseHandle(handle);
  } catch (cause) {
    log.warn(
      "infrastructure/process: CloseHandle failed, handle leaked:",
      describeFailure(cause),
    );
  }
}

function adopt(sys: JobObjectSyscalls, jobHandle: Pointer, pid: number): ProcessTreeError | null {
  const procHandle = (() => {
    try {
      return sys.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, pid);
    } catch (cause) {
      return new ProcessTreeError({
        reason: `OpenProcess failed for pid ${pid}: ${describeFailure(cause)}`,
        cause: asError(cause),
      });
    }
  })();
  if (procHandle instanceof ProcessTreeError) return procHandle;
  if (procHandle === null) {
    return new ProcessTreeError({
      reason: `OpenProcess returned a null handle for pid ${pid} (GetLastError=${lastErrorSafe(sys)})`,
    });
  }

  const assignResult = (() => {
    try {
      return sys.AssignProcessToJobObject(jobHandle, procHandle);
    } catch (cause) {
      return new ProcessTreeError({
        reason: `AssignProcessToJobObject failed for pid ${pid}: ${describeFailure(cause)}`,
        cause: asError(cause),
      });
    }
  })();
  // The process handle is only needed for the assignment call itself — job
  // membership is tracked by the OS against the process, not this handle, so
  // it is released immediately either way rather than held for the tree's
  // lifetime (avoids a handle leak per adopted pid).
  closeHandleQuietly(sys, procHandle);

  if (assignResult instanceof ProcessTreeError) return assignResult;
  if (assignResult === 0) {
    return new ProcessTreeError({
      reason: `AssignProcessToJobObject returned failure for pid ${pid} (GetLastError=${lastErrorSafe(sys)})`,
    });
  }
  // Caveat (Spike I): assign races the child spawning its own descendants —
  // no CREATE_SUSPENDED is reachable from Bun's spawn. Callers that need to
  // know the whole tree is owned should re-read `activeProcesses()` rather
  // than assume this success means every descendant is in yet.
  return null;
}

function activeProcesses(sys: JobObjectSyscalls, jobHandle: Pointer): ProcessTreeError | number {
  const acctBuf = new Uint8Array(BASIC_ACCOUNTING_INFO_SIZE);
  const retLenBuf = new Uint32Array(1);
  const result = (() => {
    try {
      return sys.QueryInformationJobObject(
        jobHandle,
        JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
        ptr(acctBuf),
        acctBuf.length,
        ptr(retLenBuf),
      );
    } catch (cause) {
      return new ProcessTreeError({
        reason: `QueryInformationJobObject failed: ${describeFailure(cause)}`,
        cause: asError(cause),
      });
    }
  })();
  if (result instanceof ProcessTreeError) return result;
  if (result === 0) {
    return new ProcessTreeError({
      reason: `QueryInformationJobObject returned failure (GetLastError=${lastErrorSafe(sys)})`,
    });
  }
  return new DataView(acctBuf.buffer).getUint32(ACTIVE_PROCESSES_OFFSET, true);
}

function terminate(sys: JobObjectSyscalls, jobHandle: Pointer): ProcessTreeError | null {
  const result = (() => {
    try {
      return sys.TerminateJobObject(jobHandle, TERMINATE_EXIT_CODE);
    } catch (cause) {
      return new ProcessTreeError({
        reason: `TerminateJobObject failed: ${describeFailure(cause)}`,
        cause: asError(cause),
      });
    }
  })();
  if (result instanceof ProcessTreeError) return result;
  if (result === 0) {
    return new ProcessTreeError({
      reason: `TerminateJobObject returned failure (GetLastError=${lastErrorSafe(sys)})`,
    });
  }
  return null;
}

/** The tagged error every method returns once `close()` has run (finding [28]). */
function closedTreeError(): ProcessTreeError {
  return new ProcessTreeError({
    reason: "process tree is closed, its job handle has been released",
  });
}

/**
 * The real tree's behavior over an injectable syscall table. Exported so tests
 * can drive the FFI *failure* branches (`result === 0`) with a scripted
 * {@link JobObjectSyscalls} stub — see the type's doc comment. Production
 * reaches this only through {@link createJobObjectTree}.
 */
export function buildTreeFromSyscalls(sys: JobObjectSyscalls, jobHandle: Pointer): ProcessTree {
  // Closure-owned lifetime state (non-Reatom adapter, per CLAUDE.md): `closed`
  // makes `close()` idempotent and, critically, INVALIDATING — once true, no
  // method below issues another FFI call against `jobHandle`. Windows
  // recycles HANDLE values aggressively, so touching the value again after
  // release risks silently operating on a since-reused, unrelated kernel
  // object (finding [28]) rather than failing loudly.
  let closed = false;
  let ownershipConfirmed = false;

  return {
    adopt: (pid: number) => (closed ? closedTreeError() : adopt(sys, jobHandle, pid)),
    activeProcesses: () => (closed ? closedTreeError() : activeProcesses(sys, jobHandle)),
    terminate: () => (closed ? closedTreeError() : terminate(sys, jobHandle)),
    // Kill-on-close (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) fires for any
    // survivor once this, the last handle to the job, is released — the
    // crash-safety net described in Spike I FINDINGS.md Step 4a-ii. Guarded
    // by `closed` so a second call (e.g. both the natural-completion and the
    // cancel-ladder paths closing the same tree) never issues a second
    // `CloseHandle` on a value the OS may already have reassigned.
    close: () => {
      if (closed) return;
      closed = true;
      closeHandleQuietly(sys, jobHandle);
    },
    noteAdoptionOutcome: (ok: boolean) => {
      if (ok) ownershipConfirmed = true;
    },
    ownershipConfirmed: () => ownershipConfirmed,
  };
}

/**
 * The real Windows Job Object tree via `bun:ffi` (Spike I). Returns a typed
 * `ProcessTreeError` on non-Windows, or when `dlopen`/`CreateJobObjectW`/
 * `SetInformationJobObject` fails — this function, and every method on the
 * `ProcessTree` it returns, never throws: every FFI call is wrapped so a
 * failure becomes a `ProcessTreeError` value.
 */
export function createJobObjectTree(): ProcessTreeError | ProcessTree {
  if (process.platform !== "win32") {
    return new ProcessTreeError({ reason: "Job Object requires win32" });
  }

  const k32 = (() => {
    try {
      return openKernel32();
    } catch (cause) {
      return new ProcessTreeError({
        reason: `dlopen kernel32 failed: ${describeFailure(cause)}`,
        cause: asError(cause),
      });
    }
  })();
  if (k32 instanceof ProcessTreeError) return k32;
  // `symbols` satisfies `JobObjectSyscalls` structurally — every helper below
  // takes the narrowed table so it can also be driven by a scripted stub.
  const sys: JobObjectSyscalls = k32.symbols;

  const jobHandle = (() => {
    try {
      return sys.CreateJobObjectW(null, null);
    } catch (cause) {
      return new ProcessTreeError({
        reason: `CreateJobObjectW failed: ${describeFailure(cause)}`,
        cause: asError(cause),
      });
    }
  })();
  if (jobHandle instanceof ProcessTreeError) return jobHandle;
  if (jobHandle === null) {
    return new ProcessTreeError({
      reason: `CreateJobObjectW returned a null handle (GetLastError=${lastErrorSafe(sys)})`,
    });
  }

  const limitInfo = buildExtendedLimitInfo();
  const setInfoResult = (() => {
    try {
      return sys.SetInformationJobObject(
        jobHandle,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        ptr(limitInfo),
        limitInfo.length,
      );
    } catch (cause) {
      return new ProcessTreeError({
        reason: `SetInformationJobObject failed: ${describeFailure(cause)}`,
        cause: asError(cause),
      });
    }
  })();
  if (setInfoResult instanceof ProcessTreeError) {
    // The job exists but has no kill-on-close limit and no owner to close it —
    // release it here or the handle leaks for the life of the process.
    closeHandleQuietly(sys, jobHandle);
    return setInfoResult;
  }
  if (setInfoResult === 0) {
    closeHandleQuietly(sys, jobHandle);
    return new ProcessTreeError({
      reason: `SetInformationJobObject(kill-on-close) returned failure (GetLastError=${lastErrorSafe(sys)})`,
    });
  }

  return buildTreeFromSyscalls(sys, jobHandle);
}
