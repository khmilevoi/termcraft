import * as errore from "errore"

/**
 * Stable diagnostic codes for host-protocol violations (host-supervision §12).
 * 2A only ever produces MALFORMED_PROTOCOL, OVERSIZED_MESSAGE, and
 * FRAME_TOO_LARGE; the negotiation-outcome codes exist so the supervisor (2D)
 * reuses this one error type when it decides a handshake failed.
 */
export type ProtocolViolationCode =
  | "MALFORMED_PROTOCOL"
  | "OVERSIZED_MESSAGE"
  | "FRAME_TOO_LARGE"
  | "PROTOCOL_NEGOTIATION_FAILED"
  | "RUNTIME_INTEGRITY_MISMATCH"
  | "KIT_API_MISMATCH"

/**
 * A host-protocol schema violation. Fatal for the incarnation that produced it:
 * the protocol never resynchronizes after malformed input (§5). Distinct from
 * `infrastructure/framing`'s `FramingError`, which covers the byte-frame layer.
 */
export class ProtocolError extends errore.createTaggedError({
  name: "ProtocolError",
  message: "Protocol violation [$code]: $reason",
}) {}
