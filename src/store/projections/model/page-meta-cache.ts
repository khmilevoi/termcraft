// `page-meta-cache.ts` — the rebuildable page-metadata projection (storage-identity §7).
// Portable state never carries extracted page metadata; the key is exactly
// `(pageSlug, closureHash, extractorVersion)`, and a HIT requires every field to match —
// a mismatched, malformed, missing, or generation-stale entry is a MISS, never an
// error, and this store never falls back to a different closure hash. Re-extraction and
// replacement is the caller's job; this file only persists/retrieves the exact-key
// entry atomically (`infrastructure/durability`'s temp-write -> verify -> rename ->
// flush-dir install is the only write path). Hard-excluded from Git: this store never
// writes a portable path, and the Git-side exclusion is enforced elsewhere
// (`store/toml`'s generated `.gitignore`, the Git scope planner).
//
// RE-KEYED FROM `sourceHash` TO `closureHash` (design-tree phase 2 Task 6; design §7's own
// consumer table). READ THIS HONESTLY, BECAUSE IT IS NOT OBVIOUSLY A WIN: §5's `meta`
// extraction (`GateRunner.extractPageMeta`) is strictly literal — it parses the entry file's
// own static `meta` export and nothing else, no imported constant, no shared module — so this
// re-key changes NOTHING about what `extractPageMeta` returns for a given entry, and it fixes
// no invalidation bug for `meta` itself. What it buys is vocabulary consistency: every
// consumer in design §7's table (this cache, the diagnostics store, the export render key,
// smoke selection) now speaks the SAME key shape, `(slug, closureHash, version)`, rather than
// this one cache alone speaking `sourceHash` while the rest of the table speaks closures — and
// it means a FUTURE extractor that reads more than the entry file (a shared `meta` helper, a
// theme import) is keyed correctly from the day it lands, instead of silently caching stale
// meta the way a `sourceHash` key would have. The cost side is real too: a re-extraction (one
// token scan, no compiler, no child process — see `extractPageMeta`'s own doc) runs whenever
// ANYTHING in the page's closure moves, not only when the entry file itself changes.
//
// THE `null` PATH IS OWNED BY THE CALLER, NOT THIS FILE. `closureHashOf` (`core/project`'s
// `readCanonicalTreeIndex`) returns `null` when a page's closure could not be proved complete
// — "cannot compute", never "unchanged". A `null` must NEVER be encoded into a key here (a
// literal `"null"` string would collide two different pages', or two different points in
// time's, unprovable closures onto the SAME cache slot) — so the caller
// (`core/kernel/handlers/preview-export.ts`'s `resolvePageMeta`) skips this store ENTIRELY on
// a `null` closure hash: no `get`, no `put`. This file's own `PageMetaKey.closureHash` is
// therefore always a real, non-null `Sha256Hex` — the type says so, and no caller may construct
// one otherwise.
//
// THE LEDGER ITEM THIS RE-KEY SETTLES: Task 5 left `PageMetaKeyV1` without an `entryRelPath`
// field as an open minor ("what if two different entry paths for the same slug collide?"). It
// cannot happen now, and the reason is `entities/design-tree`'s own `resolveClosure`: a page's
// closure is DEFINED to start at its entry (`const visited = new Set([input.entry])` before any
// edge is walked) and its `files` are exactly that visited set — so `entryRelPath` is ALWAYS a
// member of `files`, and `computeClosureHash` folds every member's `(relPath, sha256)` pair
// (`encodeField(relPath)` first) into the digest. Two different entry paths for the same slug
// therefore fold two different `relPath` strings into the hash and can never collide on this
// key. Verified transitively through the real adapter too, not only the port's own doc: `gate
// /adapters/gate-runner.ts`'s `walkPageClosure` returns `resolved.files` (from `resolveClosure`)
// completely unfiltered as `GateClosureV1.files` — nothing strips or replaces the entry between
// the walk and what `readCanonicalTreeIndex` hashes. CLOSED, not merely asserted.
//
// No quota or eviction here: unlike `DiagnosticsStore` (128 MiB) and the render cache
// (512 MiB), §7 states no size bound for this store — an entry is simply replaced
// atomically on every miss, and old content-hash-keyed entries are left for a future
// maintenance sweep rather than actively evicted.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import * as errore from "errore";
import { z } from "zod";

