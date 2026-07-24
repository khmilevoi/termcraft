/**
 * `ui/mirror` — the UI-owned read-model. A separate Reatom graph of named atoms fed by the
 * Kernel `EventEnvelopeV1` stream (design §3.2/§3.3); every screen reads from it.
 */
export type {
  AgentIdentity,
  CapabilityEntry,
  CapabilityState,
  ChatsMirror,
  ChatSummary,
  ExportMirror,
  PreviewMirror,
  ProjectMirror,
  ScreenKind,
  SelectionMirror,
  TurnGateDiagnostics,
  TurnMirror,
  TurnProgressContent,
  TurnTerminalPayload,
  TurnToolStep,
  TurnUsage,
} from "./types";
export type { Mirror } from "./model/mirror";
export { createMirror } from "./model/mirror";
export { sortChatSummariesNewestFirst } from "./model/chats";
export {
  agentIdentityFromSnapshot,
  capabilitiesFromSnapshot,
  projectFromSnapshot,
} from "./model/seed";
export type { ScreenInput } from "./model/screen";
export { MIN_FRAME, createScreenAtom, deriveScreen } from "./model/screen";
