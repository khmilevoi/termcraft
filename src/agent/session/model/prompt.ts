import type { AgentTask } from "agent/types";

/**
 * The single-string prompt for one attempt. `resume` sends only the delta (or the
 * user message when the kernel supplied no delta — the SDK already holds history).
 * `fresh` prepends the bounded seed transcript (already selected by store) as
 * leading context, then the user message (storage-identity §6.2).
 */
export function buildPrompt(task: AgentTask): string {
  if (task.session.kind === "resume") {
    return task.session.promptDelta ?? task.userMessage;
  }
  if (task.session.seed.length === 0) return task.userMessage;
  const transcript = task.session.seed
    .map((r) => (r.role === "user" ? `User: ${r.text}` : `Assistant: ${r.text}`))
    .join("\n\n");
  return `${transcript}\n\n${task.userMessage}`;
}
