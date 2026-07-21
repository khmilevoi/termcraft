import { expect, test } from "bun:test";

import type { ProcessTree } from "../types";
import { ProcessTreeError } from "../types";
import { createJobObjectTree } from "./job-object";

const win = process.platform === "win32";

/**
 * Polls `activeProcesses()` until it reads 0 or the timeout elapses,
 * returning the last read (Spike I: confirmation is a genuine OS read, not a
 * PID-liveness inference — but the read still needs a couple of polls of
 * slack around the kill call in a real test run).
 */
async function pollUntilZero(
  tree: ProcessTree,
  timeoutMs = 5000,
): Promise<ProcessTreeError | number> {
  const start = Date.now();
  let last: ProcessTreeError | number = tree.activeProcesses();
  while (Date.now() - start < timeoutMs) {
    last = tree.activeProcesses();
    if (last === 0) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return last;
}

test.if(win)("adopts a real child and confirms 0 active after terminate (Spike I)", async () => {
  const tree = createJobObjectTree();
  expect(tree).not.toBeInstanceOf(Error);
  const t = tree as ProcessTree;

  const child = Bun.spawn({ cmd: ["bun", "-e", "setInterval(()=>{},1000)"] });
  // Prove the child actually spawned before trusting anything downstream.
  expect(typeof child.pid).toBe("number");
  expect(child.pid).toBeGreaterThan(0);
  expect(child.exitCode).toBeNull();
  expect(child.killed).toBe(false);

  expect(t.adopt(child.pid)).toBeNull();

  // Adopt-then-reread membership check: AssignProcessToJobObject races the
  // child spawning its own descendants (no CREATE_SUSPENDED is reachable
  // from Bun's spawn — Spike I FINDINGS.md "Ordering-hazard result"), so
  // membership must be confirmed by re-reading activeProcesses(), not
  // assumed from adopt()'s success alone.
  const activeAfterAdopt = t.activeProcesses();
  expect(activeAfterAdopt).not.toBeInstanceOf(Error);
  expect(activeAfterAdopt as number).toBeGreaterThanOrEqual(1);

  expect(t.terminate()).toBeNull();

  // Spike I: ActiveProcesses reached 0 within 0-1ms of TerminateJobObject in
  // every trial; poll briefly rather than asserting a single synchronous read.
  const after = await pollUntilZero(t);
  expect(after).not.toBeInstanceOf(Error);
  expect(after).toBe(0);

  // Cross-check against the real OS process, not just the job object's own
  // count: the child must have actually died, with the exit code
  // TerminateJobObject was called with.
  const exitCode = await child.exited;
  expect(exitCode).toBe(1);
  expect(child.killed).toBe(true);
  expect(child.exitCode).toBe(1);

  t.close();
});

test.if(win)(
  "kill-on-close: close() WITHOUT terminate() kills the adopted child (Spike I crash-safety net)",
  async () => {
    // Regression for finding [10]: both other integration tests kill the child
    // explicitly and only then close() — so kill-on-close (the crash-safety
    // net JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is supposed to provide) was never
    // itself exercised against real kernel behavior. This test never calls
    // terminate(): if kill-on-close is not actually wired (e.g. the wrong
    // struct offset), the child never dies and `await child.exited` hangs the
    // test out to the runner's timeout instead of silently passing.
    const tree = createJobObjectTree();
    expect(tree).not.toBeInstanceOf(Error);
    const t = tree as ProcessTree;

    const child = Bun.spawn({ cmd: ["bun", "-e", "setInterval(()=>{},1000)"] });
    expect(typeof child.pid).toBe("number");
    expect(child.exitCode).toBeNull();

    expect(t.adopt(child.pid)).toBeNull();

    // Confirm membership landed before trusting kill-on-close to reap it.
    const activeAfterAdopt = t.activeProcesses();
    expect(activeAfterAdopt).not.toBeInstanceOf(Error);
    expect(activeAfterAdopt as number).toBeGreaterThanOrEqual(1);

    t.close(); // no terminate() call — this line alone must kill the child.

    // Kill-on-close is a distinct kernel mechanism from our explicit
    // `TerminateJobObject(job, 1)` call (used by the other integration
    // tests) — empirically it does not reuse that same exit code, so this
    // asserts the child actually died (the load-bearing claim per the repo
    // rule that a process test must assert the child's exit) without pinning
    // an undocumented exact exit code.
    const exitCode = await child.exited;
    expect(child.killed).toBe(true);
    expect(exitCode).not.toBeNull();
    expect(child.exitCode).toBe(exitCode);
  },
);

test.if(win)(
  "adopt() on a nonexistent pid returns a ProcessTreeError from the OpenProcess-null branch",
  () => {
    // Regression for finding [9]: this pid is chosen far outside any range a
    // live process could hold, so OpenProcess is expected to fail and return a
    // null handle (job-object.ts's `procHandle === null` branch) rather than
    // ever reaching AssignProcessToJobObject. Asserting the message mentions
    // "OpenProcess" (not "AssignProcessToJobObject") is what actually
    // distinguishes this branch from the next one — deleting the null-handle
    // check would still produce *a* ProcessTreeError (from the downstream
    // AssignProcessToJobObject(..., null) failure), but with a different
    // reason string, so a looser `toBeInstanceOf(ProcessTreeError)`-only
    // assertion would not catch that mutant.
    const tree = createJobObjectTree();
    expect(tree).not.toBeInstanceOf(Error);
    const t = tree as ProcessTree;

    const nonexistentPid = 999_999_999;
    const result = t.adopt(nonexistentPid);
    expect(result).toBeInstanceOf(ProcessTreeError);
    expect((result as ProcessTreeError).message).toContain("OpenProcess");

    t.close();
  },
);

test.if(win)(
  "activeProcesses()/terminate()/adopt() refuse with a ProcessTreeError after close()",
  async () => {
    // Regression for findings [9] and [28] together: a closed tree must never
    // let a stale/possibly-recycled handle produce a silent "0 active
    // processes" reading (finding [9]'s "dead handle reads as confirmed
    // exit") — close() now makes the tree INVALIDATING, so every method
    // refuses outright instead of reaching the underlying FFI call at all
    // (finding [28]). This supersedes finding [9]'s literal
    // `QueryInformationJobObject` result===0 branch for the post-close
    // scenario: that branch is now provably unreachable once closed, by
    // construction, which is a strictly stronger guarantee than exercising it.
    const tree = createJobObjectTree();
    expect(tree).not.toBeInstanceOf(Error);
    const t = tree as ProcessTree;

    const child = Bun.spawn({ cmd: ["bun", "-e", "setInterval(()=>{},1000)"] });
    expect(t.adopt(child.pid)).toBeNull();
    t.close();
    await child.exited; // kill-on-close reaps it; avoid leaking the process past the test.

    const activeAfterClose = t.activeProcesses();
    expect(activeAfterClose).toBeInstanceOf(ProcessTreeError);
    expect((activeAfterClose as ProcessTreeError).message).toContain("closed");

    const terminateAfterClose = t.terminate();
    expect(terminateAfterClose).toBeInstanceOf(ProcessTreeError);
    expect((terminateAfterClose as ProcessTreeError).message).toContain("closed");

    const adoptAfterClose = t.adopt(child.pid);
    expect(adoptAfterClose).toBeInstanceOf(ProcessTreeError);
    expect((adoptAfterClose as ProcessTreeError).message).toContain("closed");
  },
);

test.if(win)(
  "close() is idempotent: a second close() never throws and the tree stays refused",
  () => {
    // Regression for finding [28]'s first half — double-close must not attempt
    // a second CloseHandle on a value the OS may have already reused for an
    // unrelated object.
    const tree = createJobObjectTree();
    expect(tree).not.toBeInstanceOf(Error);
    const t = tree as ProcessTree;

    t.close();
    expect(() => t.close()).not.toThrow();
    expect(t.activeProcesses()).toBeInstanceOf(ProcessTreeError);
  },
);

test.if(win)(
  "createJobObjectTree returns independent trees that do not share job membership",
  async () => {
    const treeA = createJobObjectTree();
    const treeB = createJobObjectTree();
    expect(treeA).not.toBeInstanceOf(Error);
    expect(treeB).not.toBeInstanceOf(Error);
    const a = treeA as ProcessTree;
    const b = treeB as ProcessTree;

    const child = Bun.spawn({ cmd: ["bun", "-e", "setInterval(()=>{},1000)"] });
    expect(a.adopt(child.pid)).toBeNull();

    const activeInA = a.activeProcesses();
    const activeInB = b.activeProcesses();
    expect(activeInA).not.toBeInstanceOf(Error);
    expect(activeInB).not.toBeInstanceOf(Error);
    expect(activeInA as number).toBeGreaterThanOrEqual(1);
    expect(activeInB as number).toBe(0);

    expect(a.terminate()).toBeNull();
    const exitCode = await child.exited;
    expect(exitCode).toBe(1);
    a.close();
    b.close();
  },
);
