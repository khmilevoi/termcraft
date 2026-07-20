import { dlopen, FFIType, ptr, suffix } from "bun:ffi"
import type { Library, Pointer } from "bun:ffi"
import type { ProcessTree } from "../types"
import { ProcessTreeError } from "../types"

// NOTE (reatom convention): this module is a non-Reatom, domain-free
// `infrastructure/` adapter — it owns raw OS handles (job/process) with
// explicit lifetimes (adopt/terminate/close), never through an atom or a
// `withConnectHook` lifetime.

/** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (Spike I). */
export const KILL_ON_JOB_CLOSE = 0x2000

/** Byte size of `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` on x64 (Spike I FINDINGS.md). */
const EXTENDED_LIMIT_INFO_SIZE = 144
/** Offset of the `LimitFlags` DWORD inside `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`. */
const LIMIT_FLAGS_OFFSET = 16

/** Byte size of `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION` on x64 (Spike I FINDINGS.md). */
const BASIC_ACCOUNTING_INFO_SIZE = 48
/** Offset of the `ActiveProcesses` DWORD inside `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION`. */
const ACTIVE_PROCESSES_OFFSET = 40

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1
const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100
/** Exit code every job member is given by `TerminateJobObject` below. */
const TERMINATE_EXIT_CODE = 1

/**
 * The 144-byte `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` with only `LimitFlags`
 * (offset 16) set to `KILL_ON_JOB_CLOSE` — every other field stays zero
 * (Spike I: hand-derived offsets, empirically confirmed via a working kill).
 */
export function buildExtendedLimitInfo(): Uint8Array {
  const buf = new Uint8Array(EXTENDED_LIMIT_INFO_SIZE)
  new DataView(buf.buffer).setUint32(LIMIT_FLAGS_OFFSET, KILL_ON_JOB_CLOSE, true)
  return buf
}

/**
 * Deterministic, cross-platform test double. `activeProcesses()` walks the
 * scripted `counts` one step per call, holding at the last entry; `terminate`
 * appends a trailing `0` (confirmed exit) unless `neverZero` is set, for
 * scripting an unconfirmed-exit scenario.
 */
export function createFakeProcessTree(script: { counts: number[]; neverZero?: boolean }): ProcessTree {
  let i = 0
  const read = () => {
    const value = script.counts[Math.min(i, script.counts.length - 1)] ?? 0
    if (i < script.counts.length - 1) i += 1
    return value
  }
  return {
    adopt: () => null,
    activeProcesses: () => read(),
    terminate: () => {
      if (!script.neverZero) script.counts.push(0)
      return null
    },
    close: () => {},
  }
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
} as const

type Kernel32 = Library<typeof KERNEL32_SYMBOLS>

/** Process-wide cache: kernel32 only needs to be `dlopen`'d once. */
let cachedKernel32: Kernel32 | null = null

/**
 * Renders a thrown FFI-boundary value into a stable message even when it is
 * not an `Error` (errore boundary caveat: `bun:ffi`'s `dlopen` is not
 * guaranteed to throw an `Error` instance, so this module uses a raw
 * try/catch here instead of `errore.try` — mirrors
 * `host/supervisor/model/spawn.ts`'s `describe`/`asError` helpers, which
 * exist for the same reason at the `Bun.spawn` boundary).
 */
function describeFailure(cause: unknown): string {
  const code = (cause as { code?: unknown } | undefined)?.code
  const message = (cause as { message?: unknown } | undefined)?.message ?? cause
  return code === undefined ? String(message) : `${String(code)}: ${String(message)}`
}

function asError(cause: unknown): Error | undefined {
  return cause instanceof Error ? cause : undefined
}

/** `GetLastError()` for a diagnostic message; never throws past this call. */
function lastErrorSafe(k32: Kernel32): string {
  try {
    return String(k32.symbols.GetLastError())
  } catch {
    return "unknown"
  }
}

function openKernel32(): Kernel32 {
  if (cachedKernel32 !== null) return cachedKernel32
  const lib = dlopen(`kernel32.${suffix}`, KERNEL32_SYMBOLS)
  cachedKernel32 = lib
  return lib
}

/** Releases a handle, logging (never throwing) on failure — errore rule 21: swallowed errors must be logged. */
function closeHandleQuietly(k32: Kernel32, handle: Pointer): void {
  try {
    k32.symbols.CloseHandle(handle)
  } catch (cause) {
    console.warn("infrastructure/process: CloseHandle failed, handle leaked:", describeFailure(cause))
  }
}

