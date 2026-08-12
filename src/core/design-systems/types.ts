/**
 * `core/design-systems`'s shared vocabulary (CLAUDE.md "Code style": `types.ts` holds a
 * module's shared types). `model/candidate.ts`'s `composeDesignSystemCandidate` produces
 * {@link DesignSystemCandidateTreeV1}; its `summarizeGatePass` classifies the Gate's whole-tree
 * answer into {@link DesignSystemPreviewV1} (decision D6). `model/sources.ts`'s
 * `listGrantedSources` produces {@link SourceListingV1}; its `detectDesignSystemUpdate` produces
 * {@link DesignSystemUpdateV1} (decisions D9, D10).
 */

import type { DesignSystemSummaryV1 } from "core/ports";
import type { DesignSystemRef } from "entities/design-system-ref";

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
