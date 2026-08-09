import { afterEach, expect, test } from "bun:test";
import path from "node:path";

import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

import type { DesignCheckerPort } from "agent/checks";
import { CHECK_DESIGN_TOOL_NAME } from "agent/claude/tools";
import type { AgentTask } from "agent/types";
import type { ProcessTree } from "infrastructure/process";
import { ProcessTreeError, createFakeProcessTree } from "infrastructure/process";

import { buildQueryOptions } from "./query-options";

/** A checker that reports a clean tree — enough for every option-shape assertion here. */
const cleanChecker: DesignCheckerPort = {
  check: () => Promise.resolve({ errors: [], warnings: [] }),
};

const staging = path.resolve("C:\\ws");
const task: AgentTask = {
  fence: { turnId: "t", attempt: 0, leaseNonce: "n" },
  workspacePath: staging,
  systemPrompt: "role + rules",
  userMessage: "make the gauge red",
  model: "claude-opus-4-8",
  effort: "high",
  session: { kind: "fresh", seed: [] },
};

test("[15] options bind cwd to staging, isolate settings, deny the full disallowed-tools list exactly, and lock permission/session behavior", () => {
  const opts = buildQueryOptions(task, {
    abortController: new AbortController(),
    processTree: createFakeProcessTree({ counts: [1] }),
    designChecker: cleanChecker,
  });
  expect(opts.cwd).toBe(staging);
  expect(opts.additionalDirectories).toEqual([]);
  expect(opts.settingSources).toEqual([]);
  // toEqual against the full list, not toContain: a partial list would let a
  // dropped entry (e.g. "KillShell") through undetected.
  expect(opts.disallowedTools).toEqual([
    "Bash",
    "BashOutput",
    "KillShell",
    "WebFetch",
    "WebSearch",
  ]);
  // permissionMode decides whether the SDK consults canUseTool at all — the
  // whole confinement veto is dead code if this drifts to "bypassPermissions".
  expect(opts.permissionMode).toBe("default");
  expect(opts.includePartialMessages).toBe(false);
  expect(opts.model).toBe("claude-opus-4-8");
  expect(opts.effort).toBe("high");
});

