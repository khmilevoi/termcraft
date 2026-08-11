import type { FailureDtoV1, Sha256Hex } from "core/protocol";
import type {
  DesignSystemId,
  DesignSystemRef,
  DesignSystemVersion,
} from "entities/design-system-ref";

/**
 * `DesignSystemSource`: where a project's design system comes from (project-design-systems
 * design §8.1). One port, adapters in the ring, composed at the composition root — the same
 * shape as the other ~17 adapters.
 *
 * EVERY OPERATION IS ASYNCHRONOUS AND FAILABLE FROM THE START, though the only stage-1
 * adapter — a local directory — needs neither: "a synchronous contract has no room for a
 * network source later" (§8.1). A GitHub adapter's one requirement on this work is that it must
 * not need a change to this file.
 *
 * ERROR CHANNEL. §8.1 writes `SourceError` in its signatures. At this ring's boundary that is
 * `FailureDtoV1` (decision C1, `./index.ts`'s header): the tagged `SourceError` union is real
 * and lives in `store/design-systems`, and `store/adapters/failure.ts` maps it here. Admission
 * refusals arrive as `RESOURCE_LIMIT_EXCEEDED`; every other source fault arrives as
 * `PERSISTENCE_FAILED`. `FailureDtoV1` is a plain DTO and not an `Error`, so `core`-side callers
 * narrow with this ring's `"code" in result` idiom (`core/project/model/trust.ts`), never
 * `instanceof Error`.
 *
 * NOT IN SCOPE HERE (design §10.1, P10): install through quarantine, the breakage preview, the
 * picker, the provenance record, and the update check. This file declares only where packages
 * come from and where they go.
 */

/**
 * One token of a theme, in DECLARATION ORDER. The picker draws a swatch row, and the row's
 * order is the manifest's order — which is why this is an ordered list rather than a record.
 */
export interface DesignSystemTokenSwatchV1 {
  readonly name: string;
  readonly value: string;
}

/**
 * What the picker needs about a candidate it has not installed and that has never been through
 * the Gate (§8.1): "everything that fits in one `design-system.json`". A local source reads it
 * off disk; a remote source fetches one small file per candidate. Had `list` returned whole
 * packages, opening the picker against a configured remote would download every system in it.
 *
 * This is READ WITHOUT EXECUTING AND WITHOUT COMPILING anything — the property §3.2 makes the
 * manifest data-shaped for, and §11 tests as "`list` never opens a `.tsx`".
 *
 * It is deliberately NOT a validity verdict. A summary says a manifest is readable enough to
 * show; whether it passes §7's fatals is the Gate's answer (P2), reached only through an
 * install (P10).
 *
 * A summary carries no reference of its own: the caller holds the `DesignSystemSource` it came
 * from, so the address is `{ sourceId: source.id, systemId: summary.id, version: summary.version }`.
 */
export interface DesignSystemSummaryV1 {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kitApiVersion: number;
  /** The theme `defaultThemeTokens` was read from — `design-system.json`'s `defaultTheme`. */
  readonly defaultTheme: string;
  readonly defaultThemeTokens: readonly DesignSystemTokenSwatchV1[];
  readonly componentNames: readonly string[];
}

/** One file of a package, at a `/`-separated path relative to the package root. */
export interface PackageFileV1 {
  readonly relPath: string;
  readonly bytes: Uint8Array;
}

/**
 * A materialized package. `contentHash` is the sha256 over the file set (§8.2), so "one
 * reference always names the same bytes" is verifiable rather than assumed — a remote source
 * can republish a version, and the hash is what catches it.
 *
 * The bytes stop here. `fetch` never writes into a design tree: P10 stages this into quarantine,
 * applies the safe-filesystem limits, and only then builds a candidate (§8.3).
 */
export interface FetchedPackageV1 {
  readonly ref: DesignSystemRef;
  readonly contentHash: Sha256Hex;
  readonly files: readonly PackageFileV1[];
  readonly summary: DesignSystemSummaryV1;
}

/** A package handed to `publish` — the folder as it would sit at `design/system/` in a project. */
export interface LocalPackageV1 {
  readonly systemId: DesignSystemId;
  readonly version: DesignSystemVersion;
  readonly files: readonly PackageFileV1[];
}

/** Proof of a completed publish, carrying the address the package now answers to. */
export interface PublishReceiptV1 {
  readonly ref: DesignSystemRef;
  readonly contentHash: Sha256Hex;
  /** RFC 3339 UTC. */
  readonly publishedAt: string;
}

export interface DesignSystemSource {
  /** `"local"`, `"github:acme/design-systems"` — the `sourceId` half of every reference it answers. */
  readonly id: string;
  /** Human-readable, for the picker's source column. */
  readonly label: string;
  /**
   * Declared, never assumed (§8.1). A local directory publishes by copying; a GitHub source
   * publishes by committing or opening a pull request — a different operation with its own
   * permissions and confirmation. A source that cannot publish says so, and the shell draws no
   * button.
   */
  readonly canPublish: boolean;

  list(): Promise<FailureDtoV1 | readonly DesignSystemSummaryV1[]>;
  fetch(ref: DesignSystemRef): Promise<FailureDtoV1 | FetchedPackageV1>;
  publish(pkg: LocalPackageV1): Promise<FailureDtoV1 | PublishReceiptV1>;
}
