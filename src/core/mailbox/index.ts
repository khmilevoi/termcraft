// The Kernel command mailbox (kernel-command-contract §5, §12.1, §12.2): "the single
// serialized entry for external commands and internal service signals. It owns
// parse/version checks, deduplication, revision checks, guard evaluation, model action
// dispatch, result recording, and control-event publication."
//
// `dispatch()` (§12.1) is the external-command half: decode -> dedupe -> revision check
// -> guard -> named model action(s) -> revision advance + event publication. Its
// capability-target/guard/model-action seams are 6C's (`../types`) — not yet landed —
// so `createDispatch` takes them as injected dependencies rather than importing them.
//
// `createSignalIngress` (§12.2 step 3, §13.3) is the internal-signal half: the fenced
// return path a backend service (`AgentRunSupervisor`) re-enters the mailbox through,
// comparing a signal's `{turnId, attempt, leaseNonce}` lease against the live turn
// before ever calling a model action, per §6's "Service callbacks return to the same
// mailbox through `wrap`; they never set model atoms directly."
//
// The dedupe ledger, revision guard, and event bus underneath both are exported here
// too — they are usable on their own (as `dispatch.ts`'s own tests do), but most
// callers want the composed `dispatch`/`deliver` entry points above.

export type {
  GuardDecision,
  GuardRegistry,
  GuardTarget,
  HandlerOutcome,
  HandlerRegistry,
  KernelStateSnapshot,
  TargetExtractor,
  TurnBackendLeaseV1,
  TurnFenceProbe,
} from "./types"

export {
  DEDUPE_CAPACITY,
  DEDUPE_HORIZON_MS,
  DedupeRejectionError,
  createDedupeLedger,
  uuidv7TimestampMs,
} from "./model/dedupe-ledger"
export type { DedupeLedger, DedupeLedgerDeps, DedupeRejectionCode } from "./model/dedupe-ledger"

export { checkRevisionGuard } from "./model/revision-guard"
export type {
  ActiveTurnCancelState,
  RevisionGuardCommand,
  RevisionGuardDecision,
  RevisionGuardRejectionCode,
  TurnCancelPhase,
  TurnCancelProbe,
} from "./model/revision-guard"

export { EventBusPayloadError, EventBusSubscriberError, createEventBus } from "./model/event-bus"
export type {
  EventBus,
  EventBusDeps,
  EventCorrelationV1,
  EventEnvelopeV1,
  PublishableEventV1,
} from "./model/event-bus"

export { createDispatch } from "./model/dispatch"
export type { Dispatch, DispatchDeps } from "./model/dispatch"

export { createSignalIngress } from "./model/signal-ingress"
export type { SignalIngress, SignalIngressDeps, StaleBackendSignal } from "./model/signal-ingress"
