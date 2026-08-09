// Spike 11, tier 2 — ONE LIVE TURN. SPENDS TOKENS. Answers Q3 (what tool name reaches
// `canUseTool`?) and Q4 (does an in-process MCP server survive termcraft's custom spawn?).
//
//   bun run docs/spikes/11-sdk-mcp-tool/src/probe-tier2.ts
//
// PRECONDITIONS: tier 1 passed, and a logged-in Claude CLI is on PATH. Do not run in CI. Do not
// run as part of an automated plan execution without the operator saying so.
//
// Q4 IS THE REASON THIS TIER EXISTS. termcraft does not let the SDK spawn the CLI —
// `createSpawnAndAdopt` (`agent/claude/query/model/spawn-adopt.ts`) intercepts
// `spawnClaudeCodeProcess` so the child joins an owned Job Object, and it forwards `command`,
// `args`, `cwd`, `env` and `signal` while specifying NO `stdio` (Node's default
// ['pipe','pipe','pipe'] applies). If the SDK's in-process MCP transport needs anything beyond
// those three descriptors, the server is silently unreachable and the symptom is
// indistinguishable from "the model chose not to call the tool". That is what this probe
// discriminates: the handler either ran or it did not.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, Options } from "@anthropic-ai/claude-agent-sdk";

import { createSpawnAndAdopt } from "agent/claude/query/model/spawn-adopt";
import { createFakeProcessTree } from "infrastructure/process";

const SERVER_NAME = "termcraft";
const TOOL_NAME = "check_design";
/** A sentinel the model cannot produce on its own, so its presence proves the handler RAN. */
const SENTINEL = "SPIKE11-HANDLER-DID-RUN-7f3a91";

async function main(): Promise<number> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "spike11-"));
  fs.writeFileSync(path.join(workspace, "NOTES.md"), "a throwaway workspace for spike 11\n");

  let handlerCalls = 0;
  const checkDesign = tool(TOOL_NAME, "Check the design tree for problems.", {}, async () => {
    handlerCalls += 1;
    return { content: [{ type: "text" as const, text: `${SENTINEL} — 0 problems found` }] };
  });

  // EVERY name `canUseTool` is asked about, in order. Q3's answer is this list.
  const seen: string[] = [];
  const canUseTool: CanUseTool = async (toolName) => {
    seen.push(toolName);
    // ALLOW EVERYTHING. This probe is not testing the policy — it is discovering the NAME the
    // policy will have to match. Denying here would answer Q3 and then make Q4 unanswerable.
    return { behavior: "allow" };
  };

  const options: Options = {
    cwd: workspace,
    additionalDirectories: [],
    settingSources: [],
    permissionMode: "default",
    model: "claude-sonnet-5",
    effort: "low",
    systemPrompt:
      "You are a probe. Call the check_design tool exactly once, then reply with the tool's " +
      "output verbatim and nothing else. Do not read or write any file.",
    abortController: new AbortController(),
    includePartialMessages: false,
    canUseTool,
    mcpServers: { [SERVER_NAME]: createSdkMcpServer({ name: SERVER_NAME, tools: [checkDesign] }) },
    // THE INTERCEPTION UNDER TEST. Run the probe a second time with this line commented out: if
    // the tool works without it and fails with it, Q4 is answered NO and the cause is located
    // precisely, which is the difference between a finding and a guess.
    spawnClaudeCodeProcess: createSpawnAndAdopt(createFakeProcessTree({ counts: [1] }), "spike11"),
  };

  const texts: string[] = [];
  const toolUses: string[] = [];
  let streamError: string | null = null;

  try {
    for await (const message of query({ prompt: "Check the design.", options })) {
      const kind = (message as { type?: string }).type ?? "?";
      if (kind === "assistant") {
        for (const block of (message as { message?: { content?: unknown[] } }).message?.content ??
          []) {
          const b = block as { type?: string; text?: string; name?: string };
          if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
          if (b.type === "tool_use" && typeof b.name === "string") toolUses.push(b.name);
        }
      }
      if (kind === "result") console.log(`  result message: ${JSON.stringify(message).slice(0, 400)}`);
    }
  } catch (cause) {
    streamError = String(cause);
  }

  console.log("\n=== Q3: names canUseTool was asked about ===");
  console.log(seen.length === 0 ? "  (none)" : seen.map((n) => `  ${n}`).join("\n"));

  console.log("\n=== Q3b: tool_use block names the model emitted ===");
  console.log(toolUses.length === 0 ? "  (none)" : toolUses.map((n) => `  ${n}`).join("\n"));

  console.log("\n=== Q4: did the in-process handler actually run? ===");
  console.log(`  handler invocations: ${String(handlerCalls)}`);
  const sentinelReached = texts.some((t) => t.includes(SENTINEL));
  console.log(`  sentinel reached the model's reply: ${String(sentinelReached)}`);
  if (streamError !== null) console.log(`  stream error: ${streamError}`);

  const verdict = (() => {
    if (handlerCalls > 0 && sentinelReached) return "YES — server reachable, round trip complete";
    if (handlerCalls > 0) return "PARTIAL — handler ran but its output did not reach the model";
    if (toolUses.length > 0) return "NO — the model called it, the handler never ran (transport)";
    return "INCONCLUSIVE — the model never attempted the call; re-run before concluding anything";
  })();
  console.log(`\n  Q4 verdict: ${verdict}`);
  console.log("\n  If NO: re-run with `spawnClaudeCodeProcess` commented out before blaming the");
  console.log("  transport. If it works without the interception, the cause is located and the");
  console.log("  fix is a SPAWN change (forward the SDK's stdio), not a tool change.");

  fs.rmSync(workspace, { recursive: true, force: true });
  console.log("\nCopy this output verbatim into SPIKE.md's Findings table.");
  return handlerCalls > 0 && sentinelReached ? 0 : 1;
}

process.exit(await main());
