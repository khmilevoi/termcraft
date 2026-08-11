import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseDesignSystemRef } from "entities/design-system-ref";

import {
  CACHE_ENTRY_SCHEMA_VERSION,
  decodeCacheEntryRecord,
  encodeCacheEntryRecord,
  readCacheEntryRecord,
  writeCacheEntryRecord,
} from "./cache-entry";
import { nodeDesignSystemFsDeps } from "./fs-deps";
import { cacheEntryRecordPath } from "./layout";

const scratchRoots: string[] = [];
function freshScratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ds-cache-"));
  scratchRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratchRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const HASH = "a".repeat(64);
const REF = (() => {
  const ref = parseDesignSystemRef("github:acme/design-systems#midnight@1.3.0");
  if (ref instanceof Error) throw ref;
  return ref;
})();

const RECORD = {
  schemaVersion: CACHE_ENTRY_SCHEMA_VERSION,
  ref: REF,
  contentHash: HASH,
  fetchedAt: "2026-08-11T10:00:00.000Z",
} as const;

describe("the cache-entry record (design §8.2)", () => {
  test("round-trips through encode/decode", () => {
    expect(decodeCacheEntryRecord(encodeCacheEntryRecord(RECORD), "p")).toEqual(RECORD);
  });

  test("stores the reference as its canonical TEXT, not as three fields", () => {
    const text = Buffer.from(encodeCacheEntryRecord(RECORD)).toString("utf8");
    expect(JSON.parse(text).ref).toBe("github:acme/design-systems#midnight@1.3.0");
  });

  test("rejects a bad schema version, an unparseable reference, and a non-sha256 hash", () => {
    const base = {
      schemaVersion: 1,
      ref: "local:midnight@1.2.0",
      contentHash: HASH,
      fetchedAt: "2026-08-11T10:00:00.000Z",
    };
    const encode = (value: unknown) => new Uint8Array(Buffer.from(JSON.stringify(value), "utf8"));
    expect(decodeCacheEntryRecord(encode({ ...base, schemaVersion: 2 }), "p")).toBeInstanceOf(
      Error,
    );
    expect(decodeCacheEntryRecord(encode({ ...base, ref: "nope" }), "p")).toBeInstanceOf(Error);
    expect(decodeCacheEntryRecord(encode({ ...base, contentHash: "XYZ" }), "p")).toBeInstanceOf(
      Error,
    );
    expect(decodeCacheEntryRecord(encode({ ...base, fetchedAt: "yesterday" }), "p")).toBeInstanceOf(
      Error,
    );
  });

  test("writes to cache/<sourceIdSegment>/<systemId>@<version>/entry.json and reads back", () => {
    const root = freshScratch();
    expect(writeCacheEntryRecord(nodeDesignSystemFsDeps, root, RECORD)).toBeUndefined();
    const written = cacheEntryRecordPath(root, REF.sourceId, REF.systemId, REF.version);
    expect(fs.existsSync(written)).toBe(true);
    expect(readCacheEntryRecord(nodeDesignSystemFsDeps, root, REF)).toEqual(RECORD);
  });

  test("an absent entry is null — not fetched yet is not a fault", () => {
    expect(readCacheEntryRecord(nodeDesignSystemFsDeps, freshScratch(), REF)).toBeNull();
  });
});
