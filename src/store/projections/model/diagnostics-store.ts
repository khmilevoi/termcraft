// `diagnostics-store.ts` — the current-diagnostics projection (projections §6). Keyed
// exactly `(pageSlug, closureHash, kitApiVersion)` — NO chat id anywhere in the key or
// the entry, because current diagnostics never depend on which chat is active (§6.2:
// "prompt assembly ... never asks the active chat for current warnings"). A hit
// requires every key field to match; a missing/malformed/generation-stale entry is a
// miss, never an error. Entries are written atomically via `infrastructure/durability`
// (temp-write -> verify -> rename -> flush-dir), with a 128 MiB default per-project
// quota and least-recently-written eviction across unpinned keys.
//
// RE-KEYED FROM `sourceHash` TO `closureHash` (design-tree phase 2 Task 7; design §7's own
// consumer table, same key vocabulary as `page-meta-cache.ts`'s Task 6 re-key). READ THIS
// HONESTLY: THIS STORE HAS NO PRODUCTION CALLER TODAY. It is wired at the composition root
// (`entrypoint/model/create-shell.ts`) and never read or written outside its own tests
// (`grep -rn "diagnosticsCache\." src` finds nothing else) — so there is no live
// invalidation defect this re-key fixes, because nothing today can observe one. What it
// buys is correctness AHEAD of a future caller: when something does start calling
// `diagnosticsGet`/`diagnosticsPut`, the key already speaks the same closure-hash
// vocabulary as every other §7 consumer, rather than needing its own separate re-key
// later. The missing caller is its own open ledger item, not something this task claims
// to close.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import * as errore from "errore";
import { z } from "zod";

import type { Clock } from "infrastructure/clock";
import { rfc3339UtcSchema } from "infrastructure/clock";
import { durableFileWrite } from "infrastructure/durability";
import { MiB } from "store/safe-fs";

import type {
  AbsPath,
  DiagnosticsEntry,
  DiagnosticsKey,
  DiagnosticsPinPredicate,
  ProjectionFsDeps,
  Sha256Hex,
} from "../types";

// ---- errors -----------------------------------------------------------------------

/** The store's own local I/O failed — never returned for a missing/malformed entry, which is a plain miss. */
export class DiagnosticsStoreIoError extends errore.createTaggedError({
  name: "DiagnosticsStoreIoError",
  message: "diagnostics store $operation failed for $path: $detail",
}) {}

// ---- generation + quota -------------------------------------------------------------

/**
 * Bumped on a diagnostics schema/algorithm change that does NOT change `kitApiVersion` (§6.1).
 *
 * BUMPED 1 -> 2 (design-tree phase 2 Task 7): `DiagnosticsKey`'s shape itself changed
 * (`sourceHash` -> `closureHash`), so every generation-1 entry's `key.sourceHash` would
 * otherwise decode as an extra/missing field under the new `diagnosticsKeySchema` below —
 * the generation bump is what makes that a clean miss-and-rebuild instead of a
 * schema-validation error surfacing where a caller expects only a MISS or a real I/O fault.
 */
export const DIAGNOSTICS_STORE_GENERATION = 2;

/** §6.2: "128 MiB default per-project quota, configurable locally from 32 MiB through 512 MiB." */
export const DIAGNOSTICS_DEFAULT_QUOTA_BYTES = 128 * MiB;
/**
 * The documented configurable range. NOT enforced here: §6.2's "configurable locally
 * from 32 MiB through 512 MiB" is a `workspace.local.toml` resource-limit-override
 * validation rule, which is `store/toml`'s job (plan Wave C T9: "resource-limit
 * overrides validated in-range"), not this store's. `quotaBytes` is trusted as already
 * validated by the time it reaches here; these constants exist for that validator (and
 * any caller/test) to reference, and this store applies only the DEFAULT when no
 * override is supplied.
 */
export const DIAGNOSTICS_MIN_QUOTA_BYTES = 32 * MiB;
export const DIAGNOSTICS_MAX_QUOTA_BYTES = 512 * MiB;

function resolveQuota(quotaBytes: number | undefined): number {
  return quotaBytes ?? DIAGNOSTICS_DEFAULT_QUOTA_BYTES;
}

// ---- envelope -----------------------------------------------------------------------

const diagnosticsKeySchema = z.object({
  pageSlug: z.string().min(1),
  closureHash: z.string().min(1),
  kitApiVersion: z.number().int(),
});

