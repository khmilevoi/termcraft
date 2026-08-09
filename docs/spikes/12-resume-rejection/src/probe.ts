// Spike 12 — how is a rejected resume discriminable from any other backend error?
//
//   bun run docs/spikes/12-resume-rejection/src/probe.ts
//
// Observation A costs nothing. B, C and D are three minimal live turns (effort "low"), so this
// probe SPENDS A SMALL AMOUNT OF TOKENS and needs a logged-in Claude CLI.
//
// WHY EVERY FIELD IS DUMPED RATHER THAN SUMMARISED: the question is "which discriminator is
// stable", and the answer is whichever of these fields turns out to be. A summarised capture
// would throw away the answer before anyone read it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

/** A session id that cannot exist. Shaped like a real one so the rejection is about lookup. */
const FABRICATED_SESSION_ID = "00000000-0000-4000-8000-000000000000";

function tempCwd(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spike12-${label}-`));
  fs.writeFileSync(path.join(dir, "NOTES.md"), "throwaway workspace for spike 12\n");
  return dir;
}

function baseOptions(cwd: string): Options {
  return {
    cwd,
    additionalDirectories: [],
    settingSources: [],
    permissionMode: "default",
    model: "claude-sonnet-5",
    effort: "low",
    systemPrompt: "Reply with the single word OK and nothing else.",
    abortController: new AbortController(),
    includePartialMessages: false,
    disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"],
  };
}

/** Everything knowable about a thrown value, including its whole cause chain. */
function describeThrown(value: unknown): string {
  const lines: string[] = [];
  let current: unknown = value;
  let depth = 0;
  while (current !== null && current !== undefined && depth < 6) {
    const ctor = (current as { constructor?: { name?: string } }).constructor?.name ?? typeof current;
    lines.push(`    [${String(depth)}] class=${String(ctor)}`);
    if (current instanceof Error) {
      lines.push(`        name    = ${current.name}`);
      lines.push(`        message = ${current.message}`);
    } else {
      lines.push(`        value   = ${String(current)}`);
    }
    // Own enumerable properties are where a vendor usually hides a `code`/`status`/`subtype`.
    for (const [k, v] of Object.entries(current as Record<string, unknown>)) {
      if (k === "stack" || k === "cause") continue;
      lines.push(`        .${k} = ${JSON.stringify(v)?.slice(0, 300) ?? String(v)}`);
    }
    current = (current as { cause?: unknown }).cause;
    depth += 1;
  }
  return lines.join("\n");
}

interface RunResult {
  readonly sessionId: string | null;
  readonly thrown: string | null;
  readonly resultMessages: readonly string[];
  readonly texts: readonly string[];
}

async function run(label: string, options: Options, prompt: string): Promise<RunResult> {
  console.log(`\n--- ${label} ---`);
  console.log(`    cwd    = ${String(options.cwd)}`);
  console.log(`    resume = ${String((options as { resume?: string }).resume ?? "(none)")}`);

  const resultMessages: string[] = [];
  const texts: string[] = [];
  let sessionId: string | null = null;
  let thrown: string | null = null;

  try {
    for await (const message of query({ prompt, options })) {
      const m = message as Record<string, unknown>;
      const kind = String(m.type ?? "?");
      if (typeof m.session_id === "string" && sessionId === null) sessionId = m.session_id;
      if (kind === "result") {
        // EVERY field, untruncated per key: `subtype`, `is_error`, `permission_denials` and any
        // vendor addition are all candidate discriminators for Q2.
        resultMessages.push(JSON.stringify(m));
        console.log(`    result message:`);
        for (const [k, v] of Object.entries(m)) {
          console.log(`        .${k} = ${JSON.stringify(v)?.slice(0, 400) ?? String(v)}`);
        }
      }
      if (kind === "assistant") {
        for (const block of (m.message as { content?: unknown[] } | undefined)?.content ?? []) {
          const b = block as { type?: string; text?: string };
          if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
        }
      }
    }
  } catch (cause) {
    thrown = describeThrown(cause);
    console.log(`    THREW:\n${thrown}`);
  }

  console.log(`    session_id observed = ${String(sessionId)}`);
  console.log(`    assistant text      = ${JSON.stringify(texts)}`);
  return { sessionId, thrown, resultMessages, texts };
}

async function main(): Promise<number> {
  const cwdA = tempCwd("a");
  const cwdB = tempCwd("b");
  const cwdD = tempCwd("d");

  console.log("=== A: resume a FABRICATED session id from a fresh cwd (free — should not bill) ===");
  const a = await run("A", { ...baseOptions(cwdA), resume: FABRICATED_SESSION_ID, forkSession: false }, "hi");

  console.log("\n=== B: a real one-turn session, to obtain a genuine session id (LIVE TURN) ===");
  const b = await run("B", baseOptions(cwdB), "Reply OK.");
  if (b.sessionId === null) {
    console.error("\nB produced no session id — cannot run C or D. Is the CLI logged in?");
    return 1;
  }

  console.log("\n=== C: resume B's id from the SAME cwd — Q4, and Task 8's premise (LIVE TURN) ===");
  const c = await run("C", { ...baseOptions(cwdB), resume: b.sessionId, forkSession: false }, "Reply OK again.");

  console.log("\n=== D: resume B's id from a DIFFERENT cwd — Q3, the RC6 diagnosis (LIVE TURN) ===");
  const d = await run("D", { ...baseOptions(cwdD), resume: b.sessionId, forkSession: false }, "Reply OK again.");

  const rejected = (r: RunResult): boolean =>
    r.thrown !== null || r.resultMessages.some((m) => m.includes('"is_error":true'));

  console.log("\n=== SUMMARY ===");
  console.log(`  A (fabricated id, fresh cwd)   rejected = ${String(rejected(a))}`);
  console.log(`  C (real id, SAME cwd)          rejected = ${String(rejected(c))}   <- Q4 / Task 8`);
  console.log(`  D (real id, DIFFERENT cwd)     rejected = ${String(rejected(d))}   <- Q3 / RC6`);
  console.log(`  SDK version: ${String(
    JSON.parse(fs.readFileSync(
      Bun.resolveSync("@anthropic-ai/claude-agent-sdk/package.json", process.cwd()), "utf8",
    ) as string).version,
  )}`);

  console.log("\n  READ THESE THREE LINES CAREFULLY BEFORE IMPLEMENTING:");
  if (rejected(c))
    console.log("  * C REJECTED -> TASK 8 IS DEAD. An intra-turn resume does not work. Stop.");
  else console.log("  * C succeeded -> Task 8's premise holds: an intra-turn resume is sound.");
  if (rejected(d))
    console.log("  * D REJECTED -> RC6 confirmed: the SDK indexes by cwd. Task 9 part 1 is justified.");
  else
    console.log("  * D SUCCEEDED -> RC6 IS WRONG. Do not flip sessionWorkspaceBinding. Re-diagnose.");
  console.log("  * Q2: scan A's and D's dumps above for any stable field other than the message.");

  for (const dir of [cwdA, cwdB, cwdD]) fs.rmSync(dir, { recursive: true, force: true });
  console.log("\nCopy this output verbatim into SPIKE.md's Findings table.");
  return 0;
}

process.exit(await main());
