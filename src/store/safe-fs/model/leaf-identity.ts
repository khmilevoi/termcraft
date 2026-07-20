import * as errore from "errore"

import type { SafeFsStat } from "../types"

/**
 * A managed entry is not the kind of object its namespace allows (turn-durability §5.2):
 * a FIFO, socket, device, sparse redirector, platform-special file, a directory where a
 * leaf was required, or a reparse point anywhere.
 */
export class LeafRejectedError extends errore.createTaggedError({
  name: "LeafRejectedError",
  message: "$path is not a permissible managed entry: $reason",
}) {}

/**
 * §5.2's `unsafe_hardlink`: a managed leaf whose link count is not exactly one, or two
 * paths in one enumerated tree that share a file identity. Either means bytes written
 * through the managed path are observable — or mutable — through a path termcraft does
 * not control.
 */
export class UnsafeHardlinkError extends errore.createTaggedError({
  name: "UnsafeHardlinkError",
  message: "unsafe_hardlink at $path: $reason",
}) {}

/**
 * §5.2's "any component whose identity changes between validation and use". The check is
 * the same one §5.4 runs after a candidate copy; a drift means the object validated is
 * not the object used.
 */
export class IdentityChangedError extends errore.createTaggedError({
  name: "IdentityChangedError",
  message: "$path changed identity between validation and use: $reason",
}) {}

/**
 * The `(dev, ino)` pair as a comparison key. Rendered in hex to keep it stable for the
 * 64-bit Windows file ids Spike F observed (a JS number would truncate them).
 */
export function identityKey(stat: SafeFsStat): string {
  return `${stat.dev.toString(16)}:${stat.ino.toString(16)}`
}

/**
 * §5.2 leaf rules: managed leaves must be ordinary regular files with exactly one link.
 * A reparse point is rejected even when it also stats as a regular file — libuv maps only
 * some reparse tags to a link (Spike F), so `isFile` alone is never sufficient.
 */
export function checkManagedLeaf(path: string, stat: SafeFsStat): LeafRejectedError | UnsafeHardlinkError | null {
  if (stat.isSymbolicLink) return new LeafRejectedError({ path, reason: "it is a symbolic link, junction, or reparse point" })
  if (stat.isSpecial) return new LeafRejectedError({ path, reason: "it is a FIFO, socket, or device" })
  if (stat.isDirectory) return new LeafRejectedError({ path, reason: "it is a directory where a regular file is required" })
  if (!stat.isFile) return new LeafRejectedError({ path, reason: "it is not an ordinary regular file" })
  if (stat.nlink !== 1) return new UnsafeHardlinkError({ path, reason: `link count is ${stat.nlink}, not exactly 1` })
  return null
}

/**
 * §5.2 directory rules: "Directories must not be reparse points". A junction planted as a
 * managed directory is the exact escape vector Spike F demonstrated.
 */
export function checkManagedDirectory(path: string, stat: SafeFsStat): LeafRejectedError | null {
  if (stat.isSymbolicLink) return new LeafRejectedError({ path, reason: "a managed directory may not be a reparse point" })
  if (!stat.isDirectory) return new LeafRejectedError({ path, reason: "it is not a directory" })
  return null
}

/**
 * §5.2: "duplicate file identity within an enumerated tree is rejected as
 * `unsafe_hardlink`". A hardlink pair inside one workspace shares a `(dev, ino)`, which is
 * the only signal `stat` offers (Spike F step 4) — there is no API that names the other
 * path, so comparing identities across the enumerated set is the detection.
 *
 * An `ino` of zero is not a usable identity (some filesystems synthesize it) and is
 * skipped rather than treated as a mass collision.
 */
export function detectDuplicateIdentity(
  entries: readonly { readonly path: string; readonly stat: SafeFsStat }[],
): UnsafeHardlinkError | null {
  const seen = new Map<string, string>()
  for (const entry of entries) {
    if (entry.stat.ino === 0n) continue
    const key = identityKey(entry.stat)
    const first = seen.get(key)
    if (first !== undefined) {
      return new UnsafeHardlinkError({
        path: first,
        reason: `${entry.path} shares its file identity (${key}) — the two names are one file`,
      })
    }
    seen.set(key, entry.path)
  }
  return null
}

/**
 * §5.2/§5.4: confirm an object's identity and metadata did not move between the moment it
 * was validated and the moment it was used. Size and mtime are part of the comparison
 * because a same-inode in-place rewrite is exactly the drift §5.4 must catch.
 */
export function checkIdentityUnchanged(path: string, before: SafeFsStat, after: SafeFsStat): IdentityChangedError | null {
  if (before.dev !== after.dev || before.ino !== after.ino) {
    return new IdentityChangedError({ path, reason: `file identity moved from ${identityKey(before)} to ${identityKey(after)}` })
  }
  if (before.nlink !== after.nlink) {
    return new IdentityChangedError({ path, reason: `link count moved from ${before.nlink} to ${after.nlink}` })
  }
  if (before.size !== after.size) {
    return new IdentityChangedError({ path, reason: `size moved from ${before.size} to ${after.size}` })
  }
  if (before.mtimeNs !== after.mtimeNs) {
    return new IdentityChangedError({ path, reason: `mtime moved from ${before.mtimeNs} to ${after.mtimeNs}` })
  }
  return null
}
