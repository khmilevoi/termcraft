import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import * as errore from "errore"

import type { ManagedNamespace, ManagedRoot, NoFollowDeps, SafeFsError, SafeFsStat } from "../types"
import { checkIdentityUnchanged, checkManagedDirectory, checkManagedLeaf, detectDuplicateIdentity } from "./leaf-identity"
import { type LimitBudget, classifyNamespace, createLimitBudget } from "./limits"
import { type FsAccessError, accessError, nodeSafeFsDeps, resolveManagedPath, toSafeFsStat } from "./no-follow"
import { detectNameCollisions, validateRelativePath } from "./path-rules"

/**
 * turn-durability §5.4: the source changed between the moment its identity was recorded
 * and the moment the copy was accepted. The candidate is discarded — a partially copied
 * tree is never handed to a consumer.
 */
export class WorkspaceChangedDuringSnapshotError extends errore.createTaggedError({
  name: "WorkspaceChangedDuringSnapshotError",
  message: "workspace_changed_during_snapshot at $path: $reason",
}) {}

/** A source opened exactly once (§5.4); every read and every identity check goes through it. */
export interface SourceHandle {
  /** Identity + metadata read from the OPEN handle, not re-resolved from the path. */
  stat(): SafeFsStat | FsAccessError
  /** The next chunk, or `null` at end of file. */
  read(): Uint8Array | null | FsAccessError
  close(): void
}

/** A create-new destination file. Failing to be create-new is a failure, never an overwrite. */
export interface CandidateSink {
  write(chunk: Uint8Array): FsAccessError | undefined
  close(): FsAccessError | undefined
}

/** An incremental digest, fed while streaming so the bytes are hashed exactly once. */
export interface IncrementalHash {
  update(chunk: Uint8Array): void
  digestHex(): string
}

export interface CandidateDeps extends NoFollowDeps {
  readdir(absPath: string): readonly string[] | FsAccessError
  openSource(absPath: string): SourceHandle | FsAccessError
  /** Create the candidate root; fails if anything already occupies the path. */
  mkdirNew(absPath: string): FsAccessError | undefined
  mkdirAll(absPath: string): FsAccessError | undefined
  createNewSink(absPath: string): CandidateSink | FsAccessError
  createHash(): IncrementalHash
  removeTree(absPath: string): void
}

export interface CandidateFile {
  readonly relPath: string
  readonly namespace: ManagedNamespace
  readonly sha256: string
  readonly size: number
}

export interface CandidateSnapshot {
  readonly root: string
  readonly files: readonly CandidateFile[]
  readonly totalBytes: number
}

/** 64 KiB — large enough that the syscall cost disappears, small enough to bound resident memory. */
const CHUNK_BYTES = 64 * 1024

/** One validated source leaf, carrying the identity recorded during enumeration. */
interface SourceEntry {
  readonly relPath: string
  readonly components: readonly string[]
  readonly absPath: string
  readonly namespace: ManagedNamespace
  readonly stat: SafeFsStat
}

/** The real Node/Bun bindings for the candidate copy. */
export function nodeCandidateDeps(): CandidateDeps {
  const base = nodeSafeFsDeps()
  return {
    ...base,

    openSource(absPath) {
      const fd = errore.try({ try: () => fs.openSync(absPath, "r"), catch: (cause) => accessError("open", absPath, cause) })
      if (fd instanceof Error) return fd

      const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
      return {
        stat: () =>
          errore.try({
            try: () => toSafeFsStat(fs.fstatSync(fd, { bigint: true })),
            catch: (cause) => accessError("fstat", absPath, cause),
          }),
        read: () =>
          errore.try({
            try: () => {
              const read = fs.readSync(fd, buffer, 0, buffer.length, null)
              // The buffer is reused across reads, so the chunk must be copied out.
              return read === 0 ? null : new Uint8Array(buffer.subarray(0, read))
            },
            catch: (cause) => accessError("read", absPath, cause),
          }),
        close: () => {
          const closed = errore.try({ try: () => fs.closeSync(fd), catch: (cause) => accessError("close", absPath, cause) })
          if (closed instanceof Error) console.warn("safe-fs: source close failed:", closed.message)
        },
      }
    },

    mkdirNew(absPath) {
      // Non-recursive on purpose: `mkdirSync` without `recursive` fails with EEXIST when
      // anything already occupies the path, which is what makes the candidate create-new.
      const made = errore.try({
        try: () => fs.mkdirSync(absPath),
        catch: (cause) => accessError("mkdir", absPath, cause),
      })
      return made instanceof Error ? made : undefined
    },

    mkdirAll(absPath) {
      const made = errore.try({
        try: () => fs.mkdirSync(absPath, { recursive: true }),
        catch: (cause) => accessError("mkdir", absPath, cause),
      })
      return made instanceof Error ? made : undefined
    },

    createNewSink(absPath) {
      const fd = errore.try({ try: () => fs.openSync(absPath, "wx"), catch: (cause) => accessError("create", absPath, cause) })
      if (fd instanceof Error) return fd
      return {
        write: (chunk) => {
          const wrote = errore.try({
            try: () => fs.writeSync(fd, chunk),
            catch: (cause) => accessError("write", absPath, cause),
          })
          return wrote instanceof Error ? wrote : undefined
        },
        close: () => {
          const closed = errore.try({ try: () => fs.closeSync(fd), catch: (cause) => accessError("close", absPath, cause) })
          return closed instanceof Error ? closed : undefined
        },
      }
    },

    createHash() {
      const hasher = crypto.createHash("sha256")
      return { update: (chunk) => void hasher.update(chunk), digestHex: () => hasher.digest("hex") }
    },

    removeTree(absPath) {
      const removed = errore.try({
        try: () => fs.rmSync(absPath, { recursive: true, force: true }),
        catch: (cause) => accessError("rm", absPath, cause),
      })
      if (removed instanceof Error) console.warn("safe-fs: candidate cleanup failed:", removed.message)
    },
  }
}