test("canUseTool denies an out-of-staging write and allows an in-staging edit", async () => {
  const opts = buildQueryOptions(task, {
    abortController: new AbortController(),
    processTree: createFakeProcessTree({ counts: [1] }),
    designChecker: cleanChecker,
  });
  const deny = await opts.canUseTool!(
    "Write",
    { file_path: "C:\\Users\\x\\ok.txt", content: "y" },
    { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" },
  );
  expect(deny?.behavior).toBe("deny");
  const allow = await opts.canUseTool!(
    "Write",
    { file_path: path.join(staging, "pages", "main.tsx"), content: "y" },
    { signal: new AbortController().signal, toolUseID: "t2", requestId: "r2" },
  );
  expect(allow?.behavior).toBe("allow");
});

test("a resume plan sets resume and forkSession:false", () => {
  const opts = buildQueryOptions(
    { ...task, session: { kind: "resume", sessionId: "s9", promptDelta: null } },
    {
      abortController: new AbortController(),
      processTree: createFakeProcessTree({ counts: [1] }),
      designChecker: cleanChecker,
    },
  );
  expect(opts.resume).toBe("s9");
  expect(opts.forkSession).toBe(false);
});

test("the in-process termcraft MCP server is registered alongside the isolated settings", () => {
  const opts = buildQueryOptions(task, {
    abortController: new AbortController(),
    processTree: createFakeProcessTree({ counts: [1] }),
    designChecker: cleanChecker,
  });
  // `settingSources: []` isolates the turn from the user's own settings, and MCP servers are
  // ordinarily a settings-level concept — spike 11 Q2/Q4 confirmed an `Options.mcpServers`
  // entry survives that isolation and reaches the model through our own CLI spawn.
  expect(Object.keys(opts.mcpServers ?? {})).toEqual(["termcraft"]);
  expect(opts.settingSources).toEqual([]);
  expect(opts.disallowedTools).toContain("Bash");
});

test("[S4] the whole path works with the REAL production canUseTool in force", async () => {
  // NOT a table-contents assertion. Spike 11 measured the model reaching the MCP tool via
  // `ToolSearch` FIRST, with `canUseTool` never consulted about `ToolSearch` itself — so the
  // tool worked. If a future SDK routes `ToolSearch` through the callback, deny-by-default
  // would refuse it and `check_design` would become UNREACHABLE: advertised and never
  // callable, which this task's own reasoning calls strictly worse than no tool. This drives
  // the real policy so that day fails here instead of in a user's turn.
  const opts = buildQueryOptions(task, {
    abortController: new AbortController(),
    processTree: createFakeProcessTree({ counts: [1] }),
    designChecker: cleanChecker,
  });
  const ask = (name: string): Promise<{ behavior: string }> =>
    opts.canUseTool!(
      name,
      {},
      {
        signal: new AbortController().signal,
        toolUseID: `u-${name}`,
        requestId: `r-${name}`,
      },
    ) as Promise<{ behavior: string }>;

  expect((await ask(CHECK_DESIGN_TOOL_NAME)).behavior).toBe("allow");
  // THE DECISION, MADE HERE RATHER THAN LEFT TO THE SDK'S BEHAVIOUR OF THE MONTH: `ToolSearch`
  // is ALLOWED. It fetches tool schemas and does no I/O of its own, it carries no path, and it
  // is the transport by which the model reaches `check_design` at all.
  expect((await ask("ToolSearch")).behavior).toBe("allow");
  // Everything else the deny-by-default rule already refused stays refused.
  expect((await ask("Bash")).behavior).toBe("deny");
  expect((await ask("mcp__evil__exfiltrate")).behavior).toBe("deny");
});

/**
 * A `ProcessTree` fake that records every `adopt(pid)` call, every
 * `activeProcesses()` call (so a test can prove the [11] post-adopt
 * membership re-read actually ran), and every `noteAdoptionOutcome` call
 * (so a test can prove [22]'s ownership signal was recorded, not just
 * logged).
 */
function createRecordingProcessTree(): {
  tree: ProcessTree;
  adoptedPids: number[];
  activeProcessesCalls: () => number;
  adoptionOutcomes: boolean[];
} {
  const adoptedPids: number[] = [];
  const adoptionOutcomes: boolean[] = [];
  let activeProcessesCalls = 0;
  return {
    tree: {
      adopt: (pid: number) => {
        adoptedPids.push(pid);
        return null;
      },
      activeProcesses: () => {
        activeProcessesCalls += 1;
        return 1;
      },
      terminate: () => null,
      close: () => {},
      noteAdoptionOutcome: (ok: boolean) => {
        adoptionOutcomes.push(ok);
      },
      ownershipConfirmed: () => adoptionOutcomes.includes(true),
    },
    adoptedPids,
    activeProcessesCalls: () => activeProcessesCalls,
    adoptionOutcomes,
  };
}

/**
 * A `ProcessTree` fake whose `adopt`/`activeProcesses` outcomes are
 * individually scriptable, for driving `createSpawnAndAdopt`'s four
 * degraded branches ([11]) one at a time. `noteAdoptionOutcome` calls and
 * `activeProcesses()` call count are both recorded for assertion.
 */
function createScriptedProcessTree(script: {
  adopt?: (pid: number) => ProcessTreeError | null;
  activeProcesses?: () => ProcessTreeError | number;
}): { tree: ProcessTree; adoptionOutcomes: boolean[]; activeProcessesCalls: () => number } {
  const adoptionOutcomes: boolean[] = [];
  let activeProcessesCalls = 0;
  return {
    tree: {
      adopt: script.adopt ?? (() => null),
      activeProcesses: () => {
        activeProcessesCalls += 1;
        return script.activeProcesses ? script.activeProcesses() : 1;
      },
      terminate: () => null,
      close: () => {},
      noteAdoptionOutcome: (ok: boolean) => {
        adoptionOutcomes.push(ok);
      },
      ownershipConfirmed: () => adoptionOutcomes.includes(true),
    },
    adoptionOutcomes,
    activeProcessesCalls: () => activeProcessesCalls,
  };
}

const spawnedChildren: SpawnedProcess[] = [];
afterEach(() => {
  for (const child of spawnedChildren.splice(0)) child.kill("SIGTERM");
});

test("spawnClaudeCodeProcess actually spawns the CLI and adopts its real pid into the process tree", async () => {
  const { tree, adoptedPids, activeProcessesCalls, adoptionOutcomes } =
    createRecordingProcessTree();
  const opts = buildQueryOptions(task, {
    abortController: new AbortController(),
    processTree: tree,
    designChecker: cleanChecker,
  });
  expect(opts.spawnClaudeCodeProcess).toBeDefined();

  const child = opts.spawnClaudeCodeProcess!({
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    env: process.env as Record<string, string | undefined>,
    signal: new AbortController().signal,
  });
  spawnedChildren.push(child);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  expect(exitCode).toBe(0);
  expect(adoptedPids.length).toBe(1);
  expect(adoptedPids[0]).toBeGreaterThan(0);
  // [11]: the post-adopt membership re-read must actually run, not just the
  // `adopt()` call itself — deleting it would leave `activeProcessesCalls()`
  // at 0.
  expect(activeProcessesCalls()).toBeGreaterThanOrEqual(1);
  // [22]: a fully-verified adoption records ownership as confirmed on the
  // tree, not merely `console.warn`-logged.
  expect(adoptionOutcomes).toEqual([true]);
});

test("[11][22] spawnClaudeCodeProcess with a command that cannot spawn (no pid) returns the child unchanged and records adoption failure", async () => {
  const { tree, adoptionOutcomes } = createScriptedProcessTree({});
  const opts = buildQueryOptions(task, {
    abortController: new AbortController(),
    processTree: tree,
    designChecker: cleanChecker,
  });

  const child = opts.spawnClaudeCodeProcess!({
    command: "termcraft-definitely-not-a-real-executable-xyz",
    args: [],
    env: process.env as Record<string, string | undefined>,
    signal: new AbortController().signal,
  });
  // node:child_process emits 'error' asynchronously when the OS fails to
  // create the process — swallow it here so it does not crash the test
  // process as an unhandled 'error' event.
  child.on("error", () => {});
  spawnedChildren.push(child);

  await new Promise((resolve) => setTimeout(resolve, 20));

  // `pid` is a real `ChildProcess` field, not part of the `SpawnedProcess`
  // seam — cast narrowly just to prove this really is the no-pid branch.
  expect(typeof (child as unknown as { pid?: number }).pid).not.toBe("number");
  // The child is still returned unchanged, not dropped, so the SDK still
  // gets a `SpawnedProcess` (even a doomed one) rather than `undefined`.
  expect(child).toBeDefined();
  expect(adoptionOutcomes).toEqual([false]);
});

test("[11][22] spawnClaudeCodeProcess returns the child unchanged and records adoption failure when adopt() errors", async () => {
  const { tree, adoptionOutcomes } = createScriptedProcessTree({
    adopt: () => new ProcessTreeError({ reason: "AssignProcessToJobObject boom" }),
  });
  const opts = buildQueryOptions(task, {
    abortController: new AbortController(),
    processTree: tree,
    designChecker: cleanChecker,
  });

  const child = opts.spawnClaudeCodeProcess!({
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    env: process.env as Record<string, string | undefined>,
    signal: new AbortController().signal,
  });
  spawnedChildren.push(child);

  const exitCode = await new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );

  expect(exitCode).toBe(0); // still the real, running child — not dropped on adopt() failure
  expect(adoptionOutcomes).toEqual([false]);
});

