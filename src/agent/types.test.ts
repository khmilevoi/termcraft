import { expect, test } from "bun:test"
import type { TurnFence } from "entities/turn"
import type {
  AgentBackend,
  AgentRunOutcome,
  AgentTask,
  ReasoningEffort,
  SessionPlan,
} from "./types"

test("AgentTask carries workspace, fence, model, effort, and a session plan", () => {
  const fence: TurnFence = { turnId: "019a", attempt: 0, leaseNonce: "n0" }
  const task: AgentTask = {
    fence,
    workspacePath: "C:\\state\\sandboxes\\k\\turns\\019a\\workspace",
    systemPrompt: "role + rules",
    userMessage: "make the gauge red",
    model: "claude-opus-4-8",
    effort: "high",
    session: { kind: "fresh", seed: [] },
  }
  expect(task.session.kind).toBe("fresh")
})

test("AgentRunOutcome discriminates the four terminal shapes", () => {
  const outcomes: AgentRunOutcome[] = [
    { kind: "completed", finalText: "done", usage: null, sessionId: "sess-1" },
    { kind: "backend-error", message: "auth failed", sessionId: null },
    { kind: "cancelled", exitConfirmed: true },
    { kind: "unconfirmed-exit" },
  ]
  expect(outcomes.map((o) => o.kind)).toEqual([
    "completed",
    "backend-error",
    "cancelled",
    "unconfirmed-exit",
  ])
})

test("ReasoningEffort matches the SDK EffortLevel value set", () => {
  const all: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"]
  expect(all).toHaveLength(5)
})

test("a SessionPlan is either resume or fresh", () => {
  const resume: SessionPlan = { kind: "resume", sessionId: "s", promptDelta: null }
  const fresh: SessionPlan = { kind: "fresh", seed: [{ role: "user", text: "hi" }] }
  expect([resume.kind, fresh.kind]).toEqual(["resume", "fresh"])
})

test("AgentBackend exposes the five port methods", () => {
  const shape: (keyof AgentBackend)[] = [
    "startTurn",
    "cancel",
    "healthCheck",
    "capabilities",
    "sessionScope",
  ]
  expect(shape).toHaveLength(5)
})
