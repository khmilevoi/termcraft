import type { FailureDtoV1 } from "core/protocol";

import type { AssertConforms } from "../index";
import type {
  DiagnosticsCache,
  DiagnosticsEntryV1,
  DiagnosticsKeyV1,
  ExportRenderKeyV1,
  PageMetaCache,
  PageMetaEntryV1,
  PageMetaKeyV1,
  RenderCache,
  RenderEntryV1,
} from "../projections";

/**
 * In-memory {@link PageMetaCache}/{@link DiagnosticsCache}/{@link RenderCache} fakes (6D
 * task brief). Three SEPARATE factories, matching the port file's own reasoning ("each
 * store owns its own quota/generation/eviction policy, so one flat interface would blur
 * three independent capabilities into one") — nothing here is shared between them.
 *
 * `stableKeyOf` recursively sorts object keys before `JSON.stringify` so two structurally
 * equal keys built independently (e.g. by two different call sites) always collide onto
 * the same cache slot, regardless of the literal's property insertion order.
 */

function stableKeyOf(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKeyOf).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const sortedEntries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${sortedEntries.map(([k, v]) => `${JSON.stringify(k)}:${stableKeyOf(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

type CacheCall<K> =
  | { readonly method: "get"; readonly key: K }
  | { readonly method: "put"; readonly key: K };

function createFakeCache<K, E>(getKey: (entry: E) => K) {
  const store = new Map<string, E>();
  const calls: CacheCall<K>[] = [];
  const getFailures: FailureDtoV1[] = [];
  const putFailures: FailureDtoV1[] = [];

  return {
    calls,
    failNext(method: "get" | "put", failure: FailureDtoV1): void {
      if (method === "get") getFailures.push(failure);
      else putFailures.push(failure);
    },
    async get(key: K): Promise<FailureDtoV1 | E | null> {
      calls.push({ method: "get", key });
      const queued = getFailures.shift();
      if (queued !== undefined) return queued;
      return store.get(stableKeyOf(key)) ?? null;
    },
    async put(entry: E): Promise<FailureDtoV1 | undefined> {
      const key = getKey(entry);
      calls.push({ method: "put", key });
      const queued = putFailures.shift();
      if (queued !== undefined) return queued;
      store.set(stableKeyOf(key), entry);
      return undefined;
    },
  };
}

export type PageMetaCacheCall = CacheCall<PageMetaKeyV1>;
export interface FakePageMetaCache extends PageMetaCache {
  readonly calls: readonly PageMetaCacheCall[];
  failNext(method: "get" | "put", failure: FailureDtoV1): void;
}
export function createFakePageMetaCache(): FakePageMetaCache {
  return createFakeCache<PageMetaKeyV1, PageMetaEntryV1>((entry) => entry.key);
}

export type DiagnosticsCacheCall = CacheCall<DiagnosticsKeyV1>;
export interface FakeDiagnosticsCache extends DiagnosticsCache {
  readonly calls: readonly DiagnosticsCacheCall[];
  failNext(method: "get" | "put", failure: FailureDtoV1): void;
}
export function createFakeDiagnosticsCache(): FakeDiagnosticsCache {
  return createFakeCache<DiagnosticsKeyV1, DiagnosticsEntryV1>((entry) => entry.key);
}

export type RenderCacheCall = CacheCall<ExportRenderKeyV1>;
export interface FakeRenderCache extends RenderCache {
  readonly calls: readonly RenderCacheCall[];
  failNext(method: "get" | "put", failure: FailureDtoV1): void;
}
export function createFakeRenderCache(): FakeRenderCache {
  return createFakeCache<ExportRenderKeyV1, RenderEntryV1>((entry) => entry.key);
}

type _PageMetaConforms = AssertConforms<PageMetaCache, FakePageMetaCache>;
type _DiagnosticsConforms = AssertConforms<DiagnosticsCache, FakeDiagnosticsCache>;
type _RenderConforms = AssertConforms<RenderCache, FakeRenderCache>;