import type { Clock } from "infrastructure/clock";
import { rfc3339UtcSchema } from "infrastructure/clock";
import { log } from "infrastructure/debug-log";
import { durableFileWrite } from "infrastructure/durability";

import type { AbsPath, PageMetaEntry, PageMetaKey, ProjectionFsDeps, Sha256Hex } from "../types";

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
 *
 * BUMPED 1 -> 2 (design-tree phase 2 Task 6): `PageMetaKey`'s shape itself changed
 * (`sourceHash` -> `closureHash`), so every generation-1 entry's `key.sourceHash` would
 * otherwise decode as an extra/missing field under the new `pageMetaKeySchema` below — the
 * generation bump is what makes that a clean miss-and-rebuild instead of a schema-validation
 * error surfacing where a caller expects only a MISS or a real I/O fault.
 */
export const PAGE_META_CACHE_GENERATION = 2;

// ---- envelope -----------------------------------------------------------------------

const pageMetaKeySchema = z.object({
  pageSlug: z.string().min(1),
  closureHash: z.string().min(1),
  extractorVersion: z.number().int(),
});

const pageMetaValueSchema = z.object({
  kitApiVersion: z.number().int(),
  title: z.string(),
  minSize: z.object({ w: z.number().int().positive(), h: z.number().int().positive() }),
  theme: z.string(),
});

