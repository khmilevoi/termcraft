import fs from "node:fs"
import path from "node:path"
import * as errore from "errore"
import { z } from "zod"

import { rfc3339UtcSchema } from "infrastructure/clock"
import { durableFileWrite } from "infrastructure/durability"
import { formatFsIdentity } from "infrastructure/fs-guard"
import { canonicalUuidv7Schema, isCanonicalUuidv7 } from "infrastructure/uuid"

import type { AbsPath, GitIdentity, Sha256Hex, TrustFsDeps, TrustStore, TrustStoreDeps, TrustSubject } from "../types"
import { canonicalizeRepoRelativePath, canonicalizeTrustPath, trustSubjectKey } from "./subject"

// ---- errors -------------------------------------------------------------------

/**
 * The subject could not be built: the project root would not resolve, its filesystem
 * identity was unreadable, or the `projectId` is not a canonical lowercase UUIDv7. A
 * subject is never guessed or partially filled — an unbuildable subject means the caller
 * cannot make a trust decision, which keeps the project untrusted/read-only (§8).
 */
export class TrustSubjectError extends errore.createTaggedError({
  name: "TrustSubjectError",
  message: "cannot build the trust subject for $root: $detail",
}) {}

/** The machine-local ledger under `{userStateRoot}` could not be created or written. */
export class TrustLedgerError extends errore.createTaggedError({
  name: "TrustLedgerError",
  message: "trust ledger $operation failed for $path: $detail",
}) {}

// ---- ledger layout ------------------------------------------------------------

/**
 * The ledger lives under `{userStateRoot}`, outside every project (storage-identity §4):
 * a repository can copy a `projectId` but cannot copy a grant.
 *
 * JUDGMENT CALL (§4/§8 gap): §4 says only "the machine trust ledger owned by TrustStore
 * under {userStateRoot}" and fixes no filename. This implementation stores one file per
 * granted subject at `{userStateRoot}/trust/<trustKey>.json`. Rationale: the trust key is
 * already a 64-character lowercase-hex filename-safe digest, one file per grant needs no
 * read-modify-write of a shared list (so two termcraft processes cannot lose each other's
 * grant), and a single small file suits the durable atomic install of §4.2.
 */
const TRUST_LEDGER_DIR = "trust"

export function trustLedgerDir(userStateRoot: AbsPath): AbsPath {
  return path.join(userStateRoot, TRUST_LEDGER_DIR)
}

export function trustGrantPath(userStateRoot: AbsPath, key: Sha256Hex): AbsPath {
  return path.join(trustLedgerDir(userStateRoot), `${key}.json`)
}

/**
 * A grant record is a handful of short strings. JUDGMENT CALL (§8 fixes no bound): 8 KiB
 * is refused unread, mirroring the bounded advisory read of `store/lease`, so a hostile
 * or runaway file in the ledger directory cannot be buffered.
 */
const MAX_GRANT_BYTES = 8192

const gitIdentitySchema = z.object({
  canonicalGitCommonDir: z.string().min(1),
  gitCommonDirFilesystemIdentity: z.string().min(1),
  // Empty when the project IS the worktree root — §8 encodes that as a length-0 field.
  projectPathRelativeToWorktreeRoot: z.string(),
})

/**
 * The persisted grant. It stores the COMPLETE subject rather than the key alone so
 * `isGranted` can re-derive the key from the record's own fields: a record whose fields
 * no longer digest to the key it is filed under is tampered or corrupt and grants nothing.
 */
const grantRecordSchema = z.object({
  // storage-identity §12: "other JSON uses `schemaVersion`" — the trust ledger's grant
  // record is a plain JSON file, neither TOML nor JSONL, so it follows that rule rather than
  // the JSONL-header `formatVersion` name (minor finding #4's `trust-store.ts` half).
  schemaVersion: z.literal(1),
  key: z.string().regex(/^[0-9a-f]{64}$/),
  canonicalProjectPath: z.string().min(1),
  projectFilesystemIdentity: z.string().min(1),
  projectId: canonicalUuidv7Schema,
  git: gitIdentitySchema.nullable(),
  grantedAt: rfc3339UtcSchema,
})

// ---- the production filesystem wiring -------------------------------------------

/** `ENOENT` is the ordinary "never granted" case, not a fault. */
function isMissingFile(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT"
}

/**
 * The real bindings. `realpathSync.native` — not the JS `realpathSync` — is what returns
 * the true on-disk casing on Windows, which §8 requires the canonical path to preserve;
 * the identity string and the durable install come from the domain-free
 * `infrastructure/` ring.
 */
export const nodeTrustFsDeps: TrustFsDeps = {
  realpath(absPath) {
    return errore.try({
      try: () => fs.realpathSync.native(absPath),
      catch: (cause) => new TrustSubjectError({ root: absPath, detail: "path could not be resolved", cause }),
    })
  },

  fsIdentity(absPath) {
    return formatFsIdentity(absPath)
  },

  ensureDir(absDir) {
    return errore.try({
      try: () => {
        fs.mkdirSync(absDir, { recursive: true })
        return undefined
      },
      catch: (cause) => new TrustLedgerError({ operation: "mkdir", path: absDir, detail: "directory unavailable", cause }),
    })
  },

  readFile(absPath) {
    const bytes = errore.try({
      try: () => {
        const stat = fs.statSync(absPath)
        if (!stat.isFile()) return null
        if (stat.size > MAX_GRANT_BYTES) {
          console.warn("trust: grant refused, record exceeds", MAX_GRANT_BYTES, "bytes:", absPath)
          return null
        }
        return new Uint8Array(fs.readFileSync(absPath))
      },
      catch: (cause) => new TrustLedgerError({ operation: "read", path: absPath, detail: "record unreadable", cause }),
    })
    if (bytes instanceof Error && isMissingFile(bytes.cause)) return null
    return bytes
  },

  durableWrite(absPath, bytes) {
    return durableFileWrite(absPath, bytes)
  },
}

