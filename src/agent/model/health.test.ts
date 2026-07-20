import { expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { claudeCapabilities, probeHealth } from "./health"
import type { ClaudeQuery } from "./query-fn"

function fake(messages: SDKMessage[], throwOnIterate?: Error): ClaudeQuery {
  return {
    async *[Symbol.asyncIterator]() {
      if (throwOnIterate) throw throwOnIterate
      for (const m of messages) yield m
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

test("an init message means installed + logged in (ready), and captures the account discriminator", async () => {
  const controller = new AbortController()
  const info = await probeHealth(() => fake([init]), { abortController: controller })
  expect(info.health.status).toBe("ready")
  expect(info.backendId).toBe("claude")
  expect(info.account).toBe("oauth")
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

test("capabilities advertise canUseTool confinement and rebindable sessions", () => {
  const caps = claudeCapabilities()
  expect(caps.confinement).toBe("canUseTool")
  expect(caps.sessionWorkspaceBinding).toBe("rebindable")
  expect(caps.models.length).toBeGreaterThan(0)
  expect(caps.models[0]!.efforts).toContain("high")
})
