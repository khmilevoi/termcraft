import { isInsideStaging } from "./path-containment"

export type PermissionResultLike =
  | { readonly behavior: "allow" }
  | { readonly behavior: "deny"; readonly message: string }

/**
 * The vendor tool vocabulary a confinement policy is parameterized over
 * (master §6.1 confinement; Spike H). Each backend (Claude Code today, a
 * future Codex backend later) supplies its OWN tables — the tool names and
 * path-field names a backend's tool-use protocol uses are backend-specific,
 * while the deny-by-default RULE below them is not.
 */
export interface ConfinementTables {
  /** File tools whose primary path argument must stay inside staging. */
  readonly fileTools: ReadonlySet<string>
  /** Tools denied outright regardless of arguments. */
  readonly deniedTools: ReadonlySet<string>
  /** File tools whose path argument is optional, defaulting to the process cwd. */
  readonly optionalPathTools: ReadonlySet<string>
  /** Field names, in order, that carry a tool's primary path argument. */
  readonly pathFields: readonly string[]
}

function primaryPath(
  pathFields: readonly string[],
  input: Record<string, unknown>,
  blockedPath?: string,
): string | null {
  if (typeof blockedPath === "string") return blockedPath
  for (const field of pathFields) {
    const v = input[field]
    if (typeof v === "string") return v
  }
  return null
}

/**
 * The deny-by-default confinement decision behind a backend's tool-permission
 * callback (master §6.1; confirmed by Spike H for Claude Code's `canUseTool`).
 * Allows file tools only when their path is inside `stagingRoot`; denies
 * run/web + unknown tools. Defense-in-depth — the Gate is the load-bearing
 * wall.
 *
 * `tables` is the backend's own tool vocabulary (see {@link ConfinementTables}) —
 * this function itself knows no vendor tool names, only the RULE: deny by
 * default, allow a file tool only when its resolved path stays inside
 * `stagingRoot`.
 *
 * Non-Reatom: this module holds no atoms and owns no Reatom lifetime — it is a
 * pure decision function called synchronously from a backend's own
 * tool-permission callback, matching the module's `agent/` non-Reatom adapter
 * status (CLAUDE.md / plan Global Constraints).
 */
export function makeConfinementPolicy(
  stagingRoot: string,
  tables: ConfinementTables,
  options?: { hasReparsePoint?: (p: string) => boolean },
) {
  return (
    toolName: string,
    input: Record<string, unknown>,
    blockedPath?: string,
  ): PermissionResultLike => {
    if (tables.deniedTools.has(toolName)) {
      return { behavior: "deny", message: `${toolName} is not permitted in a design turn` }
    }
    if (!tables.fileTools.has(toolName)) {
      return { behavior: "deny", message: `Tool ${toolName} is not on the design-turn allowlist` }
    }
    // [13]/[33]: a path-less call resolves to the staging root ITSELF only
    // for tools whose schema documents `path` as optional-defaulting-to-cwd
    // (see `tables.optionalPathTools`) — "no path" means "here", and "here" is
    // staging. Every other file tool still denies outright on a missing path
    // (finding [13]'s protection, preserved exactly where it matters: a
    // schema rename on a WRITE tool still denies).
    const target =
      primaryPath(tables.pathFields, input, blockedPath) ?? (tables.optionalPathTools.has(toolName) ? stagingRoot : null)
    if (target === null) {
      return { behavior: "deny", message: `${toolName} call has no resolvable path` }
    }
    if (!isInsideStaging(target, stagingRoot, options)) {
      return { behavior: "deny", message: `${toolName} target is outside the turn workspace` }
    }
    return { behavior: "allow" }
  }
}
