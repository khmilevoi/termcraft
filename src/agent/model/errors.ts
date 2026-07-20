import * as errore from "errore"

/**
 * Stable codes for failures raised at the Claude SDK boundary (spawn, stream,
 * abort). These are INTERNAL — the adapter maps them to `AgentRunOutcome` /
 * `AgentEvent` values and never rethrows past its own surface.
 */
export type AgentErrorCode = "SPAWN_FAILED" | "STREAM_FAILED" | "ABORTED" | "RESULT_ERROR"

/** A failure crossing the `@anthropic-ai/claude-agent-sdk` boundary. */
export class ClaudeSdkError extends errore.createTaggedError({
  name: "ClaudeSdkError",
  message: "Claude SDK failure [$code]: $reason",
}) {}

/** A healthCheck probe failure (installed/logged-in classification). */
export class AgentHealthProbeError extends errore.createTaggedError({
  name: "AgentHealthProbeError",
  message: "Agent health probe failed: $reason",
}) {}
