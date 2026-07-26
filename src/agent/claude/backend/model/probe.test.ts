import { afterEach, expect, test } from "bun:test";
import path from "node:path";

import type { Options, SDKMessage, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeQuery, ClaudeQueryFn } from "agent/claude/types";
import type { ProcessTree } from "infrastructure/process";
import { createFakeProcessTree } from "infrastructure/process";

import { CLAUDE_BACKEND_ID } from "./backend-id";
import { probeClaudeHealth } from "./probe";

/** A `ProcessTree` fake for tests that don't care about adoption/close specifics. */
function fakeTree(): ProcessTree {
  return createFakeProcessTree({ counts: [0], ownershipConfirmed: true });
}

/** Wrap a `ProcessTree` so `close()` calls can be counted (mirrors backend.test.ts's `trackTree`). */
function trackClose(tree: ProcessTree): { tree: ProcessTree; closeCalls: () => number } {
  let close = 0;
  return {
    tree: {
      adopt: tree.adopt,
      activeProcesses: tree.activeProcesses,
      terminate: tree.terminate,
      close: () => {
        close += 1;
        tree.close();
      },
      noteAdoptionOutcome: tree.noteAdoptionOutcome,
      ownershipConfirmed: tree.ownershipConfirmed,
    },
    closeCalls: () => close,
  };
}

/**
 * A `ProcessTree` fake that records every `adopt(pid)` call and every
 * `noteAdoptionOutcome` call — mirrors `query-options.test.ts`'s
 * `createRecordingProcessTree`, used here to prove the probe CLI is actually
 * adopted, not merely offered a tree it never uses.
 */
function createRecordingProcessTree(): {
  tree: ProcessTree;
  adoptedPids: number[];
  adoptionOutcomes: boolean[];
} {
  const adoptedPids: number[] = [];
  const adoptionOutcomes: boolean[] = [];
  return {
    tree: {
      adopt: (pid: number) => {
        adoptedPids.push(pid);
        return null;
      },
      activeProcesses: () => 1,
      terminate: () => null,
      close: () => {},
      noteAdoptionOutcome: (ok: boolean) => {
        adoptionOutcomes.push(ok);
      },
      ownershipConfirmed: () => adoptionOutcomes.includes(true),
    },
    adoptedPids,
    adoptionOutcomes,
  };
}

function fake(messages: SDKMessage[], throwOnIterate?: Error): ClaudeQuery {
  return {
    async *[Symbol.asyncIterator]() {
      if (throwOnIterate) throw throwOnIterate;
      for (const m of messages) yield m;
    },
    interrupt: async () => {},
  };
}

/**
 * A `ClaudeQuery` whose `.return()` REJECTS — models the real SDK generator's
 * `IteratorClose` cleanup rejecting (e.g. because the controller was already
 * aborted). `fake()` above is a plain async-generator method, and a plain
 * generator's `.return()` can never reject, so it cannot exercise the
 * abort-races-IteratorClose hazard at all.
 */
function fakeRejectingClose(messages: SDKMessage[]): ClaudeQuery {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<SDKMessage>> {
          if (index < messages.length) return { value: messages[index++]!, done: false };
          return { value: undefined, done: true };
        },
        async return(): Promise<IteratorResult<SDKMessage>> {
          throw new DOMException("The operation was aborted.", "AbortError");
        },
      };
    },
    interrupt: async () => {},
  };
}

/** A `ClaudeQuery` that connects and then never yields anything — models a stalled CLI. */
function hangingFake(): ClaudeQuery {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<SDKMessage>>(() => {}),
      };
    },
    interrupt: async () => {},
  };
}

const init = {
  type: "system",
  subtype: "init",
  apiKeySource: "oauth",
  model: "claude-opus-4-8",
  session_id: "s",
  uuid: "u",
} as unknown as SDKMessage;

/** Inconclusive on its own — `classifyMessage` returns null for it, so a probe must keep reading past it. */
const nonClassifying = {
  type: "assistant",
  parent_tool_use_id: null,
  session_id: "s",
  uuid: "u",
} as unknown as SDKMessage;

test("an init message means installed + logged in (ready); account is null because apiKeySource is not a stable account discriminator", async () => {
  const controller = new AbortController();
  const info = await probeClaudeHealth(() => fake([init]), {
    abortController: controller,
    processTree: fakeTree(),
  });
  expect(info.health.status).toBe("ready");
  expect(info.backendId).toBe(CLAUDE_BACKEND_ID);
  // apiKeySource ('user'|'project'|'org'|'temporary'|'oauth') is WHERE the
  // credential came from, one of five values for every account alive — never
  // a stable per-account discriminator. The installed SDK's SDKSystemMessage
  // has no field that is one, so null (documented as safely disabling
  // cross-process resume) is the correct value, not apiKeySource.
  expect(info.account).toBeNull();
});

