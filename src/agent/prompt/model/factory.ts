import type { AgentPromptContextV1, AgentPromptSource } from "core/ports";
import { trace } from "infrastructure/debug-log";

import { buildRuntimeDocs } from "./runtime-docs";
import { buildSystemPrompt } from "./system-prompt";

/** The one production `AgentPromptSource` (phase-8 WP-3) — pure prose composition plus static file paths; no I/O beyond the existence checks `runtime-docs.ts` already performs. */
export function createProductionAgentPromptSource(): AgentPromptSource {
  return {
    systemPrompt: (context: AgentPromptContextV1) => {
      const prompt = buildSystemPrompt(context);
      // DIAGNOSTIC (infrastructure/debug-log): the exact system prompt composed for this turn --
      // otherwise only reconstructable by re-running buildSystemPrompt against the same context.
      trace("agent.prompt.systemPromptBuilt", {
        activePageSlug: context.activePageSlug,
        pageCount: context.pageOrder.length,
        openPinsCount: context.openPins.length,
        promptLength: prompt.length,
        systemPrompt: prompt,
      });
      return prompt;
    },
    runtimeDocs: () => buildRuntimeDocs(),
  };
}
