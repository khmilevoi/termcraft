import * as errore from "errore";

/**
 * The reparse-point backstop is a Windows `bun:ffi` call into `kernel32.dll` (Spike F,
 * `docs/spikes/06-win-fs-identity/FINDINGS.md`). When the library cannot be loaded — a
 * non-Windows host — the check returns this and the caller falls back to the
 * cross-platform `realpath` escape check.
 */
export class FsGuardUnavailableError extends errore.createTaggedError({
  name: "FsGuardUnavailableError",
  message: "reparse-point FFI is unavailable on this platform: $reason",
}) {}

/** `GetFileAttributesW` could not query the path (`INVALID_FILE_ATTRIBUTES`); `lastError` is the Win32 code. */
export class FileAttributesError extends errore.createTaggedError({
  name: "FileAttributesError",
  message: "could not read file attributes of $path (Win32 error $lastError)",
}) {}

/** The filesystem identity of a path could not be read (`statSync` failed). */
export class FsIdentityError extends errore.createTaggedError({
  name: "FsIdentityError",
  message: "could not read the filesystem identity of $path",
}) {}
