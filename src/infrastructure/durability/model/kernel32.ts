import { FFIType, dlopen, suffix } from "bun:ffi";

import * as errore from "errore";

import { DurabilityUnavailableError } from "./errors";

// Win32 constants used by the durable-flush primitive (Spike G, verbatim).
export const GENERIC_WRITE = 0x40000000;
export const FILE_SHARE_READ = 0x1;
export const FILE_SHARE_WRITE = 0x2;
export const OPEN_EXISTING = 3;
export const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;

// `GetDriveTypeW` return codes.
export const DRIVE_UNKNOWN = 0;
export const DRIVE_NO_ROOT_DIR = 1;
export const DRIVE_REMOVABLE = 2;
export const DRIVE_FIXED = 3;
export const DRIVE_REMOTE = 4;
export const DRIVE_CDROM = 5;
export const DRIVE_RAMDISK = 6;

const DRIVE_TYPE_NAMES: Record<number, string> = {
  [DRIVE_UNKNOWN]: "DRIVE_UNKNOWN",
  [DRIVE_NO_ROOT_DIR]: "DRIVE_NO_ROOT_DIR",
  [DRIVE_REMOVABLE]: "DRIVE_REMOVABLE",
  [DRIVE_FIXED]: "DRIVE_FIXED",
  [DRIVE_REMOTE]: "DRIVE_REMOTE",
  [DRIVE_CDROM]: "DRIVE_CDROM",
  [DRIVE_RAMDISK]: "DRIVE_RAMDISK",
};

/** Human-readable `GetDriveTypeW` code for diagnostics. */
export function driveTypeName(code: number): string {
  return DRIVE_TYPE_NAMES[code] ?? `DRIVE_${code}`;
}

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
  FlushFileBuffers: { args: [FFIType.ptr], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
  GetDriveTypeW: { args: [FFIType.ptr], returns: FFIType.u32 },
} as const;

/** The loaded `kernel32.dll` binding — the callable Win32 symbols above. */
export type Kernel32 = ReturnType<typeof dlopen<typeof KERNEL32_SYMBOLS>>;

let cached: Kernel32 | DurabilityUnavailableError | null = null;

/**
 * Lazily `dlopen` `kernel32.dll` once and cache it. On a non-Windows host the
 * `kernel32.${suffix}` name cannot resolve and `dlopen` throws — the only place
 * a raw boundary `try` is warranted — so it is wrapped into a value. Callers
 * check `instanceof Error` and fail closed.
 */
export function loadKernel32(): Kernel32 | DurabilityUnavailableError {
  if (cached !== null) return cached;
  cached = errore.try({
    try: () => dlopen(`kernel32.${suffix}`, KERNEL32_SYMBOLS),
    catch: (cause) => new DurabilityUnavailableError({ reason: cause.message, cause }),
  });
  return cached;
}

/**
 * UTF-16LE, NUL-terminated buffer for a Win32 `LPCWSTR` argument (Spike G: the
 * `*W` APIs need wide strings, not `bun:ffi`'s narrow `cstring`). Passed directly
 * as a `TypedArray` to the FFI pointer parameter, which `bun:ffi` pins for the
 * call, so the caller never juggles a raw `ptr()`.
 */
export function toWideString(str: string): Buffer {
  return Buffer.from(str + "\0", "utf16le");
}

/**
 * `INVALID_HANDLE_VALUE` is `(void*)-1`. `bun:ffi` surfaces a returned pointer as
 * `number | bigint | null` depending on magnitude (Spike G handled all three),
 * so every representation of all-ones is treated as the failure sentinel.
 */
export function isInvalidHandle(handle: number | bigint | null): boolean {
  if (handle === null) return true;
  if (typeof handle === "bigint") return handle === 0xffffffffffffffffn;
  return handle === -1;
}
