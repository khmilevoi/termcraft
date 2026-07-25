import type { AgentPromptContextV1, AgentPromptSource } from "core/ports";

import { buildRuntimeDocs } from "./runtime-docs";
import { buildSystemPrompt } from "./system-prompt";

/** The one production `AgentPromptSource` (phase-8 WP-3) — pure prose composition plus static file paths; no I/O beyond the existence checks `runtime-docs.ts` already performs. */
export function createProductionAgentPromptSource(): AgentPromptSource {
  return {
    systemPrompt: (context: AgentPromptContextV1) => buildSystemPrompt(context),
    runtimeDocs: () => buildRuntimeDocs(),
  };
}