// ---- subject assembly -----------------------------------------------------------

/**
 * Canonicalize the caller-supplied `GitIdentity` textually (§8). The caller has already
 * resolved the common dir and read its identity string — this only pins the canonical
 * spelling so two spellings of one repository cannot split the subject.
 */
function canonicalizeGitIdentity(git: GitIdentity): GitIdentity {
  return {
    canonicalGitCommonDir: canonicalizeTrustPath(git.canonicalGitCommonDir),
    gitCommonDirFilesystemIdentity: git.gitCommonDirFilesystemIdentity,
    projectPathRelativeToWorktreeRoot: canonicalizeRepoRelativePath(git.projectPathRelativeToWorktreeRoot),
  }
}

/** Decode a stored grant, returning `null` for every "this does not grant" outcome. */
function decodeGrantRecord(bytes: Uint8Array, grantPath: AbsPath) {
  const parsed = errore.try({
    try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    catch: (cause) => new TrustLedgerError({ operation: "decode", path: grantPath, detail: "not valid JSON", cause }),
  })
  if (parsed instanceof Error) {
    console.warn("trust: grant record ignored:", parsed.message)
    return null
  }

  const decoded = grantRecordSchema.safeParse(parsed)
  if (!decoded.success) {
    console.warn("trust: grant record ignored:", `${grantPath} is not a schema-1 grant record`)
    return null
  }
  return decoded.data
}

// ---- the store ------------------------------------------------------------------

/**
 * The machine-local `TrustStore` (storage-identity §8). A grant is keyed by the SHA-256 of
 * the complete `TrustSubjectV1` encoding, so moving or copying the project, replacing the
 * directory at the same path, changing `projectId`, creating or replacing its Git
 * repository, or moving it within a worktree all require a new decision — while `HEAD`,
 * ref, commit, rebase, and index values, which the subject deliberately excludes, do not.
 * Two path aliases resolving to the same filesystem object collapse to one subject.
 *
 * `isGranted` never fails open: a missing, unreadable, corrupt, or tampered record is
 * `false`, and the failure is logged rather than swallowed.
 */
export function createTrustStore(deps: TrustStoreDeps): TrustStore {
  return {
    async buildSubject(root: AbsPath, projectId: string, git: GitIdentity | null) {
      if (!isCanonicalUuidv7(projectId)) {
        return new TrustSubjectError({ root, detail: "projectId is not a canonical lowercase UUIDv7" })
      }

      const resolved = deps.fs.realpath(root)
      if (resolved instanceof Error) {
        return new TrustSubjectError({ root, detail: "path could not be resolved", cause: resolved })
      }

      const identity = deps.fs.fsIdentity(resolved)
      if (identity instanceof Error) {
        return new TrustSubjectError({ root, detail: "filesystem identity could not be read", cause: identity })
      }

      const input = {
        canonicalProjectPath: canonicalizeTrustPath(resolved),
        projectFilesystemIdentity: identity,
        projectId,
        git: git === null ? null : canonicalizeGitIdentity(git),
      }
      const subject: TrustSubject = { ...input, key: trustSubjectKey(input) }
      return subject
    },

    async isGranted(subject: TrustSubject) {
      const grantPath = trustGrantPath(deps.userStateRoot, subject.key)

      const bytes = deps.fs.readFile(grantPath)
      if (bytes instanceof Error) {
        // Never propagated: an unreadable ledger means "no grant to honor", not a grant.
        console.warn("trust: grant read failed:", bytes.message)
        return false
      }
      if (bytes === null) return false

      const record = decodeGrantRecord(bytes, grantPath)
      if (record === null) return false

      // Re-derive the key from the record's OWN fields: a record filed under one key whose
      // contents digest to another has been tampered with and grants nothing.
      const derived = trustSubjectKey(record)
      if (derived !== record.key || derived !== subject.key) {
        console.warn("trust: grant record ignored:", `${grantPath} does not derive its own trust key`)
        return false
      }
      return true
    },

    async grant(subject: TrustSubject) {
      const ledgerDir = trustLedgerDir(deps.userStateRoot)
      const created = deps.fs.ensureDir(ledgerDir)
      if (created instanceof Error) {
        return new TrustLedgerError({ operation: "mkdir", path: ledgerDir, detail: created.message, cause: created })
      }

      const record = {
        schemaVersion: 1,
        key: subject.key,
        canonicalProjectPath: subject.canonicalProjectPath,
        projectFilesystemIdentity: subject.projectFilesystemIdentity,
        projectId: subject.projectId,
        git: subject.git,
        grantedAt: deps.clock.now().toISOString(),
      }
      const grantPath = trustGrantPath(deps.userStateRoot, subject.key)
      const bytes = new TextEncoder().encode(`${JSON.stringify(record)}\n`)

      const wrote = deps.fs.durableWrite(grantPath, bytes)
      if (wrote instanceof Error) {
        return new TrustLedgerError({ operation: "write", path: grantPath, detail: wrote.message, cause: wrote })
      }
      return undefined
    },
  }
}
