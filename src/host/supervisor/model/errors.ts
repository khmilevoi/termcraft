import * as errore from "errore"

/**
 * Stable diagnostic codes for supervisor lifecycle/queue/timeout failures
 * (host-supervision §12). Protocol-schema failures (framing, JSON, identity,
 * negotiation, kit-API, source-hash) stay `ProtocolError`; this family covers
 * only what the supervisor — not the codec — decides. Codes for 2D-2/3/4 are
 * declared now so the vocabulary is closed and later slices add no new type.
 */
export type SupervisorErrorCode =
  // 2D-1 — process + handshake lifecycle
  | "SPAWN_FAILED"
  | "HANDSHAKE_TIMEOUT"
  | "MOUNT_TIMEOUT"
  | "SHUTDOWN_TIMEOUT"
  | "REAP_TIMEOUT"
  | "CHILD_EXITED"
  | "TRANSPORT_ERROR"
  | "DESIGN_RENDER_FAILED"
  // 2D-2 — requests + heartbeat
  | "QUERY_TIMEOUT"
  | "HEARTBEAT_TIMEOUT"
  | "SUPERSEDED"
  // 2D-3 — queues, flood, capacity, circuit
  | "HOST_BACKPRESSURED"
  | "TOO_MANY_REQUESTS"
  | "CONTROL_BACKPRESSURE"
  | "PROTOCOL_FLOOD"
  | "STDERR_FLOOD"
  | "HOST_CAPACITY"
  | "CIRCUIT_OPEN"

/**
 * A supervisor lifecycle failure. Fatal for the incarnation that produced it.
 * Distinct from `ProtocolError` (schema) and `FramingError` (byte frame).
 */
export class SupervisorError extends errore.createTaggedError({
  name: "SupervisorError",
  message: "Supervisor failure [$code]: $reason",
}) {}