const diagnosticRangeSchema = z.object({ line: z.number().int(), column: z.number().int() });

const diagnosticItemSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  range: diagnosticRangeSchema.optional(),
});

const diagnosticsValueSchema = z.object({
  schemaVersion: z.number().int(),
  provenance: z.enum(["gate", "host"]),
  observedAt: rfc3339UtcSchema,
  diagnostics: z.array(diagnosticItemSchema),
});

const envelopeSchema = z.object({
  envelopeVersion: z.literal(1),
  storeGeneration: z.number().int(),
  key: diagnosticsKeySchema,
  value: diagnosticsValueSchema,
  writtenAt: rfc3339UtcSchema,
  valueSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

function sha256Hex(bytes: Uint8Array): Sha256Hex {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function canonicalKeyString(key: DiagnosticsKey): string {
  return [key.pageSlug, key.closureHash, String(key.kitApiVersion)].join(" ");
}

/** Content-addressed by the key: changing ANY ONE field yields a different path — automatically a miss. */
function keyHash(key: DiagnosticsKey): Sha256Hex {
  return sha256Hex(new TextEncoder().encode(canonicalKeyString(key)));
}

function entryPath(root: AbsPath, key: DiagnosticsKey): AbsPath {
  return path.join(root, `${keyHash(key)}.json`);
}

function sameKey(a: DiagnosticsKey, b: DiagnosticsKey): boolean {
  return canonicalKeyString(a) === canonicalKeyString(b);
}

function valueChecksum(value: unknown): Sha256Hex {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
}

// ---- production filesystem wiring ------------------------------------------------

function isMissingFile(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT"
  );
}

/** The real bindings. `infrastructure/durability`'s `durableFileWrite` is the only write path. */
export const nodeDiagnosticsStoreFsDeps: ProjectionFsDeps = {
  readFile(absPath) {
    const bytes = errore.try({
      try: () => new Uint8Array(fs.readFileSync(absPath)),
      catch: (cause) =>
        new DiagnosticsStoreIoError({
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
        new DiagnosticsStoreIoError({
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
        new DiagnosticsStoreIoError({
          operation: "list",
          path: absDir,
          detail: String(cause),
          cause,
        }),
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
        new DiagnosticsStoreIoError({
          operation: "mkdir",
          path: absDir,
          detail: String(cause),
          cause,
        }),
    });
  },
};

// ---- quota eviction -----------------------------------------------------------------
//
// JUDGMENT CALL (§6.2 names "128 MiB default quota, LRU eviction across unpinned keys"
// but pins no bookkeeping mechanism): this implementation keeps no separate manifest.
// Each entry's own envelope carries its `writtenAt`, so a quota sweep lists the
// directory, reads every entry's small envelope, and treats write recency as the
// recency signal (a `get` never rewrites an entry, so this is "least-recently-written",
// the simplest faithful reading of LRU that needs no write-on-read). A sweep also
// deletes any entry that fails to parse/validate outright — dead weight that can never
// hit again, reclaimed opportunistically rather than left to rot. This is O(entry
// count) per `put`, which is acceptable at a bounded projections-cache scale; an
// ordered manifest would remove the scan and is a reasonable future optimization, not
// required by the spec.

interface ScannedEntry {
  readonly path: AbsPath;
  readonly key: DiagnosticsKey;
  readonly writtenAt: string;
  readonly byteLength: number;
}

function scanEntries(
  root: AbsPath,
  fsDeps: ProjectionFsDeps,
): DiagnosticsStoreIoError | readonly ScannedEntry[] {
  const names = fsDeps.listFiles(root);
  if (names instanceof Error)
    return new DiagnosticsStoreIoError({
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
        "diagnostics-store: quota sweep skipped an unreadable entry:",
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
      // Dead weight: it can never serve a hit. Reclaim it now rather than let it sit.
      const removed = fsDeps.remove(entryFile);
      if (removed instanceof Error)
        console.warn("diagnostics-store: corrupt entry cleanup failed:", removed.message);
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

/** Evict least-recently-written unpinned entries (skipping `keepPath`) until `entries` total <= `quotaBytes`. */
function enforceQuota(input: {
  entries: readonly ScannedEntry[];
  quotaBytes: number;
  keepPath: AbsPath;
  isPinned: DiagnosticsPinPredicate;
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
      console.warn("diagnostics-store: eviction failed, leaving entry in place:", removed.message);
      continue;
    }
    remaining -= entry.byteLength;
  }
}

// ---- the store ----------------------------------------------------------------------

export interface DiagnosticsStoreDeps {
  /** The diagnostics directory, e.g. `.termcraft/diagnostics` — never a portable path. */
  readonly root: AbsPath;
  readonly fs: ProjectionFsDeps;
  readonly clock: Clock;
  /** Trusted as pre-validated (§6.2's [32 MiB, 512 MiB] range — `store/toml`'s job); defaults to {@link DIAGNOSTICS_DEFAULT_QUOTA_BYTES}. */
  readonly quotaBytes?: number;
  /** §6.2: "entries for currently listed page hashes are pinned during the active process." Defaults to none pinned. */
  readonly isPinned?: DiagnosticsPinPredicate;
  /** Test-only override to exercise a generation bump; defaults to {@link DIAGNOSTICS_STORE_GENERATION}. */
  readonly storeGeneration?: number;
}

export interface DiagnosticsStore {
  /** A HIT only on an exact `(pageSlug, closureHash, kitApiVersion)` match (§6.1). */
  get(key: DiagnosticsKey): Promise<DiagnosticsStoreIoError | DiagnosticsEntry | null>;
  /** Atomic whole-entry replace, then a quota-eviction sweep; never mutates portable state. */
  put(entry: DiagnosticsEntry): Promise<DiagnosticsStoreIoError | undefined>;
}

export function createDiagnosticsStore(deps: DiagnosticsStoreDeps): DiagnosticsStore {
  const generation = deps.storeGeneration ?? DIAGNOSTICS_STORE_GENERATION;
  const quotaBytes = resolveQuota(deps.quotaBytes);
  const isPinned = deps.isPinned ?? (() => false);

  return {
    async get(key) {
      const target = entryPath(deps.root, key);
      const bytes = deps.fs.readFile(target);
      if (bytes instanceof Error)
        return new DiagnosticsStoreIoError({
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
        console.warn("diagnostics-store: entry ignored (miss):", target, parsed.message);
        return null;
      }

      const decoded = envelopeSchema.safeParse(parsed);
      if (!decoded.success) {
        console.warn(
          "diagnostics-store: entry ignored (miss):",
          target,
          "does not match the envelope schema",
        );
        return null;
      }
      const envelope = decoded.data;

      if (envelope.storeGeneration !== generation) {
        console.warn(
          "diagnostics-store: entry ignored (miss):",
          target,
          `store generation ${envelope.storeGeneration} !== ${generation}`,
        );
        return null;
      }
      if (!sameKey(envelope.key, key)) {
        console.warn(
          "diagnostics-store: entry ignored (miss):",
          target,
          "key mismatch (hash collision or tampering)",
        );
        return null;
      }
      if (valueChecksum(envelope.value) !== envelope.valueSha256) {
        console.warn("diagnostics-store: entry ignored (miss):", target, "checksum mismatch");
        return null;
      }

      return { key: envelope.key, ...envelope.value };
    },

    async put(entry) {
      const created = deps.fs.ensureDir(deps.root);
      if (created instanceof Error)
        return new DiagnosticsStoreIoError({
          operation: "mkdir",
          path: deps.root,
          detail: created.message,
          cause: created,
        });

      const value = {
        schemaVersion: entry.schemaVersion,
        provenance: entry.provenance,
        observedAt: entry.observedAt,
        diagnostics: entry.diagnostics,
      };
      const envelope = {
        envelopeVersion: 1 as const,
        storeGeneration: generation,
        key: entry.key,
        value,
        writtenAt: deps.clock.now().toISOString(),
        valueSha256: valueChecksum(value),
      };
      const target = entryPath(deps.root, entry.key);
      const wrote = deps.fs.durableWrite(
        target,
        new TextEncoder().encode(JSON.stringify(envelope)),
      );
      if (wrote instanceof Error)
        return new DiagnosticsStoreIoError({
          operation: "write",
          path: target,
          detail: wrote.message,
          cause: wrote,
        });

      const scanned = scanEntries(deps.root, deps.fs);
      if (scanned instanceof Error) {
        // Quota bookkeeping is best-effort: the write already succeeded, so a failed
        // sweep is logged rather than turning a successful put into an error.
        console.warn("diagnostics-store: quota sweep failed:", scanned.message);
        return undefined;
      }
      enforceQuota({ entries: scanned, quotaBytes, keepPath: target, isPinned, fsDeps: deps.fs });
      return undefined;
    },
  };
}
