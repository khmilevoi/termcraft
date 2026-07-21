// `render-cache.ts` — the content-addressed export render cache (projections §10.2).
// The logical key is the canonical serialization of `ExportRenderKey`; `flags` is
// canonicalized with SORTED keys before hashing/comparison, so two callers presenting
// the same flags in different insertion order collide on one entry, as §10.2 requires
// ("`flags` is sorted and canonically encoded"). A hit is accepted only after the
// envelope and every buffer's checksum validate; a corrupt or partial entry is a miss,
// never an error. Entries are written to a temp sibling then renamed into place via
// `infrastructure/durability`'s `durableFileWrite` (create/rename semantics — "either
// identical complete entry is valid" under concurrent writers), with a 512 MiB default
// per-project quota and least-recently-written eviction among entries not pinned by an
// active export.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import * as errore from "errore";
import { z } from "zod";

import { durableFileWrite } from "infrastructure/durability";
import { MiB } from "store/safe-fs";

import type {
  AbsPath,
  ExportRenderKey,
  ProjectionFsDeps,
  RenderEntry,
  RenderPinPredicate,
  Sha256Hex,
} from "../types";

// ---- errors -----------------------------------------------------------------------

/** The store's own local I/O failed — never returned for a missing/malformed entry, which is a plain miss. */
export class RenderCacheIoError extends errore.createTaggedError({
  name: "RenderCacheIoError",
  message: "render cache $operation failed for $path: $detail",
}) {}

// ---- generation + quota -------------------------------------------------------------

/** Bumped on a render-envelope schema change (projections §4). A source/kit/renderer/size/theme/flag change is already a different content key and needs no generation bump. */
export const RENDER_CACHE_GENERATION = 1;

export const RENDER_CACHE_DEFAULT_QUOTA_BYTES = 512 * MiB;
/**
 * The documented configurable range. NOT enforced here: §10.2's "configurable locally
 * from 64 MiB through 4 GiB" is a `workspace.local.toml` resource-limit-override
 * validation rule, which is `store/toml`'s job (plan Wave C T9), not this store's.
 * `quotaBytes` is trusted as already validated by the time it reaches here; these
 * constants exist for that validator (and any caller/test) to reference, and this store
 * applies only the DEFAULT when no override is supplied.
 */
export const RENDER_CACHE_MIN_QUOTA_BYTES = 64 * MiB;
export const RENDER_CACHE_MAX_QUOTA_BYTES = 4096 * MiB;

function resolveQuota(quotaBytes: number | undefined): number {
  return quotaBytes ?? RENDER_CACHE_DEFAULT_QUOTA_BYTES;
}

// ---- canonical key --------------------------------------------------------------

const flagValueSchema = z.union([z.boolean(), z.number(), z.string()]);

const exportRenderKeySchema = z.object({
  sourceHash: z.string().min(1),
  kitApiVersion: z.number().int(),
  rendererVersion: z.string().min(1),
  size: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  theme: z.string().min(1),
  flags: z.record(z.string(), flagValueSchema),
});

