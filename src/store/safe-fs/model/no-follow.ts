import fs from "node:fs"
import path from "node:path"
import * as errore from "errore"

import { FsGuardUnavailableError, isReparsePoint } from "infrastructure/fs-guard"
import type { ManagedRoot, ManagedRootKind, NoFollowDeps, SafeFsError, SafeFsStat, SafeProjectFs, SafeProjectFsDeps } from "../types"
import { IdentityChangedError, checkManagedDirectory, checkManagedLeaf, identityKey } from "./leaf-identity"
import { NAMESPACE_LIMITS, StorageLimitExceededError, classifyNamespace } from "./limits"
import { detectNameCollisions, validateRelativePath } from "./path-rules"

/** A filesystem call failed. `code` is the errno symbol (`ENOENT`, `EACCES`, …) when the host supplied one. */
export class FsAccessError extends errore.createTaggedError({
  name: "FsAccessError",
  message: "filesystem $op failed for $path ($code)",
}) {}

/**
 * A path component is a symbolic link, junction, mount-point redirect, or any other
 * Windows reparse tag (turn-durability §5.1). The walk refuses to descend rather than
 * following it — this is the guard that fires first on a planted junction.
 */
export class ReparsePointRejectedError extends errore.createTaggedError({
  name: "ReparsePointRejectedError",
  message: "refusing to follow $component: it is a reparse point inside the managed root $root",
}) {}

/**
 * A resolved path escapes the opened root. Spike F step 5 verified that a naive
 * `join(root, rel)` does NOT catch this — the joined string still looks like it is inside
 * the root — and that the check which works is `realpathSync(joined)` compared against
 * `realpathSync(root)`, not against the raw root string.
 */
export class PathEscapeError extends errore.createTaggedError({
  name: "PathEscapeError",
  message: "$relPath resolves to $resolved, which escapes the managed root $root",
}) {}

/** True when an `FsAccessError` reports a missing path — the tail of a create target. */
export function isNotFound(error: FsAccessError): boolean {
  return error.code === "ENOENT" || error.code === "ENOTDIR"
}

/** Wrap a thrown filesystem rejection as a value, preserving the errno symbol. */
export function accessError(op: string, absPath: string, cause: unknown): FsAccessError {
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String((cause as { code: unknown }).code) : "UNKNOWN"
  return new FsAccessError({ op, path: absPath, code, cause })
}

/** Project a `bigint` stat onto the §5.2 fact set the safety checks read. */
export function toSafeFsStat(stats: fs.BigIntStats): SafeFsStat {
  return {
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    isSymbolicLink: stats.isSymbolicLink(),
    isSpecial: stats.isFIFO() || stats.isSocket() || stats.isCharacterDevice() || stats.isBlockDevice(),
    nlink: Number(stats.nlink),
    dev: stats.dev,
    ino: stats.ino,
    size: Number(stats.size),
    mtimeNs: stats.mtimeNs,
  }
}

/** The real Node/Bun bindings for the no-follow walk and the reads a `SafeProjectFs` performs. */
export function nodeSafeFsDeps(): SafeProjectFsDeps {
  return {
    lstat: (absPath) =>
      errore.try({
        try: () => toSafeFsStat(fs.lstatSync(absPath, { bigint: true })),
        catch: (cause) => accessError("lstat", absPath, cause),
      }),
    realpath: (absPath) =>
      errore.try({ try: () => fs.realpathSync(absPath), catch: (cause) => accessError("realpath", absPath, cause) }),
    readdir: (absPath) =>
      errore.try({ try: () => fs.readdirSync(absPath), catch: (cause) => accessError("readdir", absPath, cause) }),
    readFile: (absPath) =>
      errore.try({
        try: () => new Uint8Array(fs.readFileSync(absPath)),
        catch: (cause) => accessError("readFile", absPath, cause),
      }),
    readRange: (absPath, start, end) =>
      errore.try({
        try: () => {
          const length = end - start
          const buffer = Buffer.alloc(length)
          const fd = fs.openSync(absPath, "r")
          try {
            let readTotal = 0
            while (readTotal < length) {
              const readNow = fs.readSync(fd, buffer, readTotal, length - readTotal, start + readTotal)
              if (readNow === 0) break // EOF before the requested length — the post-read identity/size recheck catches a stale caller-side stat.
              readTotal += readNow
            }
            return new Uint8Array(buffer.subarray(0, readTotal))
          } finally {
            fs.closeSync(fd)
          }
        },
        catch: (cause) => accessError("readRange", absPath, cause),
      }),
    isReparsePoint,
  }
}

/**
 * Windows path comparison is case-insensitive; POSIX is not. Folding only on win32 keeps
 * a POSIX root that legitimately differs by case from being treated as a prefix match.
 */
function comparablePath(absPath: string): string {
  return process.platform === "win32" ? absPath.toLowerCase() : absPath
}

