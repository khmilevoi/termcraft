import path from "node:path";

import * as errore from "errore";
import { z } from "zod";

import type { DesignSystemRef } from "entities/design-system-ref";
import { designSystemRefSchema, formatDesignSystemRef } from "entities/design-system-ref";
import { rfc3339UtcSchema } from "infrastructure/clock";

import type { AbsPath, DesignSystemFsDeps, Sha256Hex } from "../types";
import { DesignSystemPackageInvalidError } from "./errors";
import { cacheEntryRecordPath } from "./layout";

/**
 * `cache/<sourceIdSegment>/<systemId>@<version>/entry.json` (design §8.2). The record sits
 * BESIDE `package/`, never inside it, so `package/` stays a byte-exact copy of what the source
 * served and the content hash covers exactly those bytes.
 *
 * Stage 1 writes none of these — the only source is a local directory, which needs no cache
 * (§8.6). The layout and the record exist now so a GitHub adapter joins without inventing them,
 * and so `contentHash` is already the thing §8.5's provenance record can be checked against.
 */
export const CACHE_ENTRY_SCHEMA_VERSION = 1;

export interface CacheEntryRecordV1 {
  readonly schemaVersion: typeof CACHE_ENTRY_SCHEMA_VERSION;
  readonly ref: DesignSystemRef;
  readonly contentHash: Sha256Hex;
  /** RFC 3339 UTC. */
  readonly fetchedAt: string;
}

const cacheEntryRecordSchema = z.strictObject({
  schemaVersion: z.literal(CACHE_ENTRY_SCHEMA_VERSION),
  ref: designSystemRefSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  fetchedAt: rfc3339UtcSchema,
});

export function decodeCacheEntryRecord(bytes: Uint8Array, recordPath: AbsPath) {
  const parsed = errore.try({
    try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    catch: (cause) =>
      new DesignSystemPackageInvalidError({
        path: recordPath,
        reason: "cache entry is not valid JSON",
        cause,
      }),
  });
  if (parsed instanceof Error) return parsed;

  const decoded = cacheEntryRecordSchema.safeParse(parsed);
  if (!decoded.success) {
    return new DesignSystemPackageInvalidError({
      path: recordPath,
      reason: `not a schema-${CACHE_ENTRY_SCHEMA_VERSION} cache entry`,
      cause: decoded.error,
    });
  }
  return decoded.data satisfies CacheEntryRecordV1;
}

/** The reference is stored as its CANONICAL TEXT — one field, re-parsed on read. */
export function encodeCacheEntryRecord(record: CacheEntryRecordV1): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify(
      {
        schemaVersion: record.schemaVersion,
        ref: formatDesignSystemRef(record.ref),
        contentHash: record.contentHash,
        fetchedAt: record.fetchedAt,
      },
      null,
      2,
    )}\n`,
  );
}

/** `null` when nothing has been fetched at this address yet — an ordinary answer, not a fault. */
export function readCacheEntryRecord(
  fs: DesignSystemFsDeps,
  userStateRoot: AbsPath,
  ref: DesignSystemRef,
) {
  const recordPath = cacheEntryRecordPath(userStateRoot, ref.sourceId, ref.systemId, ref.version);
  const bytes = fs.readFile(recordPath);
  if (bytes instanceof Error) return bytes;
  if (bytes === null) return null;
  return decodeCacheEntryRecord(bytes, recordPath);
}

export function writeCacheEntryRecord(
  fs: DesignSystemFsDeps,
  userStateRoot: AbsPath,
  record: CacheEntryRecordV1,
) {
  const recordPath = cacheEntryRecordPath(
    userStateRoot,
    record.ref.sourceId,
    record.ref.systemId,
    record.ref.version,
  );

  const created = fs.mkdirAll(path.dirname(recordPath));
  if (created instanceof Error) return created;

  const wrote = fs.durableWrite(recordPath, encodeCacheEntryRecord(record));
  if (wrote instanceof Error) return wrote;
  return undefined;
}
