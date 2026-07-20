import { isInsideStaging } from "./path-containment"

export type PermissionResultLike =
  | { readonly behavior: "allow" }
  | { readonly behavior: "deny"; readonly message: string }

/** File tools whose primary path argument must stay inside staging. */
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS"])
/** Tools denied outright regardless of arguments (master §6.1). */
const DENIED_TOOLS = new Set(["Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch"])

/** Field names, in order, that carry a tool's primary path argument. */
const PATH_FIELDS = ["file_path", "path", "notebook_path", "notebookPath"] as const

function primaryPath(input: Record<string, unknown>, blockedPath?: string): string | null {
  if (typeof blockedPath === "string") return blockedPath
  for (const field of PATH_FIELDS) {
    const v = input[field]
    if (typeof v === "string") return v
  }
  return null
}

/**
 * The deny-by-default confinement decision behind the SDK `canUseTool` callback
 * (master §6.1; confirmed by Spike H). Allows file tools only when their path is
 * inside `stagingRoot`; denies Bash + web + unknown tools. Defense-in-depth — the
 * Gate is the load-bearing wall.
 *
 * Non-Reatom: this module holds no atoms and owns no Reatom lifetime — it is a
 * pure decision function called synchronously from the SDK's `canUseTool`
 * callback (wired in T11), matching the module's `agent/` non-Reatom adapter
 * status (CLAUDE.md / plan Global Constraints).
 */
export function makeConfinementPolicy(
  stagingRoot: string,
  options?: { hasReparsePoint?: (p: string) => boolean },
) {
  return (
    toolName: string,
    input: Record<string, unknown>,
    blockedPath?: string,
  ): PermissionResultLike => {
    if (DENIED_TOOLS.has(toolName)) {
      return { behavior: "deny", message: `${toolName} is not permitted in a design turn` }
    }
    if (!FILE_TOOLS.has(toolName)) {
      return { behavior: "deny", message: `Tool ${toolName} is not on the design-turn allowlist` }
    }
    const target = primaryPath(input, blockedPath)
    if (target === null) {
      return { behavior: "deny", message: `${toolName} call has no resolvable path` }
    }
    if (!isInsideStaging(target, stagingRoot, options)) {
      return { behavior: "deny", message: `${toolName} target is outside the turn workspace` }
    }
    return { behavior: "allow" }
  }
}
