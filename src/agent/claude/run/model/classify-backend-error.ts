import type { SDKResultError } from "@anthropic-ai/claude-agent-sdk";

import type { BackendErrorCause, SessionPlan } from "agent/types";

/**
 * The SDK's own measured rejection text for an unresolvable resume, quoted verbatim
 * (spike 12, `docs/spikes/12-resume-rejection/SPIKE.md`, `@anthropic-ai/claude-agent-sdk@0.3.212`,
 * observations A and D):
 *
 *   "No conversation found with session ID: b40c398a-…"
 *
 * Matched as a substring — never the whole sentence — so a session id suffix never breaks it.
 */
const RESUME_REJECTED_TEXT = "No conversation found with session ID";

/**
 * Classify a non-success `result` message as a rejected resume, on the STRUCTURAL signal spike
 * 12 measured rather than the vendor's English sentence alone. `core` may not know the SDK's
 * error shape (module DAG: `agent` may not be imported by `core`, and classification belongs in
 * the ONE layer that knows this vendor's format) — this file is that layer.
 *
 * ALL FOUR conditions are required, IN THIS ORDER (spike 12, section S5):
 *
 *  1. `sessionKind === "resume"` — THIS RUN's own `SessionPlan.kind`. A fresh-session run never
 *     asked the SDK to resume anything, so it cannot produce a rejected resume by definition;
 *     classifying one anyway would send the turn driver into a fallback for a fault the fallback
 *     cannot fix (`fallbackToFreshSession` builds another fresh session — a no-op against a
 *     fresh-session failure). This guard is checked FIRST and is what makes the remaining,
 *     text-based check safe: it can only ever fire on a run that already asked for a resume.
 *  2. `msg.is_error === true` — the SDK's own error flag on the result message.
 *  3. `msg.num_turns === 0` — the API was never called. Measured (spike 12): both the fabricated-
 *     id and wrong-cwd observations reported `num_turns: 0, duration_api_ms: 0, total_cost_usd: 0`.
 *     A design page's own text cannot fabricate this field — it is what turns condition 4's text
 *     match from a guess into a confirmation, not a coincidence.
 *  4. Only then, `msg.errors[]` contains the measured string above.
 *
 * `msg.subtype === "error_during_execution"` is DELIBERATELY NOT used as a standalone
 * discriminator — spike 12 found it is the SDK's generic execution-error subtype, which also
 * covers unrelated failures (max-turns, max-budget, structured-output retries share sibling
 * subtypes, and `error_during_execution` itself is not resume-specific).
 */
export function classifyBackendErrorCause(
  sessionKind: SessionPlan["kind"],
  msg: SDKResultError,
): BackendErrorCause {
  if (sessionKind !== "resume") return null;
  if (msg.is_error !== true) return null;
  if (msg.num_turns !== 0) return null;

  const errors = Array.isArray(msg.errors) ? msg.errors : [];
  const rejected = errors.some((text) => text.includes(RESUME_REJECTED_TEXT));
  return rejected ? "resume-rejected" : null;
}
