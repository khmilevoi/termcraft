/**
 * `core/capabilities`'s public entry point: the 43 capability target extractors
 * (kernel-command-contract §10.1), the shared `CapabilityState`/`CapabilityEntry`/
 * `KernelStateSnapshot` vocabulary (§10.1, §10.2), the one pure guard implementation
 * (§10.2), the §10.4 turn-time lock matrix, and the capability projector (§10.2, §13.2).
 */

export type { CapabilityId, CapabilityTargetExtractor } from "./model/target";
export {
  CapabilityTargetExtractionError,
  capabilityTargetExtractors,
  extractCapabilityTarget,
} from "./model/target";

export type {
  CapabilityEntry,
  CapabilityRecord,
  CapabilityState,
  KernelStateSnapshot,
} from "./types";

export { evaluateCapabilityGuard } from "./model/guards";

export { TURN_LOCKED_KINDS, isTurnLockedKind, turnLockedReason } from "./model/turn-lock";

export type { CapabilityChangeSet } from "./model/projector";
export { diffCapabilities, projectCapabilities, projectCapability } from "./model/projector";
