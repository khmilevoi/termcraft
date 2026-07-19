import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import * as errore from "errore"
import { type DirectoryFlushError, type DurabilityUnavailableError, DurableWriteError } from "./errors"
import { flushDir } from "./flush-dir"

/** Best-effort removal of an abandoned temp file; a failure is logged, not propagated. */
function removeTemp(tmpPath: string): void {
  const removed = errore.try({
    try: () => fs.rmSync(tmpPath, { force: true }),
    catch: (cause) => new Error("temp cleanup failed", { cause }),
  })
  if (removed instanceof Error) console.warn("durable-write: temp cleanup failed:", removed.message)
}

/**
 * Reopen the just-written temp file "without following links" and confirm it is a
 * regular file whose bytes match (storage-identity §4.2 step 3/6). Windows has no
 * `O_NOFOLLOW` (Spike G), so the substitute is an `lstat` reparse-point check
 * immediately before the open — a narrow TOCTOU window that Spike G records as a
 * residual risk, not a closed gap.
 */
function verifyReopen(tmpPath: string, targetPath: string, expected: Uint8Array): DurableWriteError | undefined {
  const outcome = errore.try({
    try: () => {
      if (fs.lstatSync(tmpPath).isSymbolicLink()) return "reparse-point"
      const fd = fs.openSync(tmpPath, "r")
      const stat = fs.fstatSync(fd)
      const bytes = fs.readFileSync(fd)
      fs.closeSync(fd)
      if (!stat.isFile()) return "not-a-file"
      if (!Buffer.from(expected).equals(bytes)) return "byte-mismatch"
      return "ok"
    },
    catch: (cause) => new DurableWriteError({ path: targetPath, step: "verify", cause }),
  })
  if (outcome instanceof Error) return outcome
  if (outcome !== "ok") return new DurableWriteError({ path: targetPath, step: "verify" })
  return undefined
}

/**
 * Install `bytes` at `targetPath` durably and atomically — the six-step sequence
 * of storage-identity §4.2 / turn-durability §4.2: create-new temp in the same
 * directory, write + `fsync` + close, reopen-verify, rename over the target
 * (`renameSync` uses `MOVEFILE_REPLACE_EXISTING` on Windows, Spike G), flush the
 * parent directory, then confirm the realized bytes. On any failure the temp file
 * is removed and the target is left unchanged; returns `undefined` on success.
 *
 * Domain-free: it knows nothing about pages, chats, or journals — the ProjectStore
 * transaction engine composes it into a recoverable multi-file operation.
 */
export function durableFileWrite(
  targetPath: string,
  bytes: Uint8Array,
): DurableWriteError | DirectoryFlushError | DurabilityUnavailableError | undefined {
  const dir = path.dirname(targetPath)
  const tmpPath = path.join(dir, `.tmp-${path.basename(targetPath)}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`)

  const fd = errore.try({
    try: () => fs.openSync(tmpPath, "wx"),
    catch: (cause) => new DurableWriteError({ path: targetPath, step: "create", cause }),
  })
  if (fd instanceof Error) return fd

  const wrote = errore.try({
    try: () => {
      fs.writeSync(fd, bytes)
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      return true
    },
    catch: (cause) => new DurableWriteError({ path: targetPath, step: "write", cause }),
  })
  if (wrote instanceof Error) {
    removeTemp(tmpPath)
    return wrote
  }

  const verified = verifyReopen(tmpPath, targetPath, bytes)
  if (verified instanceof Error) {
    removeTemp(tmpPath)
    return verified
  }

  const renamed = errore.try({
    try: () => fs.renameSync(tmpPath, targetPath),
    catch: (cause) => new DurableWriteError({ path: targetPath, step: "rename", cause }),
  })
  if (renamed instanceof Error) {
    removeTemp(tmpPath)
    return renamed
  }

  const flushed = flushDir(dir)
  if (flushed instanceof Error) return flushed

  const confirmed = errore.try({
    try: () => fs.readFileSync(targetPath),
    catch: (cause) => new DurableWriteError({ path: targetPath, step: "confirm", cause }),
  })
  if (confirmed instanceof Error) return confirmed
  if (!Buffer.from(bytes).equals(confirmed)) return new DurableWriteError({ path: targetPath, step: "confirm" })

  return undefined
}
