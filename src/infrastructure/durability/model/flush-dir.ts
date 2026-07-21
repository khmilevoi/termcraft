import { DirectoryFlushError, type DurabilityUnavailableError } from "./errors";
import {
  FILE_FLAG_BACKUP_SEMANTICS,
  FILE_SHARE_READ,
  FILE_SHARE_WRITE,
  GENERIC_WRITE,
  OPEN_EXISTING,
  isInvalidHandle,
  loadKernel32,
  toWideString,
} from "./kernel32";

/**
 * Durably flush a directory's metadata to physical storage — the Windows
 * write-through equivalent of POSIX `fsync(dirfd)` (Spike G verdict). It opens a
 * handle with `CreateFileW(FILE_FLAG_BACKUP_SEMANTICS)` and calls
 * `FlushFileBuffers`. The access mode is `GENERIC_WRITE` **alone**: Spike G found
 * that `GENERIC_READ`, `GENERIC_READ | GENERIC_WRITE`, and `0` all let
 * `CreateFileW` succeed but then fail `FlushFileBuffers` with ERROR_ACCESS_DENIED.
 *
 * Returns `undefined` on success; a `DirectoryFlushError` when the handle or the
 * flush fails; a `DurabilityUnavailableError` when the FFI is unavailable. The
 * caller must treat a preceding rename as durable only after this returns clean.
 */
export function flushDir(
  dirPath: string,
): DirectoryFlushError | DurabilityUnavailableError | undefined {
  const k32 = loadKernel32();
  if (k32 instanceof Error) return k32;

  const handle = k32.symbols.CreateFileW(
    toWideString(dirPath),
    GENERIC_WRITE,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    null,
    OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS,
    null,
  );
  if (isInvalidHandle(handle)) {
    return new DirectoryFlushError({ path: dirPath, lastError: k32.symbols.GetLastError() });
  }

  const flushed = k32.symbols.FlushFileBuffers(handle);
  const lastError = flushed === 0 ? k32.symbols.GetLastError() : 0;
  k32.symbols.CloseHandle(handle);
  if (flushed === 0) return new DirectoryFlushError({ path: dirPath, lastError });
  return undefined;
}
