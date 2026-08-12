// `core/design-systems` — the pure core of the install pipeline (project-design-systems design
// §8.3, §8.4, §8.5, §10.1 Wave 3 / P10): splicing an incoming package's `system/**` over the
// canonical tree index, classifying the whole-tree Gate's answer into the picker's breakage
// preview (decision D6), the grant-gated bounded-timeout multi-source list (D9, D10), and the
// update check. No I/O — `model/install.ts` (a later task) is the impure orchestration that
// calls into this module.

export type {
  DesignSystemBreakageItemV1,
  DesignSystemCandidateTreeV1,
  DesignSystemPreviewV1,
  DesignSystemPreviewVerdictV1,
  DesignSystemUpdateV1,
  SourceListingV1,
  SourceListStateV1,
} from "./types";

export {
  DesignSystemCandidateError,
  MAX_PREVIEW_ITEMS,
  composeDesignSystemCandidate,
  summarizeGatePass,
} from "./model/candidate";

export {
  DESIGN_SYSTEM_LIST_TIMEOUT_MS,
  DesignSystemSourceTimeoutError,
  detectDesignSystemUpdate,
  listGrantedSources,
  sourceKindOf,
} from "./model/sources";
