import { expect, test } from "bun:test";

import { planToSessionOptions } from "./session-options";

test("a resume plan passes resume:sessionId and forkSession:false", () => {
  expect(planToSessionOptions({ kind: "resume", sessionId: "s9", promptDelta: null })).toEqual({
    resume: "s9",
    forkSession: false,
  });
});

test("a fresh plan carries no resume id", () => {
  expect(planToSessionOptions({ kind: "fresh", seed: [] })).toEqual({ forkSession: false });
});