/**
 * Walk one directory of the source tree, validating every entry against §5.1 (grammar,
 * name collisions), §5.1's no-follow rule, §5.2 (type and link rules), §5.3 (limits before
 * allocation), and §5.4 (the allowed inventory). Entries are collected, not copied — a
 * single violation anywhere aborts the enumeration before the copy phase begins.
 *
 * The walk returns its own inventory rather than filling a caller-owned array, so an
 * aborted enumeration yields the error alone — never a half-populated inventory the
 * caller has to remember to discard.
 */
function enumerateDirectory(input: {
  source: ManagedRoot
  relDir: string
  deps: CandidateDeps
  budget: LimitBudget
}): SafeFsError | SourceEntry[] {
  const absDir = input.relDir === "" ? input.source.realPath : path.join(input.source.realPath, ...input.relDir.split("/"))

  const names = input.deps.readdir(absDir)
  if (names instanceof Error) return names

  const collision = detectNameCollisions(input.relDir, names)
  if (collision instanceof Error) return collision

  const entries: SourceEntry[] = []
  for (const name of [...names].sort()) {
    const relPath = input.relDir === "" ? name : `${input.relDir}/${name}`
    const components = validateRelativePath(relPath)
    if (components instanceof Error) return components

    // Resolving through `resolveManagedPath` is what makes every candidate entry pass the
    // same no-follow walk and realpath escape check as any other managed path — the
    // enumeration never gets its own weaker guard.
    const absPath = resolveManagedPath({ root: input.source, relPath, deps: input.deps })
    if (absPath instanceof Error) return absPath

    const stat = input.deps.lstat(absPath)
    if (stat instanceof Error) return stat

    if (stat.isDirectory) {
      const rejected = checkManagedDirectory(absPath, stat)
      if (rejected instanceof Error) return rejected
      const descended = enumerateDirectory({ ...input, relDir: relPath })
      if (descended instanceof Error) return descended
      // Appended one at a time, not spread: the `project` and `backup` roots carry no
      // §5.3 file-count ceiling, so a deep tree could otherwise exceed the argument limit.
      for (const entry of descended) entries.push(entry)
      continue
    }

    const rejected = checkManagedLeaf(absPath, stat)
    if (rejected instanceof Error) return rejected

    const namespace = classifyNamespace(input.source.kind, relPath)
    if (namespace instanceof Error) return namespace

    const admitted = input.budget.admitFile({
      relPath,
      namespace,
      declaredSize: stat.size,
      depth: components.length,
    })
    if (admitted instanceof Error) return admitted

    entries.push({ relPath, components, absPath, namespace, stat })
  }
  return entries
}

/**
 * Copy one validated source into the candidate: open the source ONCE, confirm the open
 * handle reports the identity recorded at enumeration, hash while streaming to a
 * create-new destination, then recheck the source identity and metadata before accepting
 * the copy (turn-durability §5.4). Limits are re-checked against the bytes that actually
 * arrive, which is what catches a source that grew after it was stat-ed.
 */
function copyEntry(input: {
  entry: SourceEntry
  destPath: string
  deps: CandidateDeps
  budget: LimitBudget
}): SafeFsError | CandidateFile {
  const handle = input.deps.openSource(input.entry.absPath)
  if (handle instanceof Error) return handle
  const outcome = streamThroughHandle({ ...input, handle })
  handle.close()
  return outcome
}

