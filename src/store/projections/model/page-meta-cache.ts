// `page-meta-cache.ts` — the rebuildable page-metadata projection (storage-identity §7).
// Portable state never carries extracted page metadata; the key is exactly
// `(pageSlug, sourceHash, extractorVersion)`, and a HIT requires every field to match —
// a mismatched, malformed, missing, or generation-stale entry is a MISS, never an
// error, and this store never falls back to a different source hash. Re-extraction and
// replacement is the caller's job; this file only persists/retrieves the exact-key
// entry atomically (`infrastructure/durability`'s temp-write -> verify -> rename ->
// flush-dir install is the only write path). Hard-excluded from Git: this store never
// writes a portable path, and the Git-side exclusion is enforced elsewhere
// (`store/toml`'s generated `.gitignore`, the Git scope planner).
//
// No quota or eviction here: unlike `DiagnosticsStore` (128 MiB) and the render cache
// (512 MiB), §7 states no size bound for this store — an entry is simply replaced
// atomically on every miss, and old content-hash-keyed entries are left for a future
// maintenance sweep rather than actively evicted.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import * as errore from "errore"
import { z } from "zod"

import type { Clock } from "infrastructure/clock"
import { rfc3339UtcSchema } from "infrastructure/clock"
import { durableFileWrite } from "infrastructure/durability"

import type { AbsPath, PageMetaEntry, PageMetaKey, ProjectionFsDeps, Sha256Hex } from "../types"

// ---- errors -----------------------------------------------------------------------

/** The store's own local I/O failed — never returned for a missing/malformed entry, which is a plain miss. */
export class PageMetaCacheIoError extends errore.createTaggedError({
  name: "PageMetaCacheIoError",
  message: "page-meta cache $operation failed for $path: $detail",
}) {}

// ---- generation ---------------------------------------------------------------------

/**
 * Bumped on a page-meta schema or extractor-contract change (projections §4:
 * "projection schema changes are handled by a store-generation bump and rebuild rather
 * than an in-place migration"). Every entry stamps the generation it was written under;
 * a mismatch at read time is a miss, and the next `put` re-stamps the current
 * generation — no portable write is ever involved in that rebuild.
 */
export const PAGE_META_CACHE_GENERATION = 1

// ---- envelope -----------------------------------------------------------------------

const pageMetaKeySchema = z.object({
  pageSlug: z.string().min(1),
  sourceHash: z.string().min(1),
  extractorVersion: z.number().int(),
})

const pageMetaValueSchema = z.object({
  kitApiVersion: z.number().int(),
  title: z.string(),
  minSize: z.object({ w: z.number().int().positive(), h: z.number().int().positive() }),
  theme: z.string(),
})

const envelopeSchema = z.object({
  envelopeVersion: z.literal(1),
  storeGeneration: z.number().int(),
  key: pageMetaKeySchema,
  value: pageMetaValueSchema,
  writtenAt: rfc3339UtcSchema,
  valueSha256: z.string().regex(/^[0-9a-f]{64}$/),
})

function sha256Hex(bytes: Uint8Array): Sha256Hex {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

/**
 * Every field in fixed order, space-separated. A space cannot appear in `pageSlug`
 * (`entities/page`'s mask), `sourceHash` (lowercase hex), or a stringified integer
 * version, so no field's content can forge a boundary between the others.
 */
function canonicalKeyString(key: PageMetaKey): string {
  return [key.pageSlug, key.sourceHash, String(key.extractorVersion)].join(" ")
}

/** Content-addressed by the key: changing ANY ONE field yields a different path — automatically a miss. */
function keyHash(key: PageMetaKey): Sha256Hex {
  return sha256Hex(new TextEncoder().encode(canonicalKeyString(key)))
}

function entryPath(root: AbsPath, key: PageMetaKey): AbsPath {
  return path.join(root, `${keyHash(key)}.json`)
}

function sameKey(a: PageMetaKey, b: PageMetaKey): boolean {
  return canonicalKeyString(a) === canonicalKeyString(b)
}

function valueChecksum(value: unknown): Sha256Hex {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(value)))
}

// ---- production filesystem wiring ------------------------------------------------

/** `ENOENT` is the ordinary "not present" case, not a fault. */
function isMissingFile(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT"
}

