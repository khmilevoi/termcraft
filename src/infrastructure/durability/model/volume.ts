import path from "node:path"
import { type DurabilityUnavailableError, UnsupportedVolumeError } from "./errors"
import { DRIVE_FIXED, DRIVE_RAMDISK, driveTypeName, loadKernel32, toWideString } from "./kernel32"

/**
 * The raw `GetDriveTypeW` code for the volume that holds `rootPath` (which must
 * be a volume root such as `C:\`). Returns a `DurabilityUnavailableError` when
 * the FFI is unavailable.
 */
export function getDriveType(rootPath: string): number | DurabilityUnavailableError {
  const k32 = loadKernel32()
  if (k32 instanceof Error) return k32
  return k32.symbols.GetDriveTypeW(toWideString(rootPath))
}

/**
 * The volume-type acceptance rule (Spike G): only `DRIVE_FIXED` and `DRIVE_RAMDISK`
 * can be trusted for durable writes. `DRIVE_REMOTE`, `DRIVE_UNKNOWN`,
 * `DRIVE_NO_ROOT_DIR`, `DRIVE_REMOVABLE`, and `DRIVE_CDROM` are refused. Pure, so
 * the gate is exhaustively testable without a non-local volume.
 */
export function isDurableDriveType(code: number): boolean {
  return code === DRIVE_FIXED || code === DRIVE_RAMDISK
}

/**
 * The cheap pre-flight volume gate (Spike G): reject a path on a volume that
 * cannot be trusted for durable writes before any mutation is attempted. This is a
 * heuristic about the volume, not proof the flush primitive works on it — the
 * store composes it with a real `flushDir` probe on its own transaction directory.
 */
export function assertDurableVolume(anyPath: string): UnsupportedVolumeError | DurabilityUnavailableError | undefined {
  const root = path.parse(path.resolve(anyPath)).root
  const type = getDriveType(root)
  if (type instanceof Error) return type
  if (!isDurableDriveType(type)) {
    return new UnsupportedVolumeError({ path: anyPath, driveType: driveTypeName(type) })
  }
  return undefined
}
