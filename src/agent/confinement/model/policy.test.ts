import { expect, test } from "bun:test";
import path from "node:path";

import {
  CHECK_DESIGN_TOOL_NAME,
  CLAUDE_CONFINEMENT_TABLES,
  CLAUDE_DISALLOWED_TOOLS,
} from "agent/claude/tools";

import { createConfinementPolicy } from "./policy";

const staging = path.resolve("C:\\state\\turns\\019a\\workspace");
const policy = createConfinementPolicy(staging, CLAUDE_CONFINEMENT_TABLES);

test("allows a Write inside staging (Spike H case 1)", () => {
  const r = policy("Write", { file_path: path.join(staging, "pages", "main.tsx"), content: "x" });
  expect(r.behavior).toBe("allow");
});

test("denies a Write to an absolute path outside staging (Spike H case 2)", () => {
  const r = policy("Write", { file_path: "C:\\Users\\Khmil\\ok.txt", content: "x" });
  expect(r.behavior).toBe("deny");
});

test("denies a ../ relative escape (Spike H case 3)", () => {
  const r = policy("Write", { file_path: path.join(staging, "..", "escape.txt"), content: "x" });
  expect(r.behavior).toBe("deny");
});

test("denies Bash outright (Spike H case 4)", () => {
  const r = policy("Bash", { command: "echo BASHPROBE > bash-probe.txt" });
  expect(r.behavior).toBe("deny");
});

test("denies WebFetch outright (Spike H case 5)", () => {
  const r = policy("WebFetch", { url: "https://example.com" });
  expect(r.behavior).toBe("deny");
});

test("denies an unknown tool by default", () => {
  const r = policy("SomeFutureTool", { anything: true });
  expect(r.behavior).toBe("deny");
});

test("the new self-check tool is allowed and every other unknown tool is still denied", () => {
  expect(policy(CHECK_DESIGN_TOOL_NAME, {}).behavior).toBe("allow");
  expect(policy("SomeNewTool", {}).behavior).toBe("deny");
  // Deny-by-default must NOT become deny-by-default-except-MCP.
  expect(policy("mcp__evil__exfiltrate", {}).behavior).toBe("deny");
  expect(policy("mcp__termcraft__anything_else", {}).behavior).toBe("deny");
});

test("Bash is still denied", () => {
  expect(CLAUDE_DISALLOWED_TOOLS).toContain("Bash");
  expect(CLAUDE_CONFINEMENT_TABLES.deniedTools.has("Bash")).toBe(true);
  expect(policy("Bash", { command: "echo hi" }).behavior).toBe("deny");
});

test("allows a Grep with an explicit path only when that path stays inside staging", () => {
  const inside = policy("Grep", { pattern: "gauge", path: path.join(staging, "pages") });
  expect(inside.behavior).toBe("allow");
  const outside = policy("Grep", { pattern: "gauge", path: "C:\\Windows" });
  expect(outside.behavior).toBe("deny");
});

test("[13] denies a file-tool call that carries no resolvable path field at all", () => {
  const r = policy("Read", {});
  expect(r.behavior).toBe("deny");
});

test("[13] a path-less Write still denies — path is required by its schema", () => {
  const r = policy("Write", { content: "x" });
  expect(r.behavior).toBe("deny");
});

test("[13] a path-less Edit/MultiEdit/NotebookEdit still deny — path is required by their schema", () => {
  expect(policy("Edit", { old_string: "a", new_string: "b" }).behavior).toBe("deny");
  expect(policy("MultiEdit", { edits: [] }).behavior).toBe("deny");
  expect(policy("NotebookEdit", { new_source: "x" }).behavior).toBe("deny");
});

test("[13]/[33] a path-less Grep resolves to the staging root and is allowed — its schema documents path as optional, defaulting to cwd, and cwd IS staging (buildQueryOptions)", () => {
  const r = policy("Grep", { pattern: "gauge" });
  expect(r.behavior).toBe("allow");
});

test("[13]/[33] a path-less Glob resolves to the staging root and is allowed", () => {
  const r = policy("Glob", { pattern: "**/*.tsx" });
  expect(r.behavior).toBe("allow");
});

test("[13]/[33] a path-less LS resolves to the staging root and is allowed", () => {
  const r = policy("LS", {});
  expect(r.behavior).toBe("allow");
});

test("[13]/[33] a path-less Grep still denies when the staging root itself sits on a reparse point", () => {
  const guardedPolicy = createConfinementPolicy(staging, CLAUDE_CONFINEMENT_TABLES, {
    hasReparsePoint: (p) => p === staging,
  });
  const r = guardedPolicy("Grep", { pattern: "gauge" });
  expect(r.behavior).toBe("deny");
});

