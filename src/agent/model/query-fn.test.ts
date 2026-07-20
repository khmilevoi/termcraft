import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk"
import type { ProcessTree } from "infrastructure/process"
import { createFakeProcessTree } from "infrastructure/process"
import type { AgentTask } from "../types"
import { buildQueryOptions } from "./query-fn"

const staging = path.resolve("C:\\ws")
const task: AgentTask = {
  fence: { turnId: "t", attempt: 0, leaseNonce: "n" },
  workspacePath: staging,
  systemPrompt: "role + rules",
  userMessage: "make the gauge red",
  model: "claude-opus-4-8",
  effort: "high",
  session: { kind: "fresh", seed: [] },
}

test("options bind cwd to staging, isolate settings, and deny web/bash", () => {
  const opts = buildQueryOptions(task, {
    abortController: new AbortController(),
    processTree: createFakeProcessTree({ counts: [1] }),
  })
  expect(opts.cwd).toBe(staging)
  expect(opts.additionalDirectories).toEqual([])
  expect(opts.settingSources).toEqual([])
  expect(opts.disallowedTools).toContain("Bash")
  expect(opts.disallowedTools).toContain("WebFetch")
  expect(opts.model).toBe("claude-opus-4-8")
  expect(opts.effort).toBe("high")
})

test("canUseTool denies an out-of-staging write and allows an in-staging edit", async () => {
  const opts = buildQueryOptions(task, {
    abortController: new AbortController(),
    processTree: createFakeProcessTree({ counts: [1] }),
  })
  const deny = await opts.canUseTool!(
    "Write",
    { file_path: "C:\\Users\\x\\ok.txt", content: "y" },
    { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" },
  )
  expect(deny?.behavior).toBe("deny")
  const allow = await opts.canUseTool!(
    "Write",
    { file_path: path.join(staging, "pages", "main.tsx"), content: "y" },
    { signal: new AbortController().signal, toolUseID: "t2", requestId: "r2" },
  )
  expect(allow?.behavior).toBe("allow")
})

test("a resume plan sets resume and forkSession:false", () => {
  const opts = buildQueryOptions(
    { ...task, session: { kind: "resume", sessionId: "s9", promptDelta: null } },
    { abortController: new AbortController(), processTree: createFakeProcessTree({ counts: [1] }) },
  )
  expect(opts.resume).toBe("s9")
  expect(opts.forkSession).toBe(false)
})

/** A `ProcessTree` fake that records every `adopt(pid)` call for assertion. */
function createRecordingProcessTree(): { tree: ProcessTree; adoptedPids: number[] } {
  const adoptedPids: number[] = []
  return {
    tree: {
      adopt: (pid: number) => {
        adoptedPids.push(pid)
        return null
      },
      activeProcesses: () => 1,
      terminate: () => null,
      close: () => {},
    },
    adoptedPids,
  }
}

const spawnedChildren: SpawnedProcess[] = []
afterEach(() => {
  for (const child of spawnedChildren.splice(0)) child.kill("SIGTERM")
})

test("spawnClaudeCodeProcess actually spawns the CLI and adopts its real pid into the process tree", async () => {
  const { tree, adoptedPids } = createRecordingProcessTree()
  const opts = buildQueryOptions(task, {
    abortController: new AbortController(),
    processTree: tree,
  })
  expect(opts.spawnClaudeCodeProcess).toBeDefined()

  const child = opts.spawnClaudeCodeProcess!({
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    env: process.env as Record<string, string | undefined>,
    signal: new AbortController().signal,
  })
  spawnedChildren.push(child)

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code))
  })

  expect(exitCode).toBe(0)
  expect(adoptedPids.length).toBe(1)
  expect(adoptedPids[0]).toBeGreaterThan(0)
})
