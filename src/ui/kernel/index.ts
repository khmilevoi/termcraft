/**
 * `ui/kernel` — the UI's Kernel boundary: the `KernelPort` it depends on, the event-envelope
 * types it reads, and the command dispatcher every screen issues through.
 */
export type { KernelPort, PreviewSessionHandle } from "./types";
export type {
  AnyEventEnvelope,
  EventCorrelationV1,
  EventEnvelopeV1,
  EventOf,
} from "./model/events";
export type { Dispatcher, DispatcherDeps } from "./model/dispatcher";
export { KernelDispatchError, createDispatcher } from "./model/dispatcher";
