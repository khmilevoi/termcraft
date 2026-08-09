import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

import { runDesignCheck } from "agent/checks";
import type { DesignCheckerPort } from "agent/checks";

/**
 * `check_design` — the agent's ONE in-process tool, and the only feedback channel on whether
 * its edits would survive the Gate that does not cost a whole rejected turn.
 *
 * WHY IT EXISTS (spec WP-10). `Bash`, `BashOutput`, `KillShell`, `WebFetch` and `WebSearch` are
 * denied (`./vocabulary.ts`) and nothing replaced them, so before this tool a single mechanical,
 * locally-fixable diagnostic cost a full turn re-run: ~2.5 minutes and a complete re-read of
 * every doc and page. This lets the agent edit, check, and edit again inside ONE attempt.
 *
 * PATHLESS ON PURPOSE, AND THE SCHEMA IS EMPTY (correction C9). It checks the whole design tree
 * of the turn workspace, which is the only thing it could honestly check — a per-page variant
 * would report a page's own type errors while missing the shared module that actually broke it.
 * Having no path argument is also what makes it unpointable outside the workspace WITHOUT any
 * confinement logic of its own: `createConfinementPolicy` resolves a target from `PATH_FIELDS`
 * and denies when none resolves, and there is nothing here for it to resolve. The workspace
 * root is CAPTURED from the `AgentTask` when this tool is built, never taken as an argument.
 *
 * SPIKE 11 SETTLED THE MECHANISM (`docs/spikes/11-sdk-mcp-tool/SPIKE.md`, both tiers run
 * 2026-08-09): `tool()` accepts this repository's `zod@4` raw shape (empty `{}` included),
 * `Options.mcpServers` survives `buildQueryOptions`'s own literal with `settingSources: []`
 * intact, the name `canUseTool` is asked about is exactly {@link CHECK_DESIGN_TOOL_NAME}, and
 * the in-process server IS reachable through termcraft's custom `createSpawnAndAdopt` CLI
 * spawn — a full round trip, handler run, output back in the model's reply.
 *
 * THE HANDLER VALIDATES NOTHING BECAUSE THERE IS NOTHING TO VALIDATE, and that is worth
 * stating: spike 11's S3 measured the SDK NOT enforcing a declared schema at the handler
 * boundary (`handler({slug: 42})` resolved). With an empty schema the point is moot — one more
 * argument for staying pathless. If a scoped variant is ever added, its handler validates its
 * own input with the repo's `zod` first, exactly as `entities/*`'s decoders do.
 */

/** The in-process MCP server's name. Half of the `mcp__<server>__<tool>` name confinement matches. */
export const TERMCRAFT_MCP_SERVER_NAME = "termcraft";

/** The tool's own name, as registered with the server. */
export const CHECK_DESIGN_TOOL_SHORT_NAME = "check_design";

/**
 * THE NAME `canUseTool` IS ACTUALLY ASKED ABOUT — measured, not predicted (spike 11 Q3). This
 * exact string has to be in the confinement table: `agent/confinement/model/policy.ts` is
 * deny-by-default on an exact match, and getting it wrong produces a tool the agent sees
 * advertised and is refused on every call, which is strictly worse than no tool at all.
 */
export const CHECK_DESIGN_TOOL_NAME = `mcp__${TERMCRAFT_MCP_SERVER_NAME}__${CHECK_DESIGN_TOOL_SHORT_NAME}`;

/**
 * The tool's input schema: EMPTY, and that is the design (see this file's header, C9). Exported
 * so a test can assert the absence of every path-ish field directly — the containment property
 * here is structural, so the assertion has to be structural too.
 */
export const CHECK_DESIGN_INPUT_SCHEMA = {} as const;

/**
 * What the model reads when it decides whether to call this. Says what it checks, what it does
 * NOT check, and that it is cheap — a tool the model does not understand the cost of is a tool
 * it will either avoid or spam. The system prompt (`agent/prompt/model/prose.ts`'s `SELF_CHECK`)
 * carries the "call it before you finish" instruction; this is the reference card.
 */
export const CHECK_DESIGN_DESCRIPTION =
  "Check the whole design tree in this workspace the way the Gate will, and report what it " +
  "finds. Takes no arguments — it always checks the current, on-disk state of design/, so " +
  "call it again after every edit. Covers the pages.json manifest, the import allowlist, the " +
  "import graph, every page's closure, non-determinism, and one TypeScript program over the " +
  "whole tree. Does not run the page contract or the smoke render. Costs a few seconds; a turn " +
  "the Gate rejects costs minutes and a full re-read.";

/** One `check_design` bound to `workspacePath`, reading that workspace LIVE on every call. */
export function createCheckDesignTool(checker: DesignCheckerPort, workspacePath: string) {
  return tool(
    CHECK_DESIGN_TOOL_SHORT_NAME,
    CHECK_DESIGN_DESCRIPTION,
    CHECK_DESIGN_INPUT_SCHEMA,
    async () => ({
      content: [{ type: "text" as const, text: await runDesignCheck(checker, workspacePath) }],
    }),
  );
}

/**
 * Every tool the in-process server carries, as an array, so `buildQueryOptions` can trace the
 * COUNT it actually registered rather than a hand-maintained literal that could drift from it.
 */
export function createTermcraftMcpTools(checker: DesignCheckerPort, workspacePath: string) {
  return [createCheckDesignTool(checker, workspacePath)];
}

/** The in-process SDK MCP server one attempt registers under `Options.mcpServers`. */
export function createTermcraftMcpServer(
  checker: DesignCheckerPort,
  workspacePath: string,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: TERMCRAFT_MCP_SERVER_NAME,
    tools: createTermcraftMcpTools(checker, workspacePath),
  });
}
