import * as errore from "errore"

/**
 * The durable-flush primitive is a Windows `bun:ffi` call into `kernel32.dll`
 * (Spike G, `docs/spikes/07-durability-primitive/FINDINGS.md`). If the library
 * cannot be loaded — a non-Windows host, or a `dlopen` failure — every durability
 * operation returns this rather than throwing, so the caller fails closed on an
 * unsupported platform instead of silently skipping the flush.
 */
export class DurabilityUnavailableError extends errore.createTaggedError({
  name: "DurabilityUnavailableError",
  message: "durable-flush FFI is unavailable on this platform: $reason",
}) {}

/**
 * A directory flush did not complete. `lastError` is the raw Win32
 * `GetLastError()` code (Spike G: `5` ERROR_ACCESS_DENIED for a wrong access
 * mode, `1` ERROR_INVALID_FUNCTION on a volume with no write-through support).
 * A committed record's LF is only durable once its containing directory flush
 * succeeds, so a failed flush is never treated as a durable write.
 */
export class DirectoryFlushError extends errore.createTaggedError({
  name: "DirectoryFlushError",
  message: "failed to durably flush directory $path (Win32 error $lastError)",
}) {}

/**
 * A path lives on a volume that cannot demonstrate the durability primitives the
 * project store requires (storage-identity §4). Spike G's cheap first gate:
 * `GetDriveTypeW` rejects `DRIVE_REMOTE`/`DRIVE_UNKNOWN`/`DRIVE_NO_ROOT_DIR`
 * before any mutation is attempted. termcraft refuses project mutations here
 * rather than downgrading durability silently.
 */
export class UnsupportedVolumeError extends errore.createTaggedError({
  name: "UnsupportedVolumeError",
  message: "path $path is on an unsupported volume ($driveType); durable writes are refused",
}) {}

/**
 * The six-step atomic install (storage-identity §4.2 / turn-durability §4.2) did
 * not complete. `step` names the failed stage (`create`, `write`, `verify`,
 * `rename`, `flush`, `confirm`) so a partial install is diagnosable; the caller
 * treats the target as unchanged.
 */
export class DurableWriteError extends errore.createTaggedError({
  name: "DurableWriteError",
  message: "durable write to $path failed at step $step",
}) {}