/**
 * The Spike F escape check: resolve the candidate path and require the result to equal the
 * root's OWN resolved path or start with it plus a separator. Both sides go through
 * `realpath` — the root itself could be a link, so comparing against the raw root string
 * is not sound.
 *
 * A path that does not exist yet is checked at its deepest existing ancestor, since a
 * create target cannot be resolved before it is created.
 */
export function assertWithinRoot(input: {
  rootReal: string
  absPath: string
  deps: Pick<NoFollowDeps, "realpath">
}): PathEscapeError | FsAccessError | null {
  const resolved = input.deps.realpath(input.absPath)
  if (resolved instanceof Error) {
    if (!isNotFound(resolved)) return resolved
    const parent = path.dirname(input.absPath)
    if (parent === input.absPath) return resolved
    return assertWithinRoot({ ...input, absPath: parent })
  }

  const root = comparablePath(input.rootReal)
  const target = comparablePath(resolved)
  if (target === root || target.startsWith(root + path.sep)) return null
  return new PathEscapeError({ relPath: input.absPath, resolved, root: input.rootReal })
}

/**
 * Open a managed root (turn-durability §5): confirm it exists, is an ordinary directory
 * and not a reparse point, then record its resolved path and filesystem identity. Every
 * later resolution is anchored at the resolved path and re-checks the identity, so a root
 * swapped underneath the process is caught rather than followed.
 */
export function openManagedRoot(input: {
  kind: ManagedRootKind
  path: string
  deps: NoFollowDeps
}): ManagedRoot | SafeFsError {
  const stat = input.deps.lstat(input.path)
  if (stat instanceof Error) return stat

  const rejected = checkManagedDirectory(input.path, stat)
  if (rejected instanceof Error) return rejected

  const reparse = checkReparsePoint(input.path, input.path, input.deps)
  if (reparse instanceof Error) return reparse

  const realPath = input.deps.realpath(input.path)
  if (realPath instanceof Error) return realPath

  return { kind: input.kind, realPath, identity: identityKey(stat) }
}

/**
 * The tag-agnostic reparse-point rejection (Spike F). `FsGuardUnavailableError` means the
 * host is not Windows, where `lstat().isSymbolicLink` — already checked by the caller —
 * plus the realpath escape check are complete; any other FFI failure is propagated.
 */
function checkReparsePoint(
  absPath: string,
  root: string,
  deps: Pick<NoFollowDeps, "isReparsePoint">,
): ReparsePointRejectedError | FsAccessError | null {
  const reparse = deps.isReparsePoint(absPath)
  if (reparse instanceof Error) {
    if (FsGuardUnavailableError.is(reparse)) return null
    return accessError("getFileAttributes", absPath, reparse)
  }
  if (reparse) return new ReparsePointRejectedError({ component: absPath, root })
  return null
}

/**
 * Resolve a managed relative path against an opened root with no-follow semantics
 * (turn-durability §5.1). In order: the pure §5.1 grammar check, the root identity
 * re-check, a per-component `lstat` + reparse rejection walking down from the root, and
 * finally the Spike F realpath escape check. A component that does not exist ends the
 * walk — the remaining components are a create target.
 *
 * Both guards are kept even though either would catch a planted junction on its own: the
 * component walk refuses before any read, and the realpath comparison covers reparse tags
 * the walk's attribute query might not classify.
 */
export function resolveManagedPath(input: {
  root: ManagedRoot
  relPath: string
  deps: NoFollowDeps
}): string | SafeFsError {
  const components = validateRelativePath(input.relPath)
  if (components instanceof Error) return components

  const rootStat = input.deps.lstat(input.root.realPath)
  if (rootStat instanceof Error) return rootStat
  if (identityKey(rootStat) !== input.root.identity) {
    return new IdentityChangedError({
      path: input.root.realPath,
      reason: `the managed root moved from ${input.root.identity} to ${identityKey(rootStat)}`,
    })
  }

  const walked = walkComponents(input.root, components, input.deps)
  if (walked instanceof Error) return walked

  const absPath = path.join(input.root.realPath, ...components)
  const escaped = assertWithinRoot({ rootReal: input.root.realPath, absPath, deps: input.deps })
  if (escaped instanceof Error) return escaped

  return absPath
}

/** Walk each component from the root, rejecting reparse points and non-directory intermediates. */
function walkComponents(root: ManagedRoot, components: readonly string[], deps: NoFollowDeps): SafeFsError | null {
  let prefix = root.realPath
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index]
    if (component === undefined) continue
    prefix = path.join(prefix, component)

    const stat = deps.lstat(prefix)
    if (stat instanceof Error) {
      // The tail does not exist yet: nothing further can be followed, so the walk stops
      // and the escape check runs against the deepest existing ancestor.
      if (isNotFound(stat)) return null
      return stat
    }
    if (stat.isSymbolicLink) return new ReparsePointRejectedError({ component: prefix, root: root.realPath })

    const reparse = checkReparsePoint(prefix, root.realPath, deps)
    if (reparse instanceof Error) return reparse

    const isIntermediate = index < components.length - 1
    if (isIntermediate) {
      const rejected = checkManagedDirectory(prefix, stat)
      if (rejected instanceof Error) return rejected
    }
  }
  return null
}