function adopt(k32: Kernel32, jobHandle: Pointer, pid: number): ProcessTreeError | null {
  const procHandle = (() => {
    try {
      return k32.symbols.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, pid)
    } catch (cause) {
      return new ProcessTreeError({
        reason: `OpenProcess failed for pid ${pid}: ${describeFailure(cause)}`,
        cause: asError(cause),
      })
    }
  })()
  if (procHandle instanceof ProcessTreeError) return procHandle
  if (procHandle === null) {
    return new ProcessTreeError({
      reason: `OpenProcess returned a null handle for pid ${pid} (GetLastError=${lastErrorSafe(k32)})`,
    })
  }

  const assignResult = (() => {
    try {
      return k32.symbols.AssignProcessToJobObject(jobHandle, procHandle)
    } catch (cause) {
      return new ProcessTreeError({
        reason: `AssignProcessToJobObject failed for pid ${pid}: ${describeFailure(cause)}`,
        cause: asError(cause),
      })
    }
  })()
  // The process handle is only needed for the assignment call itself — job
  // membership is tracked by the OS against the process, not this handle, so
  // it is released immediately either way rather than held for the tree's
  // lifetime (avoids a handle leak per adopted pid).
  closeHandleQuietly(k32, procHandle)

  if (assignResult instanceof ProcessTreeError) return assignResult
  if (assignResult === 0) {
    return new ProcessTreeError({
      reason: `AssignProcessToJobObject returned failure for pid ${pid} (GetLastError=${lastErrorSafe(k32)})`,
    })
  }
  // Caveat (Spike I): assign races the child spawning its own descendants —
  // no CREATE_SUSPENDED is reachable from Bun's spawn. Callers that need to
  // know the whole tree is owned should re-read `activeProcesses()` rather
  // than assume this success means every descendant is in yet.
  return null
}

function activeProcesses(k32: Kernel32, jobHandle: Pointer): ProcessTreeError | number {
  const acctBuf = new Uint8Array(BASIC_ACCOUNTING_INFO_SIZE)
  const retLenBuf = new Uint32Array(1)
  const result = (() => {
    try {
      return k32.symbols.QueryInformationJobObject(
        jobHandle,
        JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
        ptr(acctBuf),
        acctBuf.length,
        ptr(retLenBuf),
      )
    } catch (cause) {
      return new ProcessTreeError({
        reason: `QueryInformationJobObject failed: ${describeFailure(cause)}`,
        cause: asError(cause),
      })
    }
  })()
  if (result instanceof ProcessTreeError) return result
  if (result === 0) {
    return new ProcessTreeError({
      reason: `QueryInformationJobObject returned failure (GetLastError=${lastErrorSafe(k32)})`,
    })
  }
  return new DataView(acctBuf.buffer).getUint32(ACTIVE_PROCESSES_OFFSET, true)
}

function terminate(k32: Kernel32, jobHandle: Pointer): ProcessTreeError | null {
  const result = (() => {
    try {
      return k32.symbols.TerminateJobObject(jobHandle, TERMINATE_EXIT_CODE)
    } catch (cause) {
      return new ProcessTreeError({
        reason: `TerminateJobObject failed: ${describeFailure(cause)}`,
        cause: asError(cause),
      })
    }
  })()
  if (result instanceof ProcessTreeError) return result
  if (result === 0) {
    return new ProcessTreeError({
      reason: `TerminateJobObject returned failure (GetLastError=${lastErrorSafe(k32)})`,
    })
  }
  return null
}

function buildTreeFromHandles(k32: Kernel32, jobHandle: Pointer): ProcessTree {
  return {
    adopt: (pid: number) => adopt(k32, jobHandle, pid),
    activeProcesses: () => activeProcesses(k32, jobHandle),
    terminate: () => terminate(k32, jobHandle),
    // Kill-on-close (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) fires for any
    // survivor once this, the last handle to the job, is released — the
    // crash-safety net described in Spike I FINDINGS.md Step 4a-ii.
    close: () => closeHandleQuietly(k32, jobHandle),
  }
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
    return new ProcessTreeError({ reason: "Job Object requires win32" })
  }

  const k32 = (() => {
    try {
      return openKernel32()
    } catch (cause) {
      return new ProcessTreeError({
        reason: `dlopen kernel32 failed: ${describeFailure(cause)}`,
        cause: asError(cause),
      })
    }
  })()
  if (k32 instanceof ProcessTreeError) return k32

  const jobHandle = (() => {
    try {
      return k32.symbols.CreateJobObjectW(null, null)
    } catch (cause) {
      return new ProcessTreeError({
        reason: `CreateJobObjectW failed: ${describeFailure(cause)}`,
        cause: asError(cause),
      })
    }
  })()
  if (jobHandle instanceof ProcessTreeError) return jobHandle
  if (jobHandle === null) {
    return new ProcessTreeError({ reason: `CreateJobObjectW returned a null handle (GetLastError=${lastErrorSafe(k32)})` })
  }

  const limitInfo = buildExtendedLimitInfo()
  const setInfoResult = (() => {
    try {
      return k32.symbols.SetInformationJobObject(
        jobHandle,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        ptr(limitInfo),
        limitInfo.length,
      )
    } catch (cause) {
      return new ProcessTreeError({
        reason: `SetInformationJobObject failed: ${describeFailure(cause)}`,
        cause: asError(cause),
      })
    }
  })()
  if (setInfoResult instanceof ProcessTreeError) {
    // The job exists but has no kill-on-close limit and no owner to close it —
    // release it here or the handle leaks for the life of the process.
    closeHandleQuietly(k32, jobHandle)
    return setInfoResult
  }
  if (setInfoResult === 0) {
    closeHandleQuietly(k32, jobHandle)
    return new ProcessTreeError({
      reason: `SetInformationJobObject(kill-on-close) returned failure (GetLastError=${lastErrorSafe(k32)})`,
    })
  }

  return buildTreeFromHandles(k32, jobHandle)
}
