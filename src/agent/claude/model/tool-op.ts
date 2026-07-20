import type { AgentToolOp } from "entities/turn"

const OP_BY_TOOL: Record<string, AgentToolOp> = {
  Read: "read",
  Glob: "read",
  LS: "read",
  Write: "edit",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "run",
  Grep: "search",
  WebSearch: "search",
  WebFetch: "search",
}

const TARGET_FIELDS = ["file_path", "path", "notebook_path", "command", "pattern", "url"] as const

/** Map an SDK `tool_use` block to the UI's op + target (master §6.1). */
export function mapToolUse(
  name: string,
  input: Record<string, unknown>,
): { op: AgentToolOp; target: string } {
  const op = OP_BY_TOOL[name] ?? "other"
  const target = (() => {
    for (const field of TARGET_FIELDS) {
      const v = input[field]
      if (typeof v === "string") return v
    }
    return ""
  })()
  return { op, target }
}
