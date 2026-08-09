import type { Options } from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeQueryFn } from "agent/claude/types";
import type { SessionPlan } from "agent/types";

export interface ClaudeDriverParams {
  readonly queryFn: ClaudeQueryFn;
  readonly prompt: string;
  readonly options: Options;
  /**
   * This attempt's own `SessionPlan.kind` — carried alongside `options` (which already encodes
   * the SDK-level `resume`/`forkSession` choice) so the driver can apply spike 12's structural
   * resume-rejection classifier (`classify-backend-error.ts`) without re-deriving the plan kind
   * from `options` itself. Condition 1 of that classifier: a fresh-session run must never be
   * classified as a rejected resume.
   */
  readonly sessionKind: SessionPlan["kind"];
}
