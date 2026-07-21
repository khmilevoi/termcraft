import { query } from "@anthropic-ai/claude-agent-sdk"
import type { ClaudeQueryFn } from "agent/claude/types"

/**
 * Production seam: the real SDK `query`. The SDK's `Query` satisfies
 * {@link ClaudeQuery} structurally, so this assigns WITHOUT a cast on purpose —
 * a cast would silently absorb future SDK signature drift instead of failing
 * the typecheck.
 */
export function createRealQueryFn(): ClaudeQueryFn {
  return (params) => query(params)
}
