import path from "node:path"

/**
 * True only when `candidate` resolves to a location inside `stagingRoot`
 * (master §6.1 confinement; Spike H). Uses path normalization + a boundary-safe
 * prefix test (a trailing separator prevents `workspace-evil` from matching
 * `workspace`). The optional `hasReparsePoint` backstop rejects a junction/
 * reparse point on ANY path segment from `stagingRoot` down to the resolved
 * leaf (Spike F: `isSymbolicLink()` alone is insufficient on Windows, and a
 * junction can sit on an ancestor directory rather than on the leaf itself —
 * e.g. `<staging>/link -> C:\Users\...` makes `<staging>/link/notes.txt`'s own
 * leaf a perfectly ordinary file); production injects the `GetFileAttributesW`
 * FFI check.
 *
 * A relative `candidate` is resolved against `stagingRoot`, NOT against this
 * process's (termcraft's) cwd. `buildQueryOptions` sets the agent's own cwd to
 * `task.workspacePath` (== `stagingRoot`), so a relative tool path the agent
 * emits — e.g. Grep's `path: "pages"` (Spike H observed the model doing
 * exactly this) — must be interpreted the same way the agent interprets it,
 * not against whatever directory termcraft itself happens to be running from.
 * `path.resolve(root, candidate)` still rejects an absolute `candidate`
 * outside staging: per `path.resolve`'s right-to-left resolution, an absolute
 * `candidate` wins outright and `root` is discarded, so Spike H cases 2/3 stay
 * covered unchanged.
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
  const target = path.resolve(root, candidate)
  const isWin = process.platform === "win32"
  const rootCompare = isWin ? root.toLowerCase() : root
  const targetCompare = isWin ? target.toLowerCase() : target
  if (targetCompare !== rootCompare) {
    const withSep = rootCompare.endsWith(path.sep) ? rootCompare : rootCompare + path.sep
    if (!targetCompare.startsWith(withSep)) return false
  }
  if (options?.hasReparsePoint && hasReparsePointOnChain(root, target, options.hasReparsePoint)) return false
  return true
}

/**
 * Walks every path segment from `root` down to `target` (inclusive of
 * `target` itself), calling `check` on each. A reparse point can sit on an
 * ancestor directory rather than the leaf, so checking only the resolved leaf
 * (as this function used to) misses a junction like `<staging>/link` once the
 * agent addresses a file underneath it, e.g. `<staging>/link/notes.txt` — that
 * leaf is a plain file even though the path escapes staging on disk.
 */
function hasReparsePointOnChain(root: string, target: string, check: (p: string) => boolean): boolean {
  const rel = path.relative(root, target)
  if (rel === "") return check(target)
  const segments = rel.split(path.sep).filter((segment) => segment.length > 0)
  const chain = segments.reduce<string[]>((acc, segment) => {
    const parent = acc.length > 0 ? (acc[acc.length - 1] ?? root) : root
    acc.push(path.join(parent, segment))
    return acc
  }, [])
  return chain.some((segment) => check(segment) === true)
}