function sha256Hex(bytes: Uint8Array): Sha256Hex {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Sorted `[key, value]` pairs — deterministic regardless of the caller's `flags` insertion order (§10.2). */
function sortedFlagEntries(
  flags: Readonly<Record<string, boolean | number | string>>,
): readonly (readonly [string, boolean | number | string])[] {
  return Object.entries(flags).sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The exact §10.2 canonical serialization: every field in fixed order, `flags` reduced
 * to a sorted array so its own key order can never affect the digest.
 */
export function canonicalizeExportRenderKey(key: ExportRenderKey): string {
  return JSON.stringify({
    sourceHash: key.sourceHash,
    kitApiVersion: key.kitApiVersion,
    rendererVersion: key.rendererVersion,
    size: { width: key.size.width, height: key.size.height },
    theme: key.theme,
    flags: sortedFlagEntries(key.flags),
  });
}

/** Content-addressed by the canonical key: changing ANY ONE field yields a different path — automatically a miss. */
function keyHash(key: ExportRenderKey): Sha256Hex {
  return sha256Hex(new TextEncoder().encode(canonicalizeExportRenderKey(key)));
}

function entryPath(root: AbsPath, key: ExportRenderKey): AbsPath {
  return path.join(root, `${keyHash(key)}.json`);
}

function sameKey(a: ExportRenderKey, b: ExportRenderKey): boolean {
  return canonicalizeExportRenderKey(a) === canonicalizeExportRenderKey(b);
}

// ---- envelope ---------------------------------------------------------------------

const bufferEnvelopeSchema = z.object({
  base64: z.string(),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const envelopeSchema = z.object({
  envelopeVersion: z.literal(1),
  storeGeneration: z.number().int(),
  key: exportRenderKeySchema,
  styledFrame: bufferEnvelopeSchema,
  textFrame: bufferEnvelopeSchema,
  layout: bufferEnvelopeSchema,
  writtenAt: z.string(),
});

function encodeBuffer(bytes: Uint8Array) {
  return {
    base64: Buffer.from(bytes).toString("base64"),
    byteLength: bytes.byteLength,
    sha256: sha256Hex(bytes),
  };
}

/** Decode one buffer envelope, verifying its recorded length and checksum — `null` on any mismatch. */
function decodeBuffer(envelope: z.infer<typeof bufferEnvelopeSchema>): Uint8Array | null {
  const bytes = new Uint8Array(Buffer.from(envelope.base64, "base64"));
  if (bytes.byteLength !== envelope.byteLength) return null;
  if (sha256Hex(bytes) !== envelope.sha256) return null;
  return bytes;
}

// ---- production filesystem wiring ------------------------------------------------

function isMissingFile(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT"
  );
}

/** The real bindings. `infrastructure/durability`'s `durableFileWrite` is the only write path. */
export const nodeRenderCacheFsDeps: ProjectionFsDeps = {
  readFile(absPath) {
    const bytes = errore.try({
      try: () => new Uint8Array(fs.readFileSync(absPath)),
      catch: (cause) =>
        new RenderCacheIoError({ operation: "read", path: absPath, detail: String(cause), cause }),
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
        new RenderCacheIoError({
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
        new RenderCacheIoError({ operation: "list", path: absDir, detail: String(cause), cause }),
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
        new RenderCacheIoError({ operation: "mkdir", path: absDir, detail: String(cause), cause }),
    });
  },
};

// ---- quota eviction -----------------------------------------------------------------
//
// Same judgment call as `diagnostics-store.ts` (projections §10.2 names the 512 MiB
// quota and LRU eviction but pins no bookkeeping mechanism): no separate manifest,
// least-recently-WRITTEN order read back from each entry's own envelope, and
// opportunistic cleanup of any entry that fails to parse/validate during the scan.

interface ScannedEntry {
  readonly path: AbsPath;
  readonly key: ExportRenderKey;
  readonly writtenAt: string;
  readonly byteLength: number;
}

function scanEntries(
  root: AbsPath,
  fsDeps: ProjectionFsDeps,
): RenderCacheIoError | readonly ScannedEntry[] {
  const names = fsDeps.listFiles(root);
  if (names instanceof Error)
    return new RenderCacheIoError({
      operation: "list",
      path: root,
      detail: names.message,
      cause: names,
    });

  const entries: ScannedEntry[] = [];
  for (const name of names) {
    const entryFile = path.join(root, name);
    const bytes = fsDeps.readFile(entryFile);
    if (bytes instanceof Error) {
      // A real read failure (permissions, I/O) — not the benign vanished-entry case below.
      // The sweep still proceeds over the remaining entries, so the error must leave a trace.
      console.warn(
        "render-cache: quota sweep skipped an unreadable entry:",
        entryFile,
        bytes.message,
      );
      continue;
    }
    if (bytes === null) continue; // vanished between list and read — not this sweep's problem

    const parsed = errore.try({
      try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
      catch: (cause) => new Error("not valid JSON", { cause }),
    });
    const decoded = parsed instanceof Error ? null : envelopeSchema.safeParse(parsed);
    if (decoded === null || !decoded.success) {
      const removed = fsDeps.remove(entryFile);
      if (removed instanceof Error)
        console.warn("render-cache: corrupt entry cleanup failed:", removed.message);
      continue;
    }
    entries.push({
      path: entryFile,
      key: decoded.data.key,
      writtenAt: decoded.data.writtenAt,
      byteLength: bytes.byteLength,
    });
  }
  return entries;
}

function enforceQuota(input: {
  entries: readonly ScannedEntry[];
  quotaBytes: number;
  keepPath: AbsPath;
  isPinned: RenderPinPredicate;
  fsDeps: ProjectionFsDeps;
}): void {
  const totalBytes = input.entries.reduce((sum, e) => sum + e.byteLength, 0);
  if (totalBytes <= input.quotaBytes) return;

  const evictable = input.entries
    .filter((e) => e.path !== input.keepPath && !input.isPinned(e.key))
    .sort((a, b) => a.writtenAt.localeCompare(b.writtenAt));

  let remaining = totalBytes;
  for (const entry of evictable) {
    if (remaining <= input.quotaBytes) break;
    const removed = input.fsDeps.remove(entry.path);
    if (removed instanceof Error) {
      console.warn("render-cache: eviction failed, leaving entry in place:", removed.message);
      continue;
    }
    remaining -= entry.byteLength;
  }
}

// ---- the store ----------------------------------------------------------------------

export interface RenderCacheDeps {
  /** The render-cache directory, e.g. `.termcraft/cache/export-render` — never a portable path. */
  readonly root: AbsPath;
  readonly fs: ProjectionFsDeps;
  readonly clock: { readonly now: () => Date };
  /** Trusted as pre-validated (§10.2's [64 MiB, 4 GiB] range — `store/toml`'s job); defaults to {@link RENDER_CACHE_DEFAULT_QUOTA_BYTES}. */
  readonly quotaBytes?: number;
  /** §10.2: "not pinned by an active export." Defaults to none pinned. */
  readonly isPinned?: RenderPinPredicate;
  /** Test-only override to exercise a generation bump; defaults to {@link RENDER_CACHE_GENERATION}. */
  readonly storeGeneration?: number;
}

export interface RenderCache {
  /** A HIT only after the envelope and every buffer's checksum validate (§10.2). */
  get(key: ExportRenderKey): Promise<RenderCacheIoError | RenderEntry | null>;
  /** Temp-sibling write then create/rename, then a quota-eviction sweep; never mutates portable state. */
  put(entry: RenderEntry): Promise<RenderCacheIoError | undefined>;
}

export function createRenderCache(deps: RenderCacheDeps): RenderCache {
  const generation = deps.storeGeneration ?? RENDER_CACHE_GENERATION;
  const quotaBytes = resolveQuota(deps.quotaBytes);
  const isPinned = deps.isPinned ?? (() => false);

  return {
    async get(key) {
      const target = entryPath(deps.root, key);
      const bytes = deps.fs.readFile(target);
      if (bytes instanceof Error)
        return new RenderCacheIoError({
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
        console.warn("render-cache: entry ignored (miss):", target, parsed.message);
        return null;
      }

      const decoded = envelopeSchema.safeParse(parsed);
      if (!decoded.success) {
        console.warn(
          "render-cache: entry ignored (miss):",
          target,
          "does not match the envelope schema",
        );
        return null;
      }
      const envelope = decoded.data;

      if (envelope.storeGeneration !== generation) {
        console.warn(
          "render-cache: entry ignored (miss):",
          target,
          `store generation ${envelope.storeGeneration} !== ${generation}`,
        );
        return null;
      }
      if (!sameKey(envelope.key, key)) {
        console.warn(
          "render-cache: entry ignored (miss):",
          target,
          "key mismatch (hash collision or tampering)",
        );
        return null;
      }

      const styledFrame = decodeBuffer(envelope.styledFrame);
      const textFrame = decodeBuffer(envelope.textFrame);
      const layout = decodeBuffer(envelope.layout);
      if (styledFrame === null || textFrame === null || layout === null) {
        console.warn(
          "render-cache: entry ignored (miss):",
          target,
          "a buffer failed its length/checksum verification",
        );
        return null;
      }

      return { key: envelope.key, styledFrame, textFrame, layout };
    },

    async put(entry) {
      const created = deps.fs.ensureDir(deps.root);
      if (created instanceof Error)
        return new RenderCacheIoError({
          operation: "mkdir",
          path: deps.root,
          detail: created.message,
          cause: created,
        });

      const envelope = {
        envelopeVersion: 1 as const,
        storeGeneration: generation,
        key: entry.key,
        styledFrame: encodeBuffer(entry.styledFrame),
        textFrame: encodeBuffer(entry.textFrame),
        layout: encodeBuffer(entry.layout),
        writtenAt: deps.clock.now().toISOString(),
      };
      const target = entryPath(deps.root, entry.key);
      const wrote = deps.fs.durableWrite(
        target,
        new TextEncoder().encode(JSON.stringify(envelope)),
      );
      if (wrote instanceof Error)
        return new RenderCacheIoError({
          operation: "write",
          path: target,
          detail: wrote.message,
          cause: wrote,
        });

      const scanned = scanEntries(deps.root, deps.fs);
      if (scanned instanceof Error) {
        console.warn("render-cache: quota sweep failed:", scanned.message);
        return undefined;
      }
      enforceQuota({ entries: scanned, quotaBytes, keepPath: target, isPinned, fsDeps: deps.fs });
      return undefined;
    },
  };
}
