import type { ConfinementTables } from "agent/confinement";
import type { AgentToolOp } from "entities/turn";

import { CHECK_DESIGN_TOOL_NAME } from "./check-design-tool";

/**
 * One Claude Code tool. `op` and `access` are deliberately ORTHOGONAL: a denied
 * tool can still appear in a `tool_use` block before the `canUseTool` veto
 * fires, and the UI must still render it — so `Bash` carries both `op: "run"`
 * and `access: "denied"`.
 *
 * `access`:
 *  - `path-confined` — schema REQUIRES a path; a call carrying none is
 *    malformed and stays denied.
 *  - `path-optional` — schema documents `path` as optional, defaulting to cwd:
 *    `GlobInput.path` — "If not specified, the current working directory will
 *    be used"; `GrepInput.path` — "Defaults to current working directory".
 *    The agent's cwd IS the staging root (`buildQueryOptions`), so a path-less
 *    call means "the staging root itself" and resolves there.
 *  - `pathless-allowed` — allowed, and carries NO path argument at all, so
 *    there is nothing for confinement to resolve or aim (see
 *    `ConfinementTables.pathlessAllowedTools`). Distinct from `path-optional`,
 *    which is a statement about a path argument that exists and defaults to
 *    the cwd.
 *  - `denied` — refused outright regardless of arguments (master §6.1).
 */
interface ClaudeTool {
  readonly name: string;
  readonly op: AgentToolOp;
  readonly access: "denied" | "path-confined" | "path-optional" | "pathless-allowed";
}

/**
 * Verified against the installed `@anthropic-ai/claude-agent-sdk`'s
 * `sdk-tools.d.ts`. Every `path-confined` entry's path field is non-optional
 * there: `FileReadInput.file_path`, `FileWriteInput.file_path`,
 * `FileEditInput.file_path`, `NotebookEditInput.notebook_path`.
 *
 * Two entries are currently INERT — this SDK build has no `MultiEdit` and no
 * `LS` tool, so `canUseTool` will never be called with those names. They are
 * kept defensively, matching their historical schemas, for an older or
 * future SDK build that reintroduces them; re-verify against the schema if
 * that happens.
 */
const CLAUDE_TOOLS: readonly ClaudeTool[] = [
  { name: "Read", op: "read", access: "path-confined" },
  { name: "Write", op: "edit", access: "path-confined" },
  { name: "Edit", op: "edit", access: "path-confined" },
  { name: "MultiEdit", op: "edit", access: "path-confined" },
  { name: "NotebookEdit", op: "edit", access: "path-confined" },
  { name: "Glob", op: "read", access: "path-optional" },
  { name: "LS", op: "read", access: "path-optional" },
  { name: "Grep", op: "search", access: "path-optional" },
  { name: "Bash", op: "run", access: "denied" },
  { name: "BashOutput", op: "run", access: "denied" },
  { name: "KillShell", op: "run", access: "denied" },
  { name: "WebFetch", op: "search", access: "denied" },
  { name: "WebSearch", op: "search", access: "denied" },
  // THE ONE NEW CAPABILITY (spec WP-10): the agent's in-process design self-check. `op: "other"`
  // because it is none of read/edit/run/search of a file — it runs the Gate's whole-tree stages
  // in this process against the workspace the tool was built with.
  { name: CHECK_DESIGN_TOOL_NAME, op: "other", access: "pathless-allowed" },
  // NOT A SECOND CAPABILITY — THE TRANSPORT THE FIRST ONE ARRIVES BY, and an explicit decision
  // rather than a bet on the SDK's behaviour of the month (spike 11, S4).
  //
  // MEASURED: in the live tier-2 run the model emitted TWO `tool_use` blocks — `ToolSearch`
  // first, then `mcp__termcraft__check_design` — while `canUseTool` was asked about only the
  // second. So MCP tools are surfaced as DEFERRED tools the model must fetch a schema for
  // first, and today that fetch bypasses the veto entirely. If a future SDK routes `ToolSearch`
  // through `canUseTool`, deny-by-default refuses it and `check_design` becomes UNREACHABLE:
  // advertised and never callable, which the plan names as strictly worse than no tool.
  //
  // ALLOWING IT WIDENS NOTHING SUBSTANTIVE. `ToolSearch` fetches tool SCHEMAS; it performs no
  // filesystem, network or process I/O of its own, and it cannot grant a tool the rest of this
  // table denies — `Bash` and the other four stay in `disallowedTools` AND in `deniedTools`, so
  // learning `Bash`'s schema still ends in a refusal at the call. It carries no path, so it
  // belongs in exactly this set.
  { name: "ToolSearch", op: "other", access: "pathless-allowed" },
];

function namesWhere(access: ClaudeTool["access"]): string[] {
  return CLAUDE_TOOLS.filter((tool) => tool.access === access).map((tool) => tool.name);
}

/**
 * Field names, in order, that carry a tool's primary PATH argument. This is the
 * list confinement resolves a target from.
 */
export const PATH_FIELDS = ["file_path", "path", "notebook_path", "notebookPath"] as const;

/**
 * Field names the UI renders as a tool's target. A superset of {@link PATH_FIELDS}
 * that additionally covers non-path targets.
 *
 * MUST NOT be fed to confinement: `command`, `pattern` and `url` are not paths,
 * and treating a Bash command string as a path would hand the containment test
 * a value it was never meant to resolve.
 */
export const TARGET_FIELDS = [...PATH_FIELDS, "command", "pattern", "url"] as const;

const OPTIONAL_PATH_TOOLS = new Set(namesWhere("path-optional"));

/** Claude Code's tool vocabulary wired into the shared deny-by-default rule. */
export const CLAUDE_CONFINEMENT_TABLES: ConfinementTables = {
  fileTools: new Set([...namesWhere("path-confined"), ...namesWhere("path-optional")]),
  deniedTools: new Set(namesWhere("denied")),
  optionalPathTools: OPTIONAL_PATH_TOOLS,
  pathlessAllowedTools: new Set(namesWhere("pathless-allowed")),
  pathFields: PATH_FIELDS,
};

/** The SDK `Options.disallowedTools` list — the same set confinement denies. */
export const CLAUDE_DISALLOWED_TOOLS: readonly string[] = namesWhere("denied");

const OP_BY_TOOL = new Map(CLAUDE_TOOLS.map((tool) => [tool.name, tool.op]));

/** The UI op for one tool name; unknown names render as `other`. */
export function toolOp(name: string): AgentToolOp {
  return OP_BY_TOOL.get(name) ?? "other";
}
