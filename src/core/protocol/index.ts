// The Kernel's transport-neutral DTO surface (kernel-command-contract §8, §9, §11).
//
// This is what crosses the UI<->Kernel boundary: closed command and event unions, their
// per-kind payload schemas, the accepted/rejected result DTOs, the typed rejection and
// operational-failure codes, and the canonical counter/id/hash primitives underneath.
// It is pure data and pure functions — no Reatom, no I/O, no resource ownership — so the
// contract can be exercised in-process long before any daemon exists (§1).
//
// The unions here are CLOSED (§2.12). Adding a kind means a schema, a guard, a capability
// mapping, a transition-table entry, and contract tests (§8.2) — never just a union member.

export type { ProtocolVersion } from "./types";
export { PROTOCOL_VERSION } from "./types";

// --- Primitives -----------------------------------------------------------------
export type { UInt64String } from "./model/uint64";
export {
  UINT64_MAX,
  Uint64DecodeError,
  compareUint64Strings,
  decodeUint64String,
  encodeUint64String,
  isUint64String,
  uint64StringSchema,
} from "./model/uint64";

export type { HostNonce, Sha256Hex, UUIDv7 } from "./model/ids";
export {
  hostNonceSchema,
  isHostNonce,
  isSha256Hex,
  isUuidv7,
  sha256HexSchema,
  uuidv7Schema,
} from "./model/ids";

export { CanonicalHashError, canonicalHash, canonicalJson } from "./model/canonical-hash";

// --- Chat record wire union (WP-10 Task 2) ---------------------------------------
export type { ChatRecordDtoV1 } from "./model/chat-record";
export { chatRecordDtoV1Schema } from "./model/chat-record";

// --- Shared DTOs ----------------------------------------------------------------
export type {
  ChatPageCursorDtoV1,
  DiagnosticDtoV1,
  FrameIdentityV1,
  FrameTokenV1,
  GeometryTokenV1,
  PageDescriptorChangeV1,
  PageDescriptorV1,
  PageRemovePlanV1,
  PinDtoV1,
} from "./model/shared-dto";
export {
  chatPageCursorDtoV1Schema,
  diagnosticDtoV1Schema,
  frameIdentityV1Schema,
  frameTokenV1Schema,
  geometryTokenV1Schema,
  pageDescriptorChangeV1Schema,
  pageDescriptorV1Schema,
  pageRemovePlanV1Schema,
  pinDtoV1Schema,
} from "./model/shared-dto";

// --- Commands -------------------------------------------------------------------
export type { CommandFamilyV1, CommandKindV1 } from "./model/command-kind";
export {
  COMMAND_FAMILIES_V1,
  COMMAND_KIND_COUNT,
  COMMAND_KINDS_V1,
  commandFamilyOf,
  commandKindV1Schema,
  isCommandKindV1,
} from "./model/command-kind";

export type { CommandPayloadByKindV1 } from "./model/command-payload";
export { commandPayloadSchemaFor, commandPayloadSchemas } from "./model/command-payload";

export type {
  CapabilityTargetByKindV1,
  GeometryQueryKindV1,
  RecoveryTargetV1,
} from "./model/capability-target";
export { capabilityTargetByKindV1Schema } from "./model/capability-target";

export type { CommandEnvelopeV1 } from "./model/command-envelope";
export {
  CommandDecodeError,
  decodeCommandEnvelope,
  envelopeFingerprint,
} from "./model/command-envelope";

// --- Results, failures, reasons -------------------------------------------------
export type {
  AcceptedCommandV1,
  CommandRejectionCode,
  CommandResultV1,
  RejectedCommandV1,
} from "./model/command-result";
export {
  COMMAND_REJECTION_CODES_V1,
  acceptedCommandV1Schema,
  commandRejectionCodeSchema,
  commandResultV1Schema,
  isCommandRejectionCode,
  rejectedCommandV1Schema,
} from "./model/command-result";

export type { FailureDtoV1, OperationalFailureCode } from "./model/failure";
export {
  OPERATIONAL_FAILURE_CODES_V1,
  failureDtoV1Schema,
  isOperationalFailureCode,
  operationalFailureCodeSchema,
} from "./model/failure";

export type { UnavailableReason } from "./model/unavailable-reason";
export {
  REASON_CODES_V1,
  UNAVAILABLE_REASON_PRIORITY_V1,
  primaryReason,
  unavailableReasonV1Schema,
} from "./model/unavailable-reason";

// --- Events ---------------------------------------------------------------------
export type { EventKindV1 } from "./model/event-kind";
export {
  EVENT_KIND_COUNT,
  EVENT_KINDS_V1,
  eventKindV1Schema,
  isEventKindV1,
} from "./model/event-kind";

export type { EventPayloadByKindV1 } from "./model/event-payload";
export { eventPayloadV1SchemaByKind } from "./model/event-payload";

// --- M21 closed DTOs (WP-1 task 2): kernel snapshot / state-changed / capability entry --
export type {
  AgentIdentityV1,
  CapabilityEntryV1,
  CapabilityStateV1,
  KernelModelsSnapshotV1,
  KernelStateChangedPayloadV1,
} from "./model/event-payload";
export { agentIdentityV1Schema, kernelStateChangedPayloadV1Schema } from "./model/event-payload";

// --- M21 closed DTOs (WP-1 task 3): preview.geometryResult's closed §4.2 result union --
export type { GeometryQueryResultV1, LayoutNodeV1 } from "./model/event-payload";
