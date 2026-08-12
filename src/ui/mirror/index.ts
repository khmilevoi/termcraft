/**
 * `ui/mirror` — the UI-owned read-model. A separate Reatom graph of named atoms fed by the
 * Kernel `EventEnvelopeV1` stream (design §3.2/§3.3); every screen reads from it.
 */
export type {
  AgentIdentity,
  CapabilityEntry,
  CapabilityState,
  ChatHistoryMirror,
  ChatRecord,
  ChatsMirror,
  ChatSummary,
  DesignSystemMirror,
  DesignSystemPhase,
  ExportMirror,
  PreviewMirror,
  ProjectMirror,
  ProjectOpenFailure,
  ScreenKind,
  SelectionMirror,
  TurnGateDiagnostics,
  TurnMirror,
  TurnProgressContent,
  TurnTerminalPayload,
  TurnTimelineEntry,
  TurnUsage,
} from "./types";
export type { Mirror } from "./model/mirror";
export { createMirror, EMPTY_DESIGN_SYSTEM_MIRROR } from "./model/mirror";
export { sortChatSummariesNewestFirst } from "./model/chats";
export {
  agentIdentityFromSnapshot,
  capabilitiesFromSnapshot,
  projectFromSnapshot,
} from "./model/seed";
export type { ScreenInput } from "./model/screen";
export { MIN_FRAME, createScreenAtom, deriveScreen } from "./model/screen";