function streamThroughHandle(input: {
  entry: SourceEntry
  destPath: string
  deps: CandidateDeps
  budget: LimitBudget
  handle: SourceHandle
}): SafeFsError | CandidateFile {
  const { entry, handle } = input

  const before = handle.stat()
  if (before instanceof Error) return before
  const swapped = checkIdentityUnchanged(entry.relPath, entry.stat, before)
  if (swapped instanceof Error) {
    return new WorkspaceChangedDuringSnapshotError({ path: entry.relPath, reason: swapped.reason })
  }

  const sink = input.deps.createNewSink(input.destPath)
  if (sink instanceof Error) return sink

  const hash = input.deps.createHash()
  let copied = 0
  for (;;) {
    const chunk = handle.read()
    if (chunk instanceof Error) return closeThen(sink, chunk)
    if (chunk === null) break

    copied += chunk.byteLength
    const overflow = input.budget.observeBytes({ relPath: entry.relPath, namespace: entry.namespace, bytesSoFar: copied })
    if (overflow instanceof Error) return closeThen(sink, overflow)

    hash.update(chunk)
    const wrote = sink.write(chunk)
    if (wrote instanceof Error) return closeThen(sink, wrote)
  }

  const closed = sink.close()
  if (closed instanceof Error) return closed

  const after = handle.stat()
  if (after instanceof Error) return after
  const drifted = checkIdentityUnchanged(entry.relPath, before, after)
  if (drifted instanceof Error) {
    return new WorkspaceChangedDuringSnapshotError({ path: entry.relPath, reason: drifted.reason })
  }
  if (copied !== before.size) {
    return new WorkspaceChangedDuringSnapshotError({
      path: entry.relPath,
      reason: `copied ${copied} bytes but the source reported ${before.size}`,
    })
  }

  return { relPath: entry.relPath, namespace: entry.namespace, sha256: hash.digestHex(), size: copied }
}

/** Close a sink whose copy already failed and propagate the original failure. */
function closeThen(sink: CandidateSink, error: SafeFsError): SafeFsError {
  const closed = sink.close()
  if (closed instanceof Error) console.warn("safe-fs: candidate sink close failed:", closed.message)
  return error
}

/**
 * Produce the immutable candidate of turn-durability §5.4: enumerate the entire source
 * tree, validate every entry, and only then copy it while hashing into a create-new
 * destination outside the source.
 *
 * Validation is complete BEFORE the destination is created, so a hostile workspace passes
 * exactly zero bytes to any consumer — the Gate never sees a candidate that failed
 * filesystem safety. A failure after the destination exists discards the whole candidate;
 * a partial tree is never left behind for a consumer to find.
 */
export function snapshotToCandidate(input: {
  source: ManagedRoot
  destRoot: string
  deps: CandidateDeps
}): SafeFsError | CandidateSnapshot {
  // §5.4 copies "into a create-new candidate outside the workspace". A destination nested
  // inside the source would make the snapshot enumerate its own output.
  const nested = input.destRoot === input.source.realPath || input.destRoot.startsWith(input.source.realPath + path.sep)
  if (nested) {
    return new WorkspaceChangedDuringSnapshotError({
      path: input.destRoot,
      reason: "the candidate destination must lie outside the source root",
    })
  }

  const budget = createLimitBudget(input.source.kind)

  const entries = enumerateDirectory({ source: input.source, relDir: "", deps: input.deps, budget })
  if (entries instanceof Error) return entries

  const duplicate = detectDuplicateIdentity(entries.map((entry) => ({ path: entry.relPath, stat: entry.stat })))
  if (duplicate instanceof Error) return duplicate

  // Everything below this line may have written bytes, so every exit discards the tree.
  const created = input.deps.mkdirNew(input.destRoot)
  if (created instanceof Error) return created

  const files: CandidateFile[] = []
  for (const entry of entries) {
    const destPath = path.join(input.destRoot, ...entry.components)
    const parent = path.dirname(destPath)
    if (parent !== input.destRoot) {
      const made = input.deps.mkdirAll(parent)
      if (made instanceof Error) return discard(input.deps, input.destRoot, made)
    }

    const copied = copyEntry({ entry, destPath, deps: input.deps, budget })
    if (copied instanceof Error) return discard(input.deps, input.destRoot, copied)
    files.push(copied)
  }

  return { root: input.destRoot, files, totalBytes: files.reduce((sum, file) => sum + file.size, 0) }
}

/** §5.4: "the candidate is discarded" — no consumer may observe a partial snapshot. */
function discard(deps: CandidateDeps, destRoot: string, error: SafeFsError): SafeFsError {
  deps.removeTree(destRoot)
  return error
}
