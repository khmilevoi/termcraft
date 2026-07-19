// Domain-free Windows durability primitives (Spike G,
// `docs/spikes/07-durability-primitive/FINDINGS.md`): the directory-flush
// write-through equivalent of `fsync(dirfd)`, the atomic six-step file install,
// and the pre-flight volume gate. The ProjectStore transaction engine
// (storage-identity §10, turn-durability §4) composes these into recoverable
// multi-file operations; this ring knows nothing about pages, chats, or journals.
export type { DurabilityError } from "./types"
export {
  DirectoryFlushError,
  DurabilityUnavailableError,
  DurableWriteError,
  UnsupportedVolumeError,
} from "./model/errors"
export { flushDir } from "./model/flush-dir"
export { durableFileWrite } from "./model/durable-write"
export { assertDurableVolume, getDriveType, isDurableDriveType } from "./model/volume"
export {
  DRIVE_CDROM,
  DRIVE_FIXED,
  DRIVE_NO_ROOT_DIR,
  DRIVE_RAMDISK,
  DRIVE_REMOTE,
  DRIVE_REMOVABLE,
  DRIVE_UNKNOWN,
  driveTypeName,
} from "./model/kernel32"
