import type { Options } from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeQueryFn } from "agent/claude/types";

export interface ClaudeDriverParams {
  readonly queryFn: ClaudeQueryFn;
  readonly prompt: string;
  readonly options: Options;
}