test("[7] blockedPath wins over an innocuous input.file_path — the SDK's own resolved-target signal", () => {
  const r = policy(
    "Write",
    { file_path: path.join(staging, "pages", "main.tsx"), content: "x" },
    "C:\\Users\\Khmil\\outside.txt",
  );
  expect(r.behavior).toBe("deny");
});

// ---------------------------------------------------------------------------
// Vendor-neutral coverage of the RULE itself.
//
// The tests above compose the rule with Claude Code's real tables, which is
// the production path and worth covering — but they cannot tell a genuinely
// parameterized rule apart from one that still hardcodes Claude's vocabulary.
// These use synthetic tables sharing no tool name with any real backend, so
// they fail if a vendor name ever leaks back into confinement.ts. This is the
// property the shared/vendor split exists to guarantee: a future Codex backend
// supplies its own tables and inherits this rule unchanged.
// ---------------------------------------------------------------------------

const SYNTHETIC_TABLES = {
  fileTools: new Set(["Peek", "Poke", "Sweep"]),
  deniedTools: new Set(["Detonate", "Overlap"]),
  optionalPathTools: new Set(["Sweep"]),
  pathlessAllowedTools: new Set(["Ponder", "Overlap"]),
  pathFields: ["where", "target_path"] as const,
};

const synthetic = createConfinementPolicy(staging, SYNTHETIC_TABLES);

test("the rule allows an in-staging file tool named by synthetic tables alone", () => {
  expect(synthetic("Poke", { where: path.join(staging, "a.txt") }).behavior).toBe("allow");
});

test("the rule denies a synthetic file tool whose path escapes staging", () => {
  expect(synthetic("Poke", { where: "C:\\Users\\Khmil\\ok.txt" }).behavior).toBe("deny");
});

test("the rule reads path fields from the supplied tables, not from Claude's field names", () => {
  // `target_path` is in the synthetic tables; `file_path` is Claude's and must
  // mean nothing here, so a call carrying only `file_path` has no resolvable
  // path and is denied.
  expect(synthetic("Peek", { target_path: path.join(staging, "b.txt") }).behavior).toBe("allow");
  expect(synthetic("Peek", { file_path: path.join(staging, "b.txt") }).behavior).toBe("deny");
});

test("the rule denies a synthetic tool outright when its tables say so", () => {
  expect(synthetic("Detonate", { where: path.join(staging, "a.txt") }).behavior).toBe("deny");
});

test("the rule's optional-path default follows the supplied tables", () => {
  // `Sweep` is optional-path in these tables, so a path-less call resolves to
  // staging and is allowed; `Peek` is not, so a path-less call denies.
  expect(synthetic("Sweep", {}).behavior).toBe("allow");
  expect(synthetic("Peek", {}).behavior).toBe("deny");
});

test("the rule denies Claude's own tool names when they are absent from the supplied tables", () => {
  // The sharpest check that no vendor vocabulary survives inside the rule: a
  // real Claude tool name must be just an unknown string to a policy built
  // from tables that do not mention it.
  expect(synthetic("Write", { where: path.join(staging, "a.txt") }).behavior).toBe("deny");
  expect(synthetic("Bash", { command: "echo hi" }).behavior).toBe("deny");
});

// ---------------------------------------------------------------------------
// The THIRD table set (C9): tools that are allowed and carry no path at all.
// ---------------------------------------------------------------------------

test("a pathless-allowed synthetic tool is allowed with an empty input", () => {
  expect(synthetic("Ponder", {}).behavior).toBe("allow");
});

test("a pathless-allowed tool stays allowed however its input is decorated", () => {
  // There is no path to resolve, so nothing in the input can change the answer — including a
  // field that LOOKS like a path. If a caller could aim it by smuggling `where`, the set would
  // be a hole rather than a third category.
  expect(synthetic("Ponder", { where: "C:\\Windows\\System32" }).behavior).toBe("allow");
});

test("denied beats pathless-allowed — the order is denied, then pathless, then file tools", () => {
  // `Overlap` is in BOTH sets. Deny must win, or a future table edit could quietly un-deny a
  // tool by adding it to the newer set.
  expect(synthetic("Overlap", {}).behavior).toBe("deny");
});

test("the pathless set widens the allowlist by exactly its own membership and nothing more", () => {
  // Deny-by-default must NOT become deny-by-default-except-MCP: an unknown name that merely
  // LOOKS like an MCP tool is still refused.
  expect(synthetic("Ruminate", {}).behavior).toBe("deny");
  expect(synthetic("mcp__evil__exfiltrate", {}).behavior).toBe("deny");
  expect(synthetic("mcp__termcraft__not_a_real_tool", {}).behavior).toBe("deny");
});
