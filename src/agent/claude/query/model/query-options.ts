import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

import {
  CLAUDE_CONFINEMENT_TABLES,
  CLAUDE_DISALLOWED_TOOLS,
  TERMCRAFT_MCP_SERVER_NAME,
  createTermcraftMcpTools,
} from "agent/claude/tools";
import { createConfinementPolicy } from "agent/confinement";
import type { AgentTask } from "agent/types";
import { trace } from "infrastructure/debug-log";

import type { QueryOptionDeps } from "../types";
import { createCanUseTool } from "./can-use-tool";
import { planToSessionOptions } from "./session-options";
import { createSpawnAndAdopt } from "./spawn-adopt";

/**
 * Build the SDK `Options` for one fenced attempt. Binds cwd + only-writable-root
 * to staging, isolates settings (`settingSources:[]`), wires the deny-by-default
 * `canUseTool` veto (Spike H), and installs `spawnClaudeCodeProcess` so the CLI is
 * spawned by us and adopted into the owned Job Object (Spike I / §6.5).
 *
 * REGISTERS THE IN-PROCESS `check_design` SERVER (spec WP-10). `mcpServers` sits in the SAME
 * literal as `settingSources: []`, and that interaction is not incidental: MCP servers are
 * ordinarily a settings-level concept, and spike 11 Q2/Q4 confirmed — by construction against
 * this exact function, then by a live turn — that an `Options.mcpServers` entry survives the
 * settings isolation AND reaches the model through `createSpawnAndAdopt`'s intercepted CLI
 * spawn. `disallowedTools` is untouched: this adds one allowed capability and widens nothing.
 */
export function buildQueryOptions(task: AgentTask, deps: QueryOptionDeps): Options {
  const policy = createConfinementPolicy(task.workspacePath, CLAUDE_CONFINEMENT_TABLES, {
    hasReparsePoint: deps.hasReparsePoint,
  });
  const sessionOpts = planToSessionOptions(task.session);
  // Bound to THIS attempt's workspace, which is what makes the tool pathless: the root is
  // captured here, never taken as a tool argument (correction C9).
  const mcpTools = createTermcraftMcpTools(deps.designChecker, task.workspacePath);
  const options: Options = {
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
    mcpServers: {
      [TERMCRAFT_MCP_SERVER_NAME]: createSdkMcpServer({
        name: TERMCRAFT_MCP_SERVER_NAME,
        tools: mcpTools,
      }),
    },
    spawnClaudeCodeProcess: createSpawnAndAdopt(deps.processTree, "agent/query"),
  };
  // DIAGNOSTIC (infrastructure/debug-log): the SDK query configuration for this attempt -- model,
  // effort, session resume/fresh, cwd -- otherwise only inferable indirectly from its effects.
  trace("agent.claude.queryOptions.built", {
    model: task.model,
    effort: task.effort,
    sessionKind: task.session.kind,
    workspacePath: task.workspacePath,
    disallowedToolsCount: CLAUDE_DISALLOWED_TOOLS.length,
    // DERIVED FROM THE ARRAY ACTUALLY REGISTERED, never a literal: a tool silently dropped from
    // `createTermcraftMcpTools` would otherwise still trace as present.
    mcpToolCount: mcpTools.length,
    thinking: options.thinking,
  });
  return options;
}
