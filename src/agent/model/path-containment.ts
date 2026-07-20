import path from "node:path"

/**
 * True only when `candidate` resolves to a location inside `stagingRoot`
 * (master §6.1 confinement; Spike H). Uses path normalization + a boundary-safe
 * prefix test (a trailing separator prevents `workspace-evil` from matching
 * `workspace`). The optional `hasReparsePoint` backstop rejects a junction/
 * reparse point on the path (Spike F: `isSymbolicLink()` alone is insufficient
 * on Windows); production injects the `GetFileAttributesW` FFI check.
 *
 * DIVERGENCE from the plan's reference body: `path.resolve` does NOT normalize
 * drive-letter case on win32 (verified against the installed Bun:
 * `path.resolve("c:\\x") !== path.resolve("C:\\x")`), yet NTFS paths are
 * case-insensitive, so a bare case-sensitive prefix test would wrongly reject
 * an in-staging path whose drive letter differs only in case. On win32 both
 * operands are lower-cased before the prefix test; POSIX platforms keep the
 * plan's case-sensitive comparison unchanged (POSIX filesystems are typically
 * case-sensitive).
 */
export function isInsideStaging(
  candidate: string,
  stagingRoot: string,
  options?: { hasReparsePoint?: (p: string) => boolean },
): boolean {
  const root = path.resolve(stagingRoot)
  const target = path.resolve(candidate)
  const isWin = process.platform === "win32"
  const rootCompare = isWin ? root.toLowerCase() : root
  const targetCompare = isWin ? target.toLowerCase() : target
  if (targetCompare !== rootCompare) {
    const withSep = rootCompare.endsWith(path.sep) ? rootCompare : rootCompare + path.sep
    if (!targetCompare.startsWith(withSep)) return false
  }
  if (options?.hasReparsePoint?.(target) === true) return false
  return true
}