const envelopeSchema = z.object({
  envelopeVersion: z.literal(1),
  storeGeneration: z.number().int(),
  key: pageMetaKeySchema,
  value: pageMetaValueSchema,
  writtenAt: rfc3339UtcSchema,
  valueSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

function sha256Hex(bytes: Uint8Array): Sha256Hex {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Every field in fixed order, space-separated. A space cannot appear in `pageSlug`
 * (`entities/page`'s mask), `closureHash` (lowercase hex), or a stringified integer
 * version, so no field's content can forge a boundary between the others.
 */
function canonicalKeyString(key: PageMetaKey): string {
  return [key.pageSlug, key.closureHash, String(key.extractorVersion)].join(" ");
}

/** Content-addressed by the key: changing ANY ONE field yields a different path — automatically a miss. */
function keyHash(key: PageMetaKey): Sha256Hex {
  return sha256Hex(new TextEncoder().encode(canonicalKeyString(key)));
}

function entryPath(root: AbsPath, key: PageMetaKey): AbsPath {
  return path.join(root, `${keyHash(key)}.json`);
}

function sameKey(a: PageMetaKey, b: PageMetaKey): boolean {
  return canonicalKeyString(a) === canonicalKeyString(b);
}

function valueChecksum(value: unknown): Sha256Hex {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
}

// ---- production filesystem wiring ------------------------------------------------

/** `ENOENT` is the ordinary "not present" case, not a fault. */
function isMissingFile(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT"
  );
}

/** The real bindings. `infrastructure/durability`'s `durableFileWrite` is the only write path. */
export const nodePageMetaCacheFsDeps: ProjectionFsDeps = {
  readFile(absPath) {
    const bytes = errore.try({
      try: () => new Uint8Array(fs.readFileSync(absPath)),
      catch: (cause) =>
        new PageMetaCacheIoError({
          operation: "read",
          path: absPath,
          detail: String(cause),
          cause,
        }),
    });
    if (bytes instanceof Error) return isMissingFile(bytes.cause) ? null : bytes;
    return bytes;
  },
  durableWrite(absPath, bytes) {
    return durableFileWrite(absPath, bytes);
  },
  remove(absPath) {
    return errore.try({
      try: () => {
        fs.rmSync(absPath, { force: true });
        return undefined;
      },
      catch: (cause) =>
        new PageMetaCacheIoError({
          operation: "remove",
          path: absPath,
          detail: String(cause),
          cause,
        }),
    });
  },
  listFiles(absDir) {
    const names = errore.try({
      try: () => fs.readdirSync(absDir),
      catch: (cause) =>
        new PageMetaCacheIoError({ operation: "list", path: absDir, detail: String(cause), cause }),
    });
    if (names instanceof Error) return isMissingFile(names.cause) ? [] : names;
    return names;
  },
  ensureDir(absDir) {
    return errore.try({
      try: () => {
        fs.mkdirSync(absDir, { recursive: true });
        return undefined;
      },
      catch: (cause) =>
        new PageMetaCacheIoError({
          operation: "mkdir",
          path: absDir,
          detail: String(cause),
          cause,
        }),
    });
  },
};

// ---- the store ----------------------------------------------------------------------

export interface PageMetaCacheDeps {
  /** The cache directory, e.g. `.termcraft/cache/page-meta` — never a portable path. */
  readonly root: AbsPath;
  readonly fs: ProjectionFsDeps;
  readonly clock: Clock;
  /** Test-only override to exercise a generation bump; defaults to {@link PAGE_META_CACHE_GENERATION}. */
  readonly storeGeneration?: number;
}

export interface PageMetaCache {
  /** A HIT only on an exact `(pageSlug, closureHash, extractorVersion)` match (§7). */
  get(key: PageMetaKey): Promise<PageMetaCacheIoError | PageMetaEntry | null>;
  /** Atomic replace; never mutates portable state. */
  put(entry: PageMetaEntry): Promise<PageMetaCacheIoError | undefined>;
}

export function createPageMetaCache(deps: PageMetaCacheDeps): PageMetaCache {
  const generation = deps.storeGeneration ?? PAGE_META_CACHE_GENERATION;

  return {
    async get(key) {
      const target = entryPath(deps.root, key);
      const bytes = deps.fs.readFile(target);
      if (bytes instanceof Error)
        return new PageMetaCacheIoError({
          operation: "read",
          path: target,
          detail: bytes.message,
          cause: bytes,
        });
      if (bytes === null) return null;

      const parsed = errore.try({
        try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
        catch: (cause) => new Error("not valid JSON", { cause }),
      });
      if (parsed instanceof Error) {
        log.warn("page-meta-cache: entry ignored (miss):", target, parsed.message);
        return null;
      }

      const decoded = envelopeSchema.safeParse(parsed);
      if (!decoded.success) {
        log.warn(
          "page-meta-cache: entry ignored (miss):",
          target,
          "does not match the envelope schema",
        );
        return null;
      }
      const envelope = decoded.data;

      if (envelope.storeGeneration !== generation) {
        log.warn(
          "page-meta-cache: entry ignored (miss):",
          target,
          `store generation ${envelope.storeGeneration} !== ${generation}`,
        );
        return null;
      }
      if (!sameKey(envelope.key, key)) {
        log.warn(
          "page-meta-cache: entry ignored (miss):",
          target,
          "key mismatch (hash collision or tampering)",
        );
        return null;
      }
      if (valueChecksum(envelope.value) !== envelope.valueSha256) {
        log.warn("page-meta-cache: entry ignored (miss):", target, "checksum mismatch");
        return null;
      }

      return { key: envelope.key, meta: envelope.value };
    },

    async put(entry) {
      const created = deps.fs.ensureDir(deps.root);
      if (created instanceof Error)
        return new PageMetaCacheIoError({
          operation: "mkdir",
          path: deps.root,
          detail: created.message,
          cause: created,
        });

      const envelope = {
        envelopeVersion: 1 as const,
        storeGeneration: generation,
        key: entry.key,
        value: entry.meta,
        writtenAt: deps.clock.now().toISOString(),
        valueSha256: valueChecksum(entry.meta),
      };
      const target = entryPath(deps.root, entry.key);
      const wrote = deps.fs.durableWrite(
        target,
        new TextEncoder().encode(JSON.stringify(envelope)),
      );
      if (wrote instanceof Error)
        return new PageMetaCacheIoError({
          operation: "write",
          path: target,
          detail: wrote.message,
          cause: wrote,
        });
      return undefined;
    },
  };
}