test("ready aborts the controller so no paid turn completes", async () => {
  const controller = new AbortController();
  await probeClaudeHealth(() => fake([init]), {
    abortController: controller,
    processTree: fakeTree(),
  });
  expect(controller.signal.aborted).toBe(true);
});

test("an auth_status signal means not-logged-in", async () => {
  const authErr = {
    type: "auth_status",
    isAuthenticating: false,
    error: "not logged in",
    session_id: "s",
    uuid: "u",
  } as unknown as SDKMessage;
  const controller = new AbortController();
  const info = await probeClaudeHealth(() => fake([authErr]), {
    abortController: controller,
    processTree: fakeTree(),
  });
  expect(info.health.status).toBe("not-logged-in");
  expect(info.account).toBeNull();
  expect(controller.signal.aborted).toBe(true);
});

test("an assistant authentication_failed error means not-logged-in", async () => {
  const authFailed = {
    type: "assistant",
    error: "authentication_failed",
    parent_tool_use_id: null,
    session_id: "s",
    uuid: "u",
  } as unknown as SDKMessage;
  const controller = new AbortController();
  const info = await probeClaudeHealth(() => fake([authFailed]), {
    abortController: controller,
    processTree: fakeTree(),
  });
  expect(info.health.status).toBe("not-logged-in");
  expect(info.account).toBeNull();
  expect(controller.signal.aborted).toBe(true);
});

test("a spawn ENOENT throw means not-installed", async () => {
  const info = await probeClaudeHealth(() => fake([], new Error("spawn claude ENOENT")), {
    abortController: new AbortController(),
    processTree: fakeTree(),
  });
  expect(info.health.status).toBe("not-installed");
  expect(info.account).toBeNull();
});

// finding §2.7 (phase-8 Task 15): a clean close with no verdict proves NOTHING — it is no longer
// classified as an explicit auth failure (`agent/health/model/probe.ts`'s `inconclusive`).
// CORRECTED (fix round 1, Finding 3): the honest classification is `probe-inconclusive`, not
// `unhealthy-unconfirmed-exit` — that status is the backend's own positively established latch
// (`agent/claude/backend/model/backend.ts`), a different fact entirely.
test("a stream that ends without any init or auth signal is a deliberate probe-inconclusive fallthrough, not ready", async () => {
  const info = await probeClaudeHealth(() => fake([]), {
    abortController: new AbortController(),
    processTree: fakeTree(),
  });
  expect(info.health.status).toBe("probe-inconclusive");
  expect(info.account).toBeNull();
});

test("an inconclusive message is skipped and the loop keeps reading until a later message classifies (loop-continuation path)", async () => {
  const controller = new AbortController();
  const info = await probeClaudeHealth(() => fake([nonClassifying, init]), {
    abortController: controller,
    processTree: fakeTree(),
  });
  expect(info.health.status).toBe("ready");
  expect(controller.signal.aborted).toBe(true);
});

test("a ready verdict is not discarded even when closing the SDK generator rejects (abort must not race IteratorClose)", async () => {
  const controller = new AbortController();
  const info = await probeClaudeHealth(() => fakeRejectingClose([init]), {
    abortController: controller,
    processTree: fakeTree(),
  });
  expect(info.health.status).toBe("ready");
  expect(controller.signal.aborted).toBe(true);
});

// finding §2.7: a deadline timeout proves nothing — least of all that the user is signed out —
// so it classifies the same honest way a clean-close-no-verdict does, never `not-logged-in`.
// CORRECTED (fix round 1, Finding 3): `probe-inconclusive`, not `unhealthy-unconfirmed-exit`.
test("a CLI that connects and then emits nothing does not hang the probe — the bounded deadline reports probe-inconclusive instead", async () => {
  const controller = new AbortController();
  const info = await probeClaudeHealth(() => hangingFake(), {
    abortController: controller,
    wait: async () => {}, // resolves immediately so the test never waits a real deadline
    deadlineMs: 5,
    processTree: fakeTree(),
  });
  expect(info.health.status).toBe("probe-inconclusive");
  expect(info.account).toBeNull();
  expect(controller.signal.aborted).toBe(true);
});

