import { describe, expect, test } from "bun:test";

import type { FailureDtoV1 } from "core/protocol";

import { createFakeGitCommitter } from "./git-committer";

const FAILURE: FailureDtoV1 = {
  code: "COMMIT_PLAN_STALE",
  retryable: false,
  safeMessage: "plan is stale",
  details: {},
};

describe("createFakeGitCommitter", () => {
  test("planCommit() returns a default empty plan", async () => {
    const committer = createFakeGitCommitter();
    const plan = await committer.planCommit({ kind: "entire-project" });
    if ("code" in plan) throw new Error("unexpected failure");
    expect(plan.paths).toEqual([]);
  });

  test("commit() mints a distinct commitId per call", async () => {
    const committer = createFakeGitCommitter();
    const plan = await committer.planCommit({ kind: "entire-project" });
    if ("code" in plan) throw new Error("unexpected failure");
    const first = await committer.commit(plan, "msg 1");
    const second = await committer.commit(plan, "msg 2");
    if ("code" in first || "code" in second) throw new Error("unexpected failure");
    expect(first.commitId).not.toBe(second.commitId);
  });

  test("failNext() queues one failure for commit()", async () => {
    const committer = createFakeGitCommitter();
    const plan = await committer.planCommit({ kind: "entire-project" });
    if ("code" in plan) throw new Error("unexpected failure");
    committer.failNext("commit", FAILURE);
    const first = await committer.commit(plan, "msg");
    expect(first).toEqual(FAILURE);
    const second = await committer.commit(plan, "msg");
    expect("code" in second).toBe(false);
  });

  test("records calls in order", async () => {
    const committer = createFakeGitCommitter();
    const plan = await committer.planCommit({ kind: "entire-project" });
    if ("code" in plan) throw new Error("unexpected failure");
    await committer.commit(plan, "msg");
    expect(committer.calls.map((c) => c.method)).toEqual(["planCommit", "commit"]);
  });
});
