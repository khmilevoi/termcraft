import * as errore from "errore";

/**
 * Stable codes for failures raised at the Claude SDK boundary (spawn, stream,
 * abort). These are INTERNAL — the adapter maps them to `AgentRunOutcome` /
 * `AgentEvent` values and never rethrows past its own surface.
 *
 * `STREAM_FAILED` and `SPAWN_FAILED` are the codes actually raised at the SDK
 * boundary.
 */
export type AgentErrorCode = "SPAWN_FAILED" | "STREAM_FAILED";

/**
 * A failure crossing the `@anthropic-ai/claude-agent-sdk` boundary.
 *
 * `createTaggedError`'s `$code` template variable types the property as
 * `string | number` (its factory has no way to narrow one specific
 * $variable) — left alone, `code: "STREAM_FAILURE"` (a typo for
 * `STREAM_FAILED`) would compile silently and any `err.code` switch would
 * fall through unnoticed. The constructor override below re-narrows the
 * public constructor signature to `AgentErrorCode`, so a mismatched code is a
 * compile error instead of a runtime misclassification.
 */
export class ClaudeSdkError extends errore.createTaggedError({
  name: "ClaudeSdkError",
  message: "Claude SDK failure [$code]: $reason",
}) {
  constructor(args: { code: AgentErrorCode; reason: string | number; cause?: unknown }) {
    super(args);
  }
}
