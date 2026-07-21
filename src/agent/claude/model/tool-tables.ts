import type { ConfinementTables } from "agent/confinement"

/**
 * File tools whose schema REQUIRES a path argument — verified against the
 * installed `@anthropic-ai/claude-agent-sdk`'s `sdk-tools.d.ts`:
 * `FileReadInput.file_path`, `FileWriteInput.file_path`,
 * `FileEditInput.file_path`, and `NotebookEditInput.notebook_path` are all
 * non-optional. A call to one of these tools that carries none of
 * `PATH_FIELDS` is therefore malformed — most plausibly finding [13]'s
 * concern, an SDK field rename — and must stay denied.
 *
 * `MultiEdit` has no `MultiEditInput` in the installed `sdk-tools.d.ts` at
 * all (this SDK build folds multi-edit into `Edit`); kept here purely
 * defensively/inertly for an older or future SDK build that reintroduces it,
 * matching its historical schema (also a required `file_path`).
 */
const PATH_REQUIRED_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"])

/**
 * File tools whose schema documents `path` as OPTIONAL, defaulting to the
 * process's current working directory — verified against `sdk-tools.d.ts`:
 * `GlobInput.path` ("If not specified, the current working directory will be
 * used") and `GrepInput.path` ("Defaults to current working directory").
 * `buildQueryOptions` (query-fn.ts) sets `cwd: task.workspacePath`, i.e. the
 * agent's own cwd IS the staging root, so a call to one of these tools with
 * no path means "search/list the staging root itself" — resolving it there
 * (in `agent/model/confinement.ts`) and allowing is finding [33]'s correct
 * reading applied to the missing-path case, not a confinement weakening:
 * denying it would only stop the agent from searching its own workspace and
 * burn gate retries (finding [33] vs [13] tension, resolved in favor of this
 * split).
 *
 * `LS` has no schema in the installed `sdk-tools.d.ts` at all — this SDK
 * build has no `LS`-named tool, so this entry is currently inert (the SDK
 * will never call `canUseTool` with this name). Kept here defensively,
 * matching `LS`'s well-known historical semantics (directory listing,
 * optional path defaulting to cwd) from earlier tool surfaces; re-verify
 * against the schema if the SDK ever reintroduces an `LS` tool.
 */
const OPTIONAL_PATH_TOOLS = new Set(["Grep", "Glob", "LS"])

/** File tools whose primary path argument must stay inside staging. */
const FILE_TOOLS = new Set([...PATH_REQUIRED_TOOLS, ...OPTIONAL_PATH_TOOLS])
/** Tools denied outright regardless of arguments (master §6.1). */
const DENIED_TOOLS = new Set(["Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch"])

/** Field names, in order, that carry a tool's primary path argument. */
const PATH_FIELDS = ["file_path", "path", "notebook_path", "notebookPath"] as const

/**
 * Claude Code's tool vocabulary, wired into the shared deny-by-default
 * confinement RULE (`agent/model/confinement.ts`'s `makeConfinementPolicy`).
 * A future Codex backend supplies its own `ConfinementTables` here instead of
 * reusing this one — the tool names below are Claude Code specific.
 */
export const CLAUDE_CONFINEMENT_TABLES: ConfinementTables = {
  fileTools: FILE_TOOLS,
  deniedTools: DENIED_TOOLS,
  optionalPathTools: OPTIONAL_PATH_TOOLS,
  pathFields: PATH_FIELDS,
}
