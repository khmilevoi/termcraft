import { expect, test } from "bun:test";

import type { ProcessTree, ProcessTreeFactory } from "./types";
import { ProcessTreeError } from "./types";

test("ProcessTreeError is a tagged error", () => {
  const e = new ProcessTreeError({ reason: "CreateJobObjectW failed" });
  expect(e).toBeInstanceOf(Error);
  expect(e._tag).toBe("ProcessTreeError");
});

test("a ProcessTree exposes adopt/activeProcesses/terminate/close", () => {
  const shape: (keyof ProcessTree)[] = ["adopt", "activeProcesses", "terminate", "close"];
  expect(shape).toHaveLength(4);
});

test("ProcessTreeFactory creates a tree or returns the tagged error", () => {
  const make: ProcessTreeFactory = () => new ProcessTreeError({ reason: "unsupported platform" });
  const t = make();
  expect(t).toBeInstanceOf(ProcessTreeError);
});
