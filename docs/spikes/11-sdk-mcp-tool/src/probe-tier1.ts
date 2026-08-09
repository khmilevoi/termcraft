// Spike 11, tier 1 — free, no network, no turn. Answers Q1 (does the SDK's `tool()` accept a
// zod@4 raw shape?) and Q2 (does `Options.mcpServers` survive OUR `Options` construction?).
//
// Run from the REPOSITORY ROOT:
//   bun run docs/spikes/11-sdk-mcp-tool/src/probe-tier1.ts
//   bun x tsc --noEmit          # half of Q1/Q2 is a TYPE question; this file is part of the program
//
// STOP HERE IF THIS FAILS. Tier 2 spends a paid turn.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { buildQueryOptions } from "agent/claude/query";
import { createFakeProcessTree } from "infrastructure/process";

const SERVER_NAME = "termcraft";
const TOOL_NAME = "check_design";

/**
 * The tool as Task 12 would declare it. NOTE THE SCHEMA IS EMPTY, and that is the design, not a
 * simplification for the probe: `check_design` takes no path (see the plan's correction C9). It
 * checks the whole design tree of the turn workspace the adapter already holds, which is the only
 * thing it could honestly check, and having no path argument is what makes it unpointable outside
 * the workspace without any confinement logic of its own.
 *
 * An empty raw shape is also the sharpest form of Q1: if `AnyZodRawShape` cannot even accept `{}`
 * from this repository's zod, the majors are incompatible and no amount of schema design helps.
 */
const emptyShape = {} as const;

/** A second tool with a NON-empty schema, so Q1 is answered for a real field too. */
const scopedShape = {
  slug: z.string().min(1).describe("Check only this page, by slug. Omit to check the whole tree."),
} as const;

async function main(): Promise<number> {
  let failures = 0;
  const fail = (what: string, detail: string): void => {
    failures += 1;
    console.error(`FAIL  ${what}\n      ${detail}`);
  };

  // ── Q1: construct both tools and RUN their handlers, so the schema's runtime behaviour is
  // observed rather than inferred from the fact that construction did not throw.
  const pathless = tool(TOOL_NAME, "Check the design tree", emptyShape, async () => ({
    content: [{ type: "text" as const, text: "ok-pathless" }],
  }));
  const scoped = tool(`${TOOL_NAME}_scoped`, "Check one page", scopedShape, async (args) => ({
    // If zod@4's inference does not flow through `InferShape`, this property access is where the
    // typecheck breaks — which is why `bun x tsc --noEmit` is part of this probe, not optional.
    content: [{ type: "text" as const, text: `ok-scoped:${args.slug}` }],
  }));

  console.log("=== Q1: tool() construction ===");
  console.log(`  pathless: name=${String(pathless.name)}`);
  console.log(`  scoped:   name=${String(scoped.name)}`);

  const pathlessResult = await pathless.handler({}, undefined);
  const scopedResult = await scoped.handler({ slug: "home" }, undefined);
  console.log(`  pathless handler -> ${JSON.stringify(pathlessResult)}`);
  console.log(`  scoped handler   -> ${JSON.stringify(scopedResult)}`);
  if (!JSON.stringify(scopedResult).includes("ok-scoped:home"))
    fail("Q1 scoped handler", "the schema did not carry `slug` through to the handler");

  // Does the SDK actually validate against the schema, or is the shape decorative? If it does
  // not validate, Task 12's handler must validate its own input and say so.
  const rejected = await scoped
    .handler({ slug: 42 } as never, undefined)
    .then((r) => `resolved: ${JSON.stringify(r)}`)
    .catch((e: unknown) => `rejected: ${String(e)}`);
  console.log(`  scoped handler with a wrong-typed field -> ${rejected}`);
  console.log("  (if that RESOLVED, the SDK does not validate at the handler boundary —");
  console.log("   Task 12's handler must validate its own input, and the plan must say so)");

  // ── Q2: build a server and feed it through the REAL `buildQueryOptions`, not a hand-made
  // Options literal. The interaction with `settingSources: []`, `permissionMode: "default"` and
  // `disallowedTools` is the question; a standalone literal would not exercise it.
  console.log("\n=== Q2: Options.mcpServers through the real buildQueryOptions ===");
  const server = createSdkMcpServer({ name: SERVER_NAME, tools: [pathless] });
  console.log(`  createSdkMcpServer -> type=${String((server as { type?: string }).type)}`);

  const options = buildQueryOptions(
    {
      fence: { turnId: "spike", attempt: 1 } as never,
      workspacePath: process.cwd(),
      systemPrompt: "spike",
      userMessage: "spike",
      model: "claude-sonnet-5",
      effort: "low",
      session: { kind: "fresh", seed: [] },
    },
    { abortController: new AbortController(), processTree: createFakeProcessTree({ counts: [1] }) },
  );

  // Assign after the fact, exactly as Task 12 would inside `buildQueryOptions`. Doing it here
  // rather than editing that function keeps the probe read-only against production code.
  const withServers = { ...options, mcpServers: { [SERVER_NAME]: server } };

  console.log(`  settingSources      = ${JSON.stringify(options.settingSources)}`);
  console.log(`  permissionMode      = ${String(options.permissionMode)}`);
  console.log(`  disallowedTools     = ${JSON.stringify(options.disallowedTools)}`);
  console.log(`  mcpServers keys     = ${JSON.stringify(Object.keys(withServers.mcpServers))}`);
  console.log(`  canUseTool present  = ${String(typeof options.canUseTool === "function")}`);

  // The name Task 12's confinement table will have to contain, IF the convention holds. Tier 2
  // is what confirms it — this line is the PREDICTION, recorded so tier 2 can contradict it.
  console.log(`\n  predicted canUseTool name: mcp__${SERVER_NAME}__${TOOL_NAME}`);
  console.log("  (tier 2 confirms or refutes this; do not put it in a confinement table yet)");

  console.log(
    failures === 0
      ? "\ntier 1 PASSED — Q1 and Q2 answered. Record them in SPIKE.md, then decide on tier 2."
      : `\ntier 1 FAILED with ${String(failures)} failure(s) — do NOT run tier 2, do NOT implement.`,
  );
  return failures === 0 ? 0 : 1;
}

process.exit(await main());
