import { expect, test } from "bun:test"
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { claudeCapabilities, probeHealth } from "./health"
import type { ClaudeQuery, ClaudeQueryFn } from "./query-fn"

function fake(messages: SDKMessage[], throwOnIterate?: Error): ClaudeQuery {
  return {
    async *[Symbol.asyncIterator]() {
      if (throwOnIterate) throw throwOnIterate
      for (const m of messages) yield m
    },
    interrupt: async () => {},
  }
}

/**
 * A `ClaudeQuery` whose `.return()` REJECTS — models the real SDK generator's
 * `IteratorClose` cleanup rejecting (e.g. because the controller was already
 * aborted). `fake()` above is a plain async-generator method, and a plain
 * generator's `.return()` can never reject, so it cannot exercise the
 * [2]/[23] abort-races-IteratorClose defect at all.
 */
function fakeRejectingClose(messages: SDKMessage[]): ClaudeQuery {
  let index = 0
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<SDKMessage>> {
          if (index < messages.length) return { value: messages[index++]!, done: false }
          return { value: undefined, done: true }
        },
        async return(): Promise<IteratorResult<SDKMessage>> {
          throw new DOMException("The operation was aborted.", "AbortError")
        },
      }
    },
    interrupt: async () => {},
  }
}

/** A `ClaudeQuery` that connects and then never yields anything — models a stalled CLI. */
function hangingFake(): ClaudeQuery {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<SDKMessage>>(() => {}),
      }
    },
    interrupt: async () => {},
  }
}

const init = {
  type: "system",
  subtype: "init",
  apiKeySource: "oauth",
  model: "claude-opus-4-8",
  session_id: "s",
  uuid: "u",
} as unknown as SDKMessage

/** Inconclusive on its own — `classifyMessage` returns null for it, so a probe must keep reading past it. */
const nonClassifying = {
  type: "assistant",
  parent_tool_use_id: null,
  session_id: "s",
  uuid: "u",
} as unknown as SDKMessage

test("an init message means installed + logged in (ready); account is null because apiKeySource is not a stable account discriminator", async () => {
  const controller = new AbortController()
  const info = await probeHealth(() => fake([init]), { abortController: controller })
  expect(info.health.status).toBe("ready")
  expect(info.backendId).toBe("claude")
  // apiKeySource ('user'|'project'|'org'|'temporary'|'oauth') is WHERE the
  // credential came from, one of five values for every account alive — never
  // a stable per-account discriminator. The installed SDK's SDKSystemMessage
  // has no field that is one, so null (documented as safely disabling
  // cross-process resume) is the correct value, not apiKeySource.
  expect(info.account).toBeNull()
})

test("ready aborts the controller so no paid turn completes", async () => {
  const controller = new AbortController()
  await probeHealth(() => fake([init]), { abortController: controller })
  expect(controller.signal.aborted).toBe(true)
})

test("an auth_status signal means not-logged-in", async () => {
  const authErr = {
    type: "auth_status",
    isAuthenticating: false,
    error: "not logged in",
    session_id: "s",
    uuid: "u",
  } as unknown as SDKMessage
  const controller = new AbortController()
  const info = await probeHealth(() => fake([authErr]), { abortController: controller })
  expect(info.health.status).toBe("not-logged-in")
  expect(info.account).toBeNull()
  expect(controller.signal.aborted).toBe(true)
})

test("an assistant authentication_failed error means not-logged-in", async () => {
  const authFailed = {
    type: "assistant",
    error: "authentication_failed",
    parent_tool_use_id: null,
    session_id: "s",
    uuid: "u",
  } as unknown as SDKMessage
  const controller = new AbortController()
  const info = await probeHealth(() => fake([authFailed]), { abortController: controller })
  expect(info.health.status).toBe("not-logged-in")
  expect(info.account).toBeNull()
  expect(controller.signal.aborted).toBe(true)
})

test("a spawn ENOENT throw means not-installed", async () => {
  const info = await probeHealth(() => fake([], new Error("spawn claude ENOENT")), {
    abortController: new AbortController(),
  })
  expect(info.health.status).toBe("not-installed")
  expect(info.account).toBeNull()
})

test("a stream that ends without any init or auth signal is a deliberate not-logged-in fallthrough, not ready", async () => {
  const info = await probeHealth(() => fake([]), { abortController: new AbortController() })
  expect(info.health.status).toBe("not-logged-in")
  expect(info.account).toBeNull()
})

test("an inconclusive message is skipped and the loop keeps reading until a later message classifies (loop-continuation path)", async () => {
  const controller = new AbortController()
  const info = await probeHealth(() => fake([nonClassifying, init]), { abortController: controller })
  expect(info.health.status).toBe("ready")
  expect(controller.signal.aborted).toBe(true)
})

test("a ready verdict is not discarded even when closing the SDK generator rejects (abort must not race IteratorClose)", async () => {
  const controller = new AbortController()
  const info = await probeHealth(() => fakeRejectingClose([init]), { abortController: controller })
  expect(info.health.status).toBe("ready")
  expect(controller.signal.aborted).toBe(true)
})

test("a CLI that connects and then emits nothing does not hang the probe — the bounded deadline reports not-logged-in instead", async () => {
  const controller = new AbortController()
  const info = await probeHealth(
    () => hangingFake(),
    {
      abortController: controller,
      wait: async () => {}, // resolves immediately so the test never waits a real deadline
      deadlineMs: 5,
    },
  )
  expect(info.health.status).toBe("not-logged-in")
  expect(info.account).toBeNull()
  expect(controller.signal.aborted).toBe(true)
})

test("probe options isolate the CLI at least as strictly as a real turn: scratch cwd (never termcraft's own), no project settings, deny-by-default canUseTool", async () => {
  let captured: Options | null = null
  const queryFn: ClaudeQueryFn = (params) => {
    captured = params.options
    return fake([init])
  }
  await probeHealth(queryFn, { abortController: new AbortController() })

  expect(captured).not.toBeNull()
  const opts = captured as unknown as Options
  expect(typeof opts.cwd).toBe("string")
  expect(opts.cwd).not.toBe(process.cwd())
  expect(opts.settingSources).toEqual([])
  expect(opts.permissionMode).toBe("default")
  expect(opts.canUseTool).toBeDefined()

  const denyBash = await opts.canUseTool!("Bash", {}, {
    signal: new AbortController().signal,
    toolUseID: "t1",
    requestId: "r1",
  })
  expect(denyBash?.behavior).toBe("deny")

  const denyOutOfScopeRead = await opts.canUseTool!(
    "Read",
    { file_path: "C:\\Users\\someone\\secrets.txt" },
    { signal: new AbortController().signal, toolUseID: "t2", requestId: "r2" },
  )
  expect(denyOutOfScopeRead?.behavior).toBe("deny")
})

test("capabilities advertise canUseTool confinement and rebindable sessions", () => {
  const caps = claudeCapabilities()
  expect(caps.confinement).toBe("canUseTool")
  expect(caps.sessionWorkspaceBinding).toBe("rebindable")
  expect(caps.models.length).toBeGreaterThan(0)
  expect(caps.models[0]!.efforts).toContain("high")
})
