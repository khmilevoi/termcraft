import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { ProcessTree } from "infrastructure/process"
import { createConfinementPolicy } from "agent/confinement"
import type { AgentTask } from "agent/types"
import { createCanUseTool } from "./can-use-tool"
import { planToSessionOptions } from "./session-options"
import { createSpawnAndAdopt } from "./spawn-adopt"
import { CLAUDE_CONFINEMENT_TABLES, CLAUDE_DISALLOWED_TOOLS } from "agent/claude/tools"

export interface QueryOptionDeps {
  readonly abortController: AbortController
  readonly processTree: ProcessTree
  /** Optional override for the CLI path in a compiled binary (Spike H compiled-parity). */
  readonly pathToClaudeCodeExecutable?: string
  /** Reparse backstop injected on Windows (Spike F). */
  readonly hasReparsePoint?: (p: string) => boolean
}

/**
 * Build the SDK `Options` for one fenced attempt. Binds cwd + only-writable-root
 * to staging, isolates settings (`settingSources:[]`), wires the deny-by-default
 * `canUseTool` veto (Spike H), and installs `spawnClaudeCodeProcess` so the CLI is
 * spawned by us and adopted into the owned Job Object (Spike I / §6.5).
 */
export function buildQueryOptions(task: AgentTask, deps: QueryOptionDeps): Options {
  const policy = createConfinementPolicy(task.workspacePath, CLAUDE_CONFINEMENT_TABLES, {
    hasReparsePoint: deps.hasReparsePoint,
  })
  const sessionOpts = planToSessionOptions(task.session)
  return {
    cwd: task.workspacePath,
    additionalDirectories: [],
    settingSources: [],
    permissionMode: "default",
    disallowedTools: [...CLAUDE_DISALLOWED_TOOLS],
    model: task.model,
    effort: task.effort,
    systemPrompt: task.systemPrompt,
    abortController: deps.abortController,
    includePartialMessages: false,
    ...(deps.pathToClaudeCodeExecutable !== undefined
      ? { pathToClaudeCodeExecutable: deps.pathToClaudeCodeExecutable }
      : {}),
    ...sessionOpts,
    canUseTool: createCanUseTool(policy),
    spawnClaudeCodeProcess: createSpawnAndAdopt(deps.processTree, "agent/query"),
  }
}
