import { spawn } from "node:child_process"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { Options, SDKMessage, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"
import type { ProcessTree } from "infrastructure/process"
import type { AgentTask } from "../types"
import { makeConfinementPolicy } from "./confinement"
import { planToSessionOptions } from "./session-plan"

/** The minimal SDK surface the run loop consumes (injection seam, mirrors host's SpawnedChild). */
export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>
}

/** Injected query seam: production wraps the SDK `query`, tests script an async generator. */
export type ClaudeQueryFn = (params: { prompt: string; options: Options }) => ClaudeQuery

/** Production seam: the real SDK `query`. */
export function createRealQueryFn(): ClaudeQueryFn {
  return (params) => query(params) as unknown as ClaudeQuery
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
 * Spawns the Claude CLI ourselves (instead of letting the SDK spawn it
 * internally) so the resulting `ChildProcess` — and its `.pid` — can be
 * adopted into the injected `ProcessTree` (owned Job Object, Spike I / §6.5).
 * A real Node `ChildProcess` satisfies the SDK's `SpawnedProcess` interface.
 *
 * Non-Reatom: this closure owns no Reatom lifetime — the spawned process and
 * its Job Object membership are explicit, adapter-owned state (CLAUDE.md /
 * plan Global Constraints), matching `agent/`'s non-Reatom adapter status.
 */
function makeSpawnClaudeCodeProcess(processTree: ProcessTree): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      // `options.signal` is the SDK's forwarded graceful signal — safe to pass.
      signal: options.signal,
    })

    if (typeof child.pid !== "number") {
      console.warn("agent/query-fn: spawned CLI process has no pid, cannot adopt it into the owned process tree")
      return child as unknown as SpawnedProcess
    }

    const adopted = processTree.adopt(child.pid)
    if (adopted instanceof Error) {
      console.warn(`agent/query-fn: adopt(${child.pid}) failed, process tree may not own the CLI:`, adopted.message)
      return child as unknown as SpawnedProcess
    }

    // The assign-before-descendant-spawn race is not OS-guaranteed (no
    // `CREATE_SUSPENDED` reachable from Bun/Node spawn) — re-read
    // `activeProcesses()` to verify membership rather than assume the
    // `adopt` call above actually landed the process in the job.
    const verified = processTree.activeProcesses()
    if (verified instanceof Error) {
      console.warn(`agent/query-fn: activeProcesses() re-read after adopt(${child.pid}) failed:`, verified.message)
    } else if (verified < 1) {
      console.warn(
        `agent/query-fn: activeProcesses() re-read reported ${verified} immediately after adopt(${child.pid})`,
      )
    }

    return child as unknown as SpawnedProcess
  }
}

/**
 * Build the SDK `Options` for one fenced attempt. Binds cwd + only-writable-root
 * to staging, isolates settings (`settingSources:[]`), wires the deny-by-default
 * `canUseTool` veto (Spike H), and installs `spawnClaudeCodeProcess` so the CLI is
 * spawned by us and adopted into the owned Job Object (Spike I / §6.5).
 */
export function buildQueryOptions(task: AgentTask, deps: QueryOptionDeps): Options {
  const policy = makeConfinementPolicy(task.workspacePath, { hasReparsePoint: deps.hasReparsePoint })
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
    spawnClaudeCodeProcess: makeSpawnClaudeCodeProcess(deps.processTree),
  }
}
