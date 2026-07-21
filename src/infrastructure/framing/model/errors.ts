import * as errore from "errore";

/**
 * A framing violation. Fatal for the stream that produced it: after a lost
 * frame boundary, resynchronization could reinterpret attacker-controlled
 * payload bytes as a fresh header (host-supervision §5).
 */
export class FramingError extends errore.createTaggedError({
  name: "FramingError",
  message: "Framing violation: $reason",
}) {}
