import type { FailureDtoV1, Sha256Hex } from "core/protocol";
import type { DesignSystemRef } from "entities/design-system-ref";
import { formatDesignSystemRef } from "entities/design-system-ref";

import type {
  DesignSystemSource,
  DesignSystemSummaryV1,
  FetchedPackageV1,
  LocalPackageV1,
  PackageFileV1,
  PublishReceiptV1,
} from "../design-system-source";
import type { AssertConforms } from "../index";

/**
 * In-memory {@link DesignSystemSource} fake. It holds seeded packages keyed by their reference
 * TEXT, so `fetch` answers exactly what `list` advertised. No filesystem, no crypto, no clock —
 * `publishedAt` comes from a monotonic counter over a fixed epoch so two runs produce the same
 * transcript.
 */

/** A deterministic, valid-looking 64-hex-char {@link Sha256Hex} derived from a seed — no crypto, no randomness. */
function fakeSha256Hex(seed: string): Sha256Hex {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) | 0;
  const base = (h >>> 0).toString(16).padStart(8, "0");
  return base.repeat(8).slice(0, 64);
}

export type DesignSystemSourceFailableMethod = "list" | "fetch" | "publish";

export type FakeDesignSystemSourceCall =
  | { readonly method: "list" }
  | { readonly method: "fetch"; readonly ref: string }
  | { readonly method: "publish"; readonly ref: string };

export interface FakeDesignSystemSourceOptions {
  readonly id: string;
  readonly label: string;
  readonly canPublish: boolean;
}

export interface FakeDesignSystemSource extends DesignSystemSource {
  readonly calls: readonly FakeDesignSystemSourceCall[];
  failNext(method: DesignSystemSourceFailableMethod, failure: FailureDtoV1): void;
  /** Makes a summary listable and its package fetchable at `<id>:<summary.id>@<summary.version>`. */
  seed(summary: DesignSystemSummaryV1, files: readonly PackageFileV1[]): void;
}

const FIXED_EPOCH_MS = Date.parse("2026-01-01T00:00:00.000Z");

function refusal(safeMessage: string): FailureDtoV1 {
  return { code: "PERSISTENCE_FAILED", retryable: false, safeMessage, details: {} };
}

export function createFakeDesignSystemSource(
  options: FakeDesignSystemSourceOptions,
): FakeDesignSystemSource {
  const packages = new Map<
    string,
    { readonly summary: DesignSystemSummaryV1; readonly files: readonly PackageFileV1[] }
  >();
  const calls: FakeDesignSystemSourceCall[] = [];
  const queues: Record<DesignSystemSourceFailableMethod, FailureDtoV1[]> = {
    list: [],
    fetch: [],
    publish: [],
  };
  let published = 0;

  function keyOf(systemId: string, version: string): string {
    return `${options.id}|${systemId}|${version}`;
  }

  function seed(summary: DesignSystemSummaryV1, files: readonly PackageFileV1[]): void {
    packages.set(keyOf(summary.id, summary.version), { summary, files });
  }

  function failNext(method: DesignSystemSourceFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure);
  }

  async function list(): Promise<FailureDtoV1 | readonly DesignSystemSummaryV1[]> {
    calls.push({ method: "list" });
    const queued = queues.list.shift();
    if (queued !== undefined) return queued;
    return [...packages.values()].map((entry) => entry.summary);
  }

  async function fetch(ref: DesignSystemRef): Promise<FailureDtoV1 | FetchedPackageV1> {
    calls.push({ method: "fetch", ref: formatDesignSystemRef(ref) });
    const queued = queues.fetch.shift();
    if (queued !== undefined) return queued;

    if (ref.sourceId !== options.id) return refusal("reference names another source");
    const entry = packages.get(keyOf(ref.systemId, ref.version));
    if (entry === undefined) return refusal("no such design system at this reference");

    return {
      ref,
      contentHash: fakeSha256Hex(formatDesignSystemRef(ref)),
      files: entry.files,
      summary: entry.summary,
    };
  }

  async function publish(pkg: LocalPackageV1): Promise<FailureDtoV1 | PublishReceiptV1> {
    const ref: DesignSystemRef = {
      sourceId: options.id as DesignSystemRef["sourceId"],
      systemId: pkg.systemId,
      version: pkg.version,
    };
    calls.push({ method: "publish", ref: formatDesignSystemRef(ref) });
    const queued = queues.publish.shift();
    if (queued !== undefined) return queued;
    if (!options.canPublish) return refusal("this source cannot publish");

    seed(
      {
        id: pkg.systemId,
        name: pkg.systemId,
        version: pkg.version,
        kitApiVersion: 1,
        defaultTheme: "dark",
        defaultThemeTokens: [],
        componentNames: [],
      },
      pkg.files,
    );
    published += 1;
    return {
      ref,
      contentHash: fakeSha256Hex(formatDesignSystemRef(ref)),
      publishedAt: new Date(FIXED_EPOCH_MS + published * 1000).toISOString(),
    };
  }

  return {
    id: options.id,
    label: options.label,
    canPublish: options.canPublish,
    list,
    fetch,
    publish,
    calls,
    failNext,
    seed,
  };
}

type _Conforms = AssertConforms<DesignSystemSource, FakeDesignSystemSource>;
