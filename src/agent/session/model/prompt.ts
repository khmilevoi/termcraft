import type { AgentTask } from "agent/types";
import { trace } from "infrastructure/debug-log";

/**
 * The single-string prompt for one attempt. `resume` sends only the delta (or the
 * user message when the kernel supplied no delta — the SDK already holds history).
 * `fresh` prepends the bounded seed transcript (already selected by store) as
 * leading context, then the user message (storage-identity §6.2).
 */
export function buildPrompt(task: AgentTask): string {
  const prompt = (() => {
    if (task.session.kind === "resume") {
      return task.session.promptDelta ?? task.userMessage;
    }
    if (task.session.seed.length === 0) return task.userMessage;
    const transcript = task.session.seed
      .map((r) => (r.role === "user" ? `User: ${r.text}` : `Assistant: ${r.text}`))
      .join("\n\n");
    return `${transcript}\n\n${task.userMessage}`;
  })();

  // DIAGNOSTIC (infrastructure/debug-log): the exact prompt text handed to the agent backend is
  // otherwise never observable -- this is the one place it is assembled, for every session kind.
  trace("agent.session.promptBuilt", {
    sessionKind: task.session.kind,
    promptLength: prompt.length,
    prompt,
  });

  return prompt;
}
