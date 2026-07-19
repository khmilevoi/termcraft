import { FileAttributesError, type FsGuardUnavailableError } from "./errors"
import { FILE_ATTRIBUTE_REPARSE_POINT, INVALID_FILE_ATTRIBUTES, loadKernel32, toWideString } from "./kernel32"

/**
 * True iff `absPath` is a reparse point (junction, symlink, cloud placeholder, or any
 * other reparse tag) via `GetFileAttributesW` + `FILE_ATTRIBUTE_REPARSE_POINT` (Spike F).
 * This is the tag-agnostic backstop the storage design mandates for the no-follow
 * writable-parent check: `lstatSync().isSymbolicLink()` catches NTFS junctions on this
 * runtime but is not a documented guarantee for every reparse tag. A path that cannot be
 * queried (`INVALID_FILE_ATTRIBUTES`) returns a `FileAttributesError`; a non-Windows host
 * returns a `FsGuardUnavailableError` and the caller uses the cross-platform realpath check.
 */
export function isReparsePoint(absPath: string): boolean | FileAttributesError | FsGuardUnavailableError {
  const k32 = loadKernel32()
  if (k32 instanceof Error) return k32
  const attrs = k32.symbols.GetFileAttributesW(toWideString(absPath))
  if (attrs === INVALID_FILE_ATTRIBUTES) {
    return new FileAttributesError({ path: absPath, lastError: k32.symbols.GetLastError() })
  }
  return (attrs & FILE_ATTRIBUTE_REPARSE_POINT) !== 0
}
