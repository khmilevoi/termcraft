import type { AgentToolOp } from "entities/turn";

import { TARGET_FIELDS, toolOp } from "./vocabulary";

/** Map an SDK `tool_use` block to the UI's op + target (master §6.1). */
export function mapToolUse(
  name: string,
  input: Record<string, unknown>,
): { op: AgentToolOp; target: string } {
  const target = (() => {
    for (const field of TARGET_FIELDS) {
      const v = input[field];
      if (typeof v === "string") return v;
    }
    return "";
  })();
  return { op: toolOp(name), target };
}
