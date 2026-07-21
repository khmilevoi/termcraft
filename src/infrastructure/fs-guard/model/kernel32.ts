import { FFIType, dlopen, suffix } from "bun:ffi";

import * as errore from "errore";

import { FsGuardUnavailableError } from "./errors";

/** `FILE_ATTRIBUTE_REPARSE_POINT` — the bit set on junctions, symlinks, and other reparse points (Spike F). */
export const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;

/** `GetFileAttributesW`'s error sentinel (`(DWORD)-1`), returned when the path cannot be queried. */
export const INVALID_FILE_ATTRIBUTES = 0xffffffff;

const KERNEL32_SYMBOLS = {
  GetFileAttributesW: { args: [FFIType.ptr], returns: FFIType.u32 },
  GetLastError: { args: [], returns: FFIType.u32 },
} as const;

/** The loaded `kernel32.dll` binding for the reparse-point attribute query. */
export type Kernel32 = ReturnType<typeof dlopen<typeof KERNEL32_SYMBOLS>>;

let cached: Kernel32 | FsGuardUnavailableError | null = null;

/**
 * Lazily `dlopen` `kernel32.dll` once for `GetFileAttributesW` (Spike F's tag-agnostic
 * reparse backstop). On a non-Windows host the load throws — the one boundary `try` —
 * and is returned as a value; the caller then relies on the cross-platform `realpath`
 * escape check instead. A separate small binding from `infrastructure/durability` keeps
 * the two fs concerns decoupled.
 */
export function loadKernel32(): Kernel32 | FsGuardUnavailableError {
  if (cached !== null) return cached;
  cached = errore.try({
    try: () => dlopen(`kernel32.${suffix}`, KERNEL32_SYMBOLS),
    catch: (cause) => new FsGuardUnavailableError({ reason: cause.message, cause }),
  });
  return cached;
}

/** UTF-16LE, NUL-terminated buffer for a Win32 `LPCWSTR` argument (Spike F/G). */
export function toWideString(str: string): Buffer {
  return Buffer.from(str + "\0", "utf16le");
}
