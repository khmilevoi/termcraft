// `core/design-systems` — the design-system install pipeline (project-design-systems design
// §8.3, §8.4, §8.5, §10.1 Wave 3 / P10): splicing an incoming package's `system/**` over the
// canonical tree index, classifying the whole-tree Gate's answer into the picker's breakage
// preview (decision D6), the grant-gated bounded-timeout multi-source list (D9, D10), the update
// check, and (`model/install.ts`) the orchestration that threads trust -> fetch -> quarantine ->
// candidate -> Gate -> preview -> commit through `core/ports`' ports. No DIRECT I/O anywhere in
// this module — every effect crosses a port (`DesignSystemSource`, `DesignTreeReader`,
// `GateRunner`, `DesignSystemQuarantinePort`, `DesignSystemInstallPort`), never a filesystem or
// network call `core` makes itself.

export type {
  DesignSystemBreakageItemV1,
  DesignSystemCandidateTreeV1,
  DesignSystemInstallPortsV1,
  DesignSystemPreparedInstallV1,
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

export {
  commitDesignSystemInstall,
  discardPreparedInstall,
  prepareDesignSystemInstall,
} from "./model/install";
