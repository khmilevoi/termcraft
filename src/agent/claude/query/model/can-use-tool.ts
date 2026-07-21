import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk"
import type { PermissionResultLike } from "agent/confinement"

type Policy = (toolName: string, input: Record<string, unknown>, blockedPath?: string) => PermissionResultLike

/**
 * Adapt a shared confinement policy to the SDK's `canUseTool` callback. The
 * shared tier deliberately declares its own `PermissionResultLike` rather than
 * importing the SDK's `PermissionResult`, so this one-way adapter is where the
 * vendor shape is put back on — in the vendor tier, where the SDK type is
 * already in scope.
 */
export function createCanUseTool(policy: Policy): CanUseTool {
  return async (toolName, input, options) => {
    const decision = policy(toolName, input, options.blockedPath)
    return decision.behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: decision.message }
  }
}