test("[11][22] spawnClaudeCodeProcess records adoption failure when the post-adopt verify re-read errors", async () => {
  const { tree, adoptionOutcomes, activeProcessesCalls } = createScriptedProcessTree({
    activeProcesses: () => new ProcessTreeError({ reason: "QueryInformationJobObject boom" }),
  });
  const opts = buildQueryOptions(task, {
    abortController: new AbortController(),
    processTree: tree,
    designChecker: cleanChecker,
  });

  const child = opts.spawnClaudeCodeProcess!({
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    env: process.env as Record<string, string | undefined>,
    signal: new AbortController().signal,
  });
  spawnedChildren.push(child);

  const exitCode = await new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );

  expect(exitCode).toBe(0);
  expect(activeProcessesCalls()).toBeGreaterThanOrEqual(1); // the re-read actually ran
  expect(adoptionOutcomes).toEqual([false]);
});

test("[11][22] spawnClaudeCodeProcess records adoption failure when the post-adopt verify re-read reports 0", async () => {
  const { tree, adoptionOutcomes, activeProcessesCalls } = createScriptedProcessTree({
    activeProcesses: () => 0,
  });
  const opts = buildQueryOptions(task, {
    abortController: new AbortController(),
    processTree: tree,
    designChecker: cleanChecker,
  });

  const child = opts.spawnClaudeCodeProcess!({
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    env: process.env as Record<string, string | undefined>,
    signal: new AbortController().signal,
  });
  spawnedChildren.push(child);

  const exitCode = await new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );

  expect(exitCode).toBe(0);
  expect(activeProcessesCalls()).toBeGreaterThanOrEqual(1);
  expect(adoptionOutcomes).toEqual([false]);
});
