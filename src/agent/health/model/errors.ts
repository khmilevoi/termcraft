import * as errore from "errore";

/** A healthCheck probe failure (installed/logged-in classification). Generic across backends. */
export class AgentHealthProbeError extends errore.createTaggedError({
  name: "AgentHealthProbeError",
  message: "Agent health probe failed: $reason",
}) {}
