/**
 * `core/design-systems`'s shared vocabulary (CLAUDE.md "Code style": `types.ts` holds a
 * module's shared types). `model/candidate.ts`'s `composeDesignSystemCandidate` produces
 * {@link DesignSystemCandidateTreeV1}; its `summarizeGatePass` classifies the Gate's whole-tree
 * answer into {@link DesignSystemPreviewV1} (decision D6). `model/sources.ts`'s
 * `listGrantedSources` produces {@link SourceListingV1}; its `detectDesignSystemUpdate` produces
 * {@link DesignSystemUpdateV1} (decisions D9, D10). `model/install.ts`'s
 * `prepareDesignSystemInstall` takes the ports bundle {@link DesignSystemInstallPortsV1} and
 * produces {@link DesignSystemPreparedInstallV1} — the whole trust -> fetch -> quarantine ->
 * candidate -> Gate -> preview pipeline, one immutable value `commitDesignSystemInstall` either
 * commits or `discardPreparedInstall` throws away (§8.3, §8.5).
 */

import type {
  DesignSystemInstallPort,
  DesignSystemQuarantinePort,
  DesignSystemSource,
  DesignSystemSummaryV1,
  DesignTreeReader,
  GateRunner,
} from "core/ports";
import type { Sha256Hex } from "core/protocol";
import type { DesignSystemRef } from "entities/design-system-ref";
import type { Clock } from "infrastructure/clock";

/**
 * The candidate design tree, composed in memory over the canonical tree index (decision D5):
 * `system/**` replaced wholesale by an incoming package, every other file untouched.
 */
export interface DesignSystemCandidateTreeV1 {
  /** TREE-relative -> source text. The Gate's `runTree` input. */
  readonly files: ReadonlyMap<string, string>;
  /** `[...files.keys()].sort()` — the Gate's `treePaths` input. */
  readonly treePaths: readonly string[];
  /** TREE-relative paths the outgoing system had and the incoming one does not. */
  readonly removedTreeRelPaths: readonly string[];
  /** TREE-relative -> bytes, for the transaction's payloads. The SAME bytes `files` decodes as text. */
  readonly nextFiles: readonly { readonly treeRelPath: string; readonly bytes: Uint8Array }[];
}

/**
 * D6's three outcomes: `clean` (no fatals at all), `breaks-pages` (every fatal is outside
 * `system/`, attributed to a page, and confirmable), `blocked` (at least one fatal is inside
 * `system/` or unattributed — the package itself is broken, and the install command refuses).
 */
export type DesignSystemPreviewVerdictV1 = "clean" | "breaks-pages" | "blocked";

/** One Gate diagnostic, redrawn for the picker's breakage-preview dialog. */
export interface DesignSystemBreakageItemV1 {
  readonly code: string;
  readonly message: string;
  readonly file: string | null;
  readonly blockedPages: readonly string[];
}

/** The classified answer `summarizeGatePass` hands the install pipeline and the picker. */
export interface DesignSystemPreviewV1 {
  readonly verdict: DesignSystemPreviewVerdictV1;
  readonly errors: readonly DesignSystemBreakageItemV1[];
  readonly warnings: readonly DesignSystemBreakageItemV1[];
}

/**
 * One source's outcome after `listGrantedSources` (decisions D9, D10): `listed` (queried,
 * `systems` holds its answer), `ungranted` (never queried — §8.4), or `unavailable` (queried,
 * timed out or failed — `reason` carries `safeMessage`/the timeout text, and the OTHER sources
 * still list).
 */
export type SourceListStateV1 = "listed" | "ungranted" | "unavailable";

/** One configured source's row for the picker: its listing state and, when `listed`, its systems. */
export interface SourceListingV1 {
  readonly sourceId: string;
  readonly label: string;
  readonly canPublish: boolean;
  readonly state: SourceListStateV1;
  readonly systems: readonly DesignSystemSummaryV1[];
  /** `null` when `state === "listed"`; otherwise the ungranted/unavailable reason. */
  readonly reason: string | null;
}

/**
 * §8.5's update check answer: the source the project recorded offers a DIFFERENT version of the
 * installed system. `"different-version"` rather than `"newer"` — a reference's version is opaque
 * (§8.1), so no semver ordering is assumed.
 */
export interface DesignSystemUpdateV1 {
  readonly installedRef: DesignSystemRef;
  readonly available: DesignSystemSummaryV1;
  readonly reason: "different-version";
}

/**
 * Every capability `model/install.ts`'s pipeline needs, bundled once so
 * `prepareDesignSystemInstall`/`commitDesignSystemInstall`/`discardPreparedInstall` each take one
 * argument instead of six. `quarantine` and `install` are `core/ports`' own ports (`core` may not
 * import `store`); `source`, `designReader`, and `gateRunner` are the ports Tasks 3-7 already
 * bind to.
 */
export interface DesignSystemInstallPortsV1 {
  readonly source: DesignSystemSource;
  readonly designReader: DesignTreeReader;
  readonly gateRunner: GateRunner;
  readonly quarantine: DesignSystemQuarantinePort;
  readonly install: DesignSystemInstallPort;
  readonly clock: Clock;
  /**
   * A UUIDv7 (D4): `store/design-systems`' quarantine treats the value as opaque and relies on
   * create-new for collision safety, never on the value's own shape. The composition root (a
   * later task) wires the real `uuidv7()`; any sufficiently-unique string works for a test.
   */
  readonly newInstallId: () => string;
}

/**
 * One completed pass of the pipeline (§8.3, §8.5) — fetched, quarantined, composed into a
 * candidate, and run through the whole-tree Gate once. Quarantine is DELIBERATELY still on
 * disk at this point (`prepareDesignSystemInstall` never discards it): the caller either
 * commits it (`commitDesignSystemInstall`) or abandons it (`discardPreparedInstall`).
 */
export interface DesignSystemPreparedInstallV1 {
  readonly installId: string;
  readonly ref: DesignSystemRef;
  readonly contentHash: Sha256Hex;
  readonly summary: DesignSystemSummaryV1;
  readonly preview: DesignSystemPreviewV1;
  readonly candidate: DesignSystemCandidateTreeV1;
}
