import { describe, expect, test } from "bun:test";

import type { FailureDtoV1 } from "core/protocol";

import { createFakeGitHistory } from "./git-history";

const FAILURE: FailureDtoV1 = {
  code: "GIT_COMMAND_FAILED",
  retryable: true,
  safeMessage: "git failed",
  details: {},
};

describe("createFakeGitHistory", () => {
  test("inspectProject() defaults to no-repository", async () => {
    const history = createFakeGitHistory();
    const result = await history.inspectProject("C:/proj");
    expect(result).toEqual({ repository: "no-repository", headCommitId: null });
  });

  test("inspectProject() honors a configured project state", async () => {
    const history = createFakeGitHistory({
      project: { repository: "normal", headCommitId: "abc123" },
    });
    const result = await history.inspectProject("C:/proj");
    expect(result).toEqual({ repository: "normal", headCommitId: "abc123" });
  });

  test("listPageCommits() defaults to an empty page with no next cursor", async () => {
    const history = createFakeGitHistory();
    const result = await history.listPageCommits({ sourcePath: "C:/proj/pages/home/index.tsx" });
    expect(result).toEqual({ entries: [], nextCursor: null });
  });

  test("failNext() queues one failure for inspectPage()", async () => {
    const history = createFakeGitHistory();
    history.failNext("inspectPage", FAILURE);
    const first = await history.inspectPage("C:/proj/pages/home/index.tsx");
    expect(first).toEqual(FAILURE);
    const second = await history.inspectPage("C:/proj/pages/home/index.tsx");
    expect("code" in second).toBe(false);
  });

  test("records calls in order", async () => {
    const history = createFakeGitHistory();
    await history.inspectProject("C:/proj");
    await history.inspectIndex("C:/proj/pages/home/index.tsx");
    expect(history.calls.map((c) => c.method)).toEqual(["inspectProject", "inspectIndex"]);
  });
});
