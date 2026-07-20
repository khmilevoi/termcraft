import { expect, test } from "bun:test"
import type { AgentTask } from "../types"
import { buildPrompt, planToSessionOptions } from "./session-plan"

const baseTask = (session: AgentTask["session"]): AgentTask => ({
  fence: { turnId: "t", attempt: 0, leaseNonce: "n" },
  workspacePath: "C:\\ws",
  systemPrompt: "sys",
  userMessage: "make the gauge red",
  model: "claude-opus-4-8",
  effort: "high",
  session,
})

test("a resume plan passes resume:sessionId and forkSession:false", () => {
  expect(planToSessionOptions({ kind: "resume", sessionId: "s9", promptDelta: null })).toEqual({
    resume: "s9",
    forkSession: false,
  })
})

test("a fresh plan carries no resume id", () => {
  expect(planToSessionOptions({ kind: "fresh", seed: [] })).toEqual({ forkSession: false })
})

test("a resume prompt uses the delta when present, else the user message", () => {
  const withDelta = baseTask({ kind: "resume", sessionId: "s", promptDelta: "gate errors: X" })
  expect(buildPrompt(withDelta)).toBe("gate errors: X")
  const noDelta = baseTask({ kind: "resume", sessionId: "s", promptDelta: null })
  expect(buildPrompt(noDelta)).toBe("make the gauge red")
})

test("a fresh prompt prepends the seed transcript before the user message", () => {
  const task = baseTask({
    kind: "fresh",
    seed: [
      { role: "user", text: "add a cpu gauge" },
      { role: "agent", text: "Added the CPU gauge." },
    ],
  })
  const prompt = buildPrompt(task)
  expect(prompt).toContain("add a cpu gauge")
  expect(prompt).toContain("Added the CPU gauge.")
  expect(prompt.endsWith("make the gauge red")).toBe(true)
})
