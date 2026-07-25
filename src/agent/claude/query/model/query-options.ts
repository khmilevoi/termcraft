import type { Options } from "@anthropic-ai/claude-agent-sdk";

import { CLAUDE_CONFINEMENT_TABLES, CLAUDE_DISALLOWED_TOOLS } from "agent/claude/tools";
import { createConfinementPolicy } from "agent/confinement";
import type { AgentTask } from "agent/types";

import type { QueryOptionDeps } from "../types";
import { createCanUseTool } from "./can-use-tool";
import { planToSessionOptions } from "./session-options";
import { createSpawnAndAdopt } from "./spawn-adopt";

/**
 * Build the SDK `Options` for one fenced attempt. Binds cwd + only-writable-root
 * to staging, isolates settings (`settingSources:[]`), wires the deny-by-default
 * `canUseTool` veto (Spike H), and installs `spawnClaudeCodeProcess` so the CLI is
 * spawned by us and adopted into the owned Job Object (Spike I / §6.5).
 */
export function buildQueryOptions(task: AgentTask, deps: QueryOptionDeps): Options {
  const policy = createConfinementPolicy(task.workspacePath, CLAUDE_CONFINEMENT_TABLES, {
    hasReparsePoint: deps.hasReparsePoint,
  });
  const sessionOpts = planToSessionOptions(task.session);
  return {
    cwd: task.workspacePath,
    additionalDirectories: [],
    settingSources: [],
    permissionMode: "default",
    disallowedTools: [...CLAUDE_DISALLOWED_TOOLS],
    model: task.model,
    effort: task.effort,
    // Adaptive thinking is already the SDK default for models that support it, but its DISPLAY
    // defaults to "omitted" — measured 2026-07-26: a live turn delivered 4 `thinking` blocks,
    // every one with a zero-length `thinking` string. Without this, `normalize.ts`'s thinking
    // branch maps empty text forever and the reasoning line the UI shows is really the interim
    // assistant `text` block. Asking for the summary is the only way to get reasoning content.
    thinking: { type: "adaptive", display: "summarized" },
    systemPrompt: task.systemPrompt,
    abortController: deps.abortController,
    includePartialMessages: false,
    ...(deps.pathToClaudeCodeExecutable !== undefined
      ? { pathToClaudeCodeExecutable: deps.pathToClaudeCodeExecutable }
      : {}),
    ...sessionOpts,
    canUseTool: createCanUseTool(policy),
    spawnClaudeCodeProcess: createSpawnAndAdopt(deps.processTree, "agent/query"),
  };
}