/** The real bindings. `infrastructure/durability`'s `durableFileWrite` is the only write path. */
export const nodePageMetaCacheFsDeps: ProjectionFsDeps = {
  readFile(absPath) {
    const bytes = errore.try({
      try: () => new Uint8Array(fs.readFileSync(absPath)),
      catch: (cause) => new PageMetaCacheIoError({ operation: "read", path: absPath, detail: String(cause), cause }),
    })
    if (bytes instanceof Error) return isMissingFile(bytes.cause) ? null : bytes
    return bytes
  },
  durableWrite(absPath, bytes) {
    return durableFileWrite(absPath, bytes)
  },
  remove(absPath) {
    return errore.try({
      try: () => {
        fs.rmSync(absPath, { force: true })
        return undefined
      },
      catch: (cause) => new PageMetaCacheIoError({ operation: "remove", path: absPath, detail: String(cause), cause }),
    })
  },
  listFiles(absDir) {
    const names = errore.try({
      try: () => fs.readdirSync(absDir),
      catch: (cause) => new PageMetaCacheIoError({ operation: "list", path: absDir, detail: String(cause), cause }),
    })
    if (names instanceof Error) return isMissingFile(names.cause) ? [] : names
    return names
  },
  ensureDir(absDir) {
    return errore.try({
      try: () => {
        fs.mkdirSync(absDir, { recursive: true })
        return undefined
      },
      catch: (cause) => new PageMetaCacheIoError({ operation: "mkdir", path: absDir, detail: String(cause), cause }),
    })
  },
}

// ---- the store ----------------------------------------------------------------------

export interface PageMetaCacheDeps {
  /** The cache directory, e.g. `.termcraft/cache/page-meta` — never a portable path. */
  readonly root: AbsPath
  readonly fs: ProjectionFsDeps
  readonly clock: Clock
  /** Test-only override to exercise a generation bump; defaults to {@link PAGE_META_CACHE_GENERATION}. */
  readonly storeGeneration?: number
}

export interface PageMetaCache {
  /** A HIT only on an exact `(pageSlug, sourceHash, extractorVersion)` match (§7). */
  get(key: PageMetaKey): Promise<PageMetaCacheIoError | PageMetaEntry | null>
  /** Atomic replace; never mutates portable state. */
  put(entry: PageMetaEntry): Promise<PageMetaCacheIoError | undefined>
}

export function createPageMetaCache(deps: PageMetaCacheDeps): PageMetaCache {
  const generation = deps.storeGeneration ?? PAGE_META_CACHE_GENERATION

  return {
    async get(key) {
      const target = entryPath(deps.root, key)
      const bytes = deps.fs.readFile(target)
      if (bytes instanceof Error) return new PageMetaCacheIoError({ operation: "read", path: target, detail: bytes.message, cause: bytes })
      if (bytes === null) return null

      const parsed = errore.try({
        try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
        catch: (cause) => new Error("not valid JSON", { cause }),
      })
      if (parsed instanceof Error) {
        console.warn("page-meta-cache: entry ignored (miss):", target, parsed.message)
        return null
      }

      const decoded = envelopeSchema.safeParse(parsed)
      if (!decoded.success) {
        console.warn("page-meta-cache: entry ignored (miss):", target, "does not match the envelope schema")
        return null
      }
      const envelope = decoded.data

      if (envelope.storeGeneration !== generation) {
        console.warn("page-meta-cache: entry ignored (miss):", target, `store generation ${envelope.storeGeneration} !== ${generation}`)
        return null
      }
      if (!sameKey(envelope.key, key)) {
        console.warn("page-meta-cache: entry ignored (miss):", target, "key mismatch (hash collision or tampering)")
        return null
      }
      if (valueChecksum(envelope.value) !== envelope.valueSha256) {
        console.warn("page-meta-cache: entry ignored (miss):", target, "checksum mismatch")
        return null
      }

      return { key: envelope.key, meta: envelope.value }
    },

    async put(entry) {
      const created = deps.fs.ensureDir(deps.root)
      if (created instanceof Error) return new PageMetaCacheIoError({ operation: "mkdir", path: deps.root, detail: created.message, cause: created })

      const envelope = {
        envelopeVersion: 1 as const,
        storeGeneration: generation,
        key: entry.key,
        value: entry.meta,
        writtenAt: deps.clock.now().toISOString(),
        valueSha256: valueChecksum(entry.meta),
      }
      const target = entryPath(deps.root, entry.key)
      const wrote = deps.fs.durableWrite(target, new TextEncoder().encode(JSON.stringify(envelope)))
      if (wrote instanceof Error) return new PageMetaCacheIoError({ operation: "write", path: target, detail: wrote.message, cause: wrote })
      return undefined
    },
  }
}