/**
 * The mandatory managed-filesystem capability (turn-durability §5), rooted at an opened
 * root rather than a string join. Callers pass only relative paths; every read goes
 * through the §5.1 grammar, the no-follow walk, the escape check, the §5.2 type rules, and
 * the §5.3 per-file limit before a byte is returned.
 */
export function createSafeProjectFs(root: ManagedRoot, deps: SafeProjectFsDeps): SafeProjectFs {
  function resolve(relPath: string): SafeFsError | string {
    return resolveManagedPath({ root, relPath, deps })
  }

  return {
    root,
    resolve,

    readFile(relPath) {
      const namespace = classifyNamespace(root.kind, relPath)
      if (namespace instanceof Error) return namespace

      const absPath = resolve(relPath)
      if (absPath instanceof Error) return absPath

      const stat = deps.lstat(absPath)
      if (stat instanceof Error) return stat

      const rejected = checkManagedLeaf(absPath, stat)
      if (rejected instanceof Error) return rejected

      // §5.3: existing oversized managed data is a named error, never a silent truncation.
      const allowed = NAMESPACE_LIMITS[namespace].perFileBytes
      if (stat.size > allowed) {
        return new StorageLimitExceededError({
          limit: `${namespace} per-file`,
          path: relPath,
          measured: stat.size,
          allowed,
        })
      }

      const bytes = deps.readFile(absPath)
      if (bytes instanceof Error) return bytes

      const after = deps.lstat(absPath)
      if (after instanceof Error) return after
      const drifted = checkIdentityStable(absPath, stat, after)
      if (drifted instanceof Error) return drifted

      return bytes
    },

    stat(relPath) {
      const namespace = classifyNamespace(root.kind, relPath)
      if (namespace instanceof Error) return namespace

      const absPath = resolve(relPath)
      if (absPath instanceof Error) return absPath

      const stat = deps.lstat(absPath)
      if (stat instanceof Error) return stat

      const rejected = checkManagedLeaf(absPath, stat)
      if (rejected instanceof Error) return rejected

      return { size: stat.size }
    },

    readRange(relPath, start, end) {
      const namespace = classifyNamespace(root.kind, relPath)
      if (namespace instanceof Error) return namespace

      const absPath = resolve(relPath)
      if (absPath instanceof Error) return absPath

      const stat = deps.lstat(absPath)
      if (stat instanceof Error) return stat

      const rejected = checkManagedLeaf(absPath, stat)
      if (rejected instanceof Error) return rejected

      // §5.3: a range read never admits more than the namespace's own per-file ceiling —
      // same rule `readFile` enforces on the whole file.
      const allowed = NAMESPACE_LIMITS[namespace].perFileBytes
      if (end > allowed) {
        return new StorageLimitExceededError({ limit: `${namespace} per-file`, path: relPath, measured: end, allowed })
      }
      // The requested range must already exist — a caller's stale stat (the file shrank
      // since it last observed a length) is an identity drift, not silently clamped.
      if (end > stat.size) {
        return new IdentityChangedError({ path: absPath, reason: `requested range end ${end} exceeds the file's current size ${stat.size}` })
      }

      const bytes = deps.readRange(absPath, start, end)
      if (bytes instanceof Error) return bytes

      // Only the identity (dev/ino) is rechecked, not the size: unlike `readFile`, a bounded
      // range read of an immutable already-validated prefix legitimately tolerates the file
      // having GROWN (an append) between the two stats — only a REPLACED file is a problem.
      const after = deps.lstat(absPath)
      if (after instanceof Error) return after
      if (stat.dev !== after.dev || stat.ino !== after.ino) {
        return new IdentityChangedError({ path: absPath, reason: "the leaf's filesystem identity changed while it was being read" })
      }

      return bytes
    },

    list(relDir) {
      const absPath = relDir === "" ? root.realPath : resolve(relDir)
      if (absPath instanceof Error) return absPath

      const stat = deps.lstat(absPath)
      if (stat instanceof Error) return stat
      const rejected = checkManagedDirectory(absPath, stat)
      if (rejected instanceof Error) return rejected

      const names = deps.readdir(absPath)
      if (names instanceof Error) return names

      const collision = detectNameCollisions(relDir, names)
      if (collision instanceof Error) return collision

      return names
    },
  }
}

/** §5.2's "identity changes between validation and use", narrowed to the read path. */
function checkIdentityStable(absPath: string, before: SafeFsStat, after: SafeFsStat): IdentityChangedError | null {
  if (before.dev === after.dev && before.ino === after.ino && before.size === after.size) return null
  return new IdentityChangedError({ path: absPath, reason: "the leaf changed while it was being read" })
}