test("probe options isolate the CLI at least as strictly as a real turn: scratch cwd (never termcraft's own), no project settings, deny-by-default canUseTool", async () => {
  let captured: Options | null = null;
  const queryFn: ClaudeQueryFn = (params) => {
    captured = params.options;
    return fake([init]);
  };
  await probeClaudeHealth(queryFn, {
    abortController: new AbortController(),
    processTree: fakeTree(),
  });

  expect(captured).not.toBeNull();
  const opts = captured as unknown as Options;
  expect(typeof opts.cwd).toBe("string");
  expect(opts.cwd).not.toBe(process.cwd());
  expect(opts.settingSources).toEqual([]);
  expect(opts.permissionMode).toBe("default");
  expect(opts.canUseTool).toBeDefined();

  const denyBash = await opts.canUseTool!(
    "Bash",
    {},
    {
      signal: new AbortController().signal,
      toolUseID: "t1",
      requestId: "r1",
    },
  );
  expect(denyBash?.behavior).toBe("deny");

  const denyOutOfScopeRead = await opts.canUseTool!(
    "Read",
    { file_path: "C:\\Users\\someone\\secrets.txt" },
    { signal: new AbortController().signal, toolUseID: "t2", requestId: "r2" },
  );
  expect(denyOutOfScopeRead?.behavior).toBe("deny");

  // The probe's policy must be wired with CLAUDE_CONFINEMENT_TABLES, not just
  // with SOME deny-by-default policy: every assertion above still passes if the
  // tables are replaced by empty ones (empty tables deny everything, so the
  // deny-direction mutants are invisible). This positive case is the only thing
  // that pins the actual Claude tool vocabulary to the probe's call site —
  // `Read` must be in `fileTools` and `file_path` in `pathFields` for an
  // in-scope path under the probe cwd to be allowed at all.
  const allowInScopeRead = await opts.canUseTool!(
    "Read",
    { file_path: path.join(opts.cwd as string, "probe-scratch.txt") },
    { signal: new AbortController().signal, toolUseID: "t3", requestId: "r3" },
  );
  expect(allowInScopeRead?.behavior).toBe("allow");
});

// --- the probe adopts its process tree and closes it on every path ---------

const spawnedChildren: SpawnedProcess[] = [];
afterEach(() => {
  for (const child of spawnedChildren.splice(0)) child.kill("SIGTERM");
});

test("probe options wire spawnClaudeCodeProcess so the probe CLI is adopted into the injected process tree", async () => {
  const { tree, adoptedPids, adoptionOutcomes } = createRecordingProcessTree();
  let captured: Options | null = null;
  const queryFn: ClaudeQueryFn = (params) => {
    captured = params.options;
    return fake([init]);
  };
  await probeClaudeHealth(queryFn, { abortController: new AbortController(), processTree: tree });

  expect(captured).not.toBeNull();
  const opts = captured as unknown as Options;
  expect(opts.spawnClaudeCodeProcess).toBeDefined();

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
  expect(adoptedPids.length).toBe(1);
  expect(adoptedPids[0]).toBeGreaterThan(0);
  expect(adoptionOutcomes).toEqual([true]);
});

test("the process tree is closed once the probe classifies a ready verdict, arming kill-on-close for any survivor", async () => {
  const { tree, closeCalls } = trackClose(fakeTree());
  const info = await probeClaudeHealth(() => fake([init]), {
    abortController: new AbortController(),
    processTree: tree,
  });
  expect(info.health.status).toBe("ready");
  expect(closeCalls()).toBe(1);
});

// CORRECTED (fix round 1, Finding 3): `probe-inconclusive`, not `unhealthy-unconfirmed-exit`.
test("the process tree is closed when the probe deadline times out — the whole point being a probe CLI that ignored the abort still gets reaped", async () => {
  const { tree, closeCalls } = trackClose(fakeTree());
  const info = await probeClaudeHealth(() => hangingFake(), {
    abortController: new AbortController(),
    wait: async () => {},
    deadlineMs: 5,
    processTree: tree,
  });
  expect(info.health.status).toBe("probe-inconclusive");
  expect(closeCalls()).toBe(1);
});

test("the process tree is closed when the probe stream throws (e.g. spawn ENOENT)", async () => {
  const { tree, closeCalls } = trackClose(fakeTree());
  const info = await probeClaudeHealth(() => fake([], new Error("spawn claude ENOENT")), {
    abortController: new AbortController(),
    processTree: tree,
  });
  expect(info.health.status).toBe("not-installed");
  expect(closeCalls()).toBe(1);
});

test("a null processTree (ProcessTreeFactory failure) is a safe no-op close, and the probe still runs unadopted instead of reporting a false verdict", async () => {
  let captured: Options | null = null;
  const queryFn: ClaudeQueryFn = (params) => {
    captured = params.options;
    return fake([init]);
  };
  const info = await probeClaudeHealth(queryFn, {
    abortController: new AbortController(),
    processTree: null,
  });
  expect(info.health.status).toBe("ready");
  const opts = captured as unknown as Options;
  // No tree to adopt into -> the SDK falls back to spawning the CLI itself,
  // an explicit, narrower fallback rather than a silent regression of the
  // general case.
  expect(opts.spawnClaudeCodeProcess).toBeUndefined();
});
