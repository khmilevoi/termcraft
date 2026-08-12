// `core/design-systems` — the pure core of the install pipeline (project-design-systems design
// §8.3, §10.1 Wave 3 / P10): splicing an incoming package's `system/**` over the canonical tree
// index, and classifying the whole-tree Gate's answer into the picker's breakage preview
// (decision D6). No I/O — `model/install.ts` (a later task) is the impure orchestration that
// calls into this module.

export type {
  DesignSystemBreakageItemV1,
  DesignSystemCandidateTreeV1,
  DesignSystemPreviewV1,
  DesignSystemPreviewVerdictV1,
} from "./types";

export {
  DesignSystemCandidateError,
  MAX_PREVIEW_ITEMS,
  composeDesignSystemCandidate,
  summarizeGatePass,
} from "./model/candidate";
