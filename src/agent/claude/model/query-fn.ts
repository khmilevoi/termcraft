import { query } from "@anthropic-ai/claude-agent-sdk"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { ProcessTree } from "infrastructure/process"
import { createConfinementPolicy } from "agent/confinement"
import type { AgentTask } from "agent/types"
import type { ClaudeQuery, ClaudeQueryFn } from "../types"
import { planToSessionOptions } from "./session-plan"
import { makeSpawnAndAdopt } from "./spawn-adopt"
import { CLAUDE_CONFINEMENT_TABLES } from "./tool-tables"

/**
 * Production seam: the real SDK `query`. The SDK's `Query` (an
 * `AsyncGenerator<SDKMessage, void>` with `interrupt()`) satisfies
 * {@link ClaudeQuery} structurally, so this assigns WITHOUT a cast on purpose —
 * a cast here would silently absorb any future SDK signature drift instead of
 * failing the typecheck.
 */
export function createRealQueryFn(): ClaudeQueryFn {
  return (params) => query(params)
}

const DISALLOWED = ["Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch"]

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
    disallowedTools: DISALLOWED,
    model: task.model,
    effort: task.effort,
    systemPrompt: task.systemPrompt,
    abortController: deps.abortController,
    includePartialMessages: false,
    ...(deps.pathToClaudeCodeExecutable !== undefined
      ? { pathToClaudeCodeExecutable: deps.pathToClaudeCodeExecutable }
      : {}),
    ...sessionOpts,
    canUseTool: async (toolName, input, options) => {
      const decision = policy(toolName, input, options.blockedPath)
      return decision.behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: decision.message }
    },
    spawnClaudeCodeProcess: makeSpawnAndAdopt(deps.processTree, "agent/query-fn"),
  }
}
