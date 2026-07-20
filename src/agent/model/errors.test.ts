import { expect, test } from "bun:test"
import * as errore from "errore"
import { AgentHealthProbeError, ClaudeSdkError } from "./errors"

test("ClaudeSdkError carries a stable code and preserves cause", () => {
  const cause = new Error("spawn ENOENT")
  const err = new ClaudeSdkError({ code: "SPAWN_FAILED", reason: "cli not found", cause })
  expect(err).toBeInstanceOf(Error)
  expect(err._tag).toBe("ClaudeSdkError")
  expect(err.code).toBe("SPAWN_FAILED")
  expect(err.cause).toBe(cause)
})

// NOTE: `findCause(Error)` is not useful here — the installed errore@0.14.1
// `findCause` checks the error itself before walking `.cause`, and every
// tagged error already IS an `Error`, so `err.findCause(Error)` always
// returns `err` itself, never `cause` (verified against the installed
// package; the errore skill's own examples always target a specific
// subclass, never plain `Error`, for this reason). This test targets a
// distinguishing subclass instead, which is what actually exercises the
// cause-chain walk.
test("findCause walks past ClaudeSdkError to a specific cause class", () => {
  class SpawnFailure extends Error {}
  const cause = new SpawnFailure("spawn ENOENT")
  const err = new ClaudeSdkError({ code: "SPAWN_FAILED", reason: "cli not found", cause })
  expect(err.findCause(SpawnFailure)).toBe(cause)
})

test("isAbortError walks a ClaudeSdkError cause chain", () => {
  class Timeout extends errore.createTaggedError({
    name: "Timeout",
    message: "t",
    extends: errore.AbortError,
  }) {}
  const wrapped = new ClaudeSdkError({ code: "STREAM_FAILED", reason: "aborted", cause: new Timeout({}) })
  expect(errore.isAbortError(wrapped)).toBe(true)
})

test("AgentHealthProbeError distinguishes the probe boundary", () => {
  const err = new AgentHealthProbeError({ reason: "no init message" })
  expect(err._tag).toBe("AgentHealthProbeError")
})
