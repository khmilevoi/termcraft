import { expect, test } from "bun:test";

import { DESIGN_CHECK_CLEAN_HEADLINE } from "agent/checks";
import type { DesignCheckReportV1, DesignCheckerPort } from "agent/checks";

import {
  CHECK_DESIGN_DESCRIPTION,
  CHECK_DESIGN_INPUT_SCHEMA,
  CHECK_DESIGN_TOOL_NAME,
  CHECK_DESIGN_TOOL_SHORT_NAME,
  TERMCRAFT_MCP_SERVER_NAME,
  createCheckDesignTool,
  createTermcraftMcpServer,
  createTermcraftMcpTools,
} from "./check-design-tool";

function checkerReturning(report: DesignCheckReportV1): DesignCheckerPort {
  return { check: () => Promise.resolve(report) };
}

/** The SDK's `tool()` handler signature takes `(args, extra)`; nothing here reads `extra`. */
const NO_EXTRA = undefined;

test("the tool's registered name is exactly the name confinement has to match (spike 11, Q3)", () => {
  expect(CHECK_DESIGN_TOOL_NAME).toBe("mcp__termcraft__check_design");
  expect(CHECK_DESIGN_TOOL_NAME).toBe(
    `mcp__${TERMCRAFT_MCP_SERVER_NAME}__${CHECK_DESIGN_TOOL_SHORT_NAME}`,
  );
});

test("the tool cannot be pointed outside the turn workspace — its schema has NO path field", () => {
  // C9: confinement cannot resolve a path from an argument that does not exist. This tool's
  // containment is inherent rather than checked, so the ABSENCE of every path-ish field is the
  // property to pin — not a policy assertion.
  expect(Object.keys(CHECK_DESIGN_INPUT_SCHEMA)).toEqual([]);
  const tool = createCheckDesignTool(checkerReturning({ errors: [], warnings: [] }), "C:\\ws");
  expect(Object.keys(tool.inputSchema as Record<string, unknown>)).toEqual([]);
});

test("the handler returns the rendered check as its text content", async () => {
  const tool = createCheckDesignTool(
    checkerReturning({
      errors: [{ kind: "type", code: "TS7006", message: "implicit any", file: "pages/home.tsx" }],
      warnings: [],
    }),
    "C:\\ws",
  );
  const result = await tool.handler({}, NO_EXTRA);
  const [block] = result.content;
  expect(block?.type).toBe("text");
  expect((block as { text: string }).text).toContain("- [type/TS7006] in design/pages/home.tsx:");
});

test("the handler asks the checker for the workspace it was built with, on EVERY call", async () => {
  const seen: string[] = [];
  const checker: DesignCheckerPort = {
    check(input) {
      seen.push(input.workspacePath);
      return Promise.resolve({ errors: [], warnings: [] });
    },
  };
  const tool = createCheckDesignTool(checker, "C:\\state\\turns\\019a\\workspace");
  const first = await tool.handler({}, NO_EXTRA);
  const second = await tool.handler({}, NO_EXTRA);
  expect(seen).toEqual(["C:\\state\\turns\\019a\\workspace", "C:\\state\\turns\\019a\\workspace"]);
  expect((first.content[0] as { text: string }).text).toContain(DESIGN_CHECK_CLEAN_HEADLINE);
  expect((second.content[0] as { text: string }).text).toContain(DESIGN_CHECK_CLEAN_HEADLINE);
});

test("the server carries exactly the one tool, under the termcraft name", () => {
  const checker = checkerReturning({ errors: [], warnings: [] });
  const tools = createTermcraftMcpTools(checker, "C:\\ws");
  expect(tools).toHaveLength(1);
  const server = createTermcraftMcpServer(tools);
  expect((server as { type?: string }).type).toBe("sdk");
  expect((server as { name?: string }).name).toBe(TERMCRAFT_MCP_SERVER_NAME);
});

test("the description states the MEASURED cost and that the pause is termcraft's, not just the agent's", () => {
  // An earlier draft said "costs a few seconds" — an order of magnitude out, and framed purely as
  // the agent's own time. Both halves are corrected, and pinned so a future edit cannot quietly
  // reintroduce either.
  expect(CHECK_DESIGN_DESCRIPTION).not.toContain("a few seconds");
  expect(CHECK_DESIGN_DESCRIPTION).toContain("0.1-0.2 s");
  expect(CHECK_DESIGN_DESCRIPTION).toContain("pauses termcraft's whole interface");
});
