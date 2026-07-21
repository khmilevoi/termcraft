import { describe, expect, test } from "bun:test"

import type { AgentBackend, BackendCapabilities } from "../agent-backend"
import { createFakeAgentRegistry } from "./agent-registry"

function stubBackend(backendId: string): AgentBackend {
  const capabilities: BackendCapabilities = {
    backendId,
    models: [{ model: "test-model", efforts: ["medium"] }],
    confinement: "canUseTool",
    sessionWorkspaceBinding: "fixed",
  }
  return {
    startTurn: () => {
      throw new Error("not used in this test")
    },
    cancel: async () => {},
    healthCheck: async () => ({ backendId, health: { status: "ready" }, account: null }),
    capabilities: () => capabilities,
    sessionScope: () => "unused",
  }
}

describe("createFakeAgentRegistry", () => {
  test("list() returns every registered backend's capabilities", () => {
    const registry = createFakeAgentRegistry([stubBackend("claude"), stubBackend("codex")])
    expect(registry.list().map((c) => c.backendId)).toEqual(["claude", "codex"])
  })

  test("get() finds a registered backend by id", () => {
    const claude = stubBackend("claude")
    const registry = createFakeAgentRegistry([claude])
    expect(registry.get("claude")).toBe(claude)
  })

  test("get() returns null for an unregistered id, never throws (AGENT_UNAVAILABLE path)", () => {
    const registry = createFakeAgentRegistry([stubBackend("claude")])
    expect(registry.get("codex")).toBeNull()
  })

  test("records every list()/get() call in order", () => {
    const registry = createFakeAgentRegistry([stubBackend("claude")])
    registry.list()
    registry.get("claude")
    registry.get("missing")
    expect(registry.calls.map((c) => c.method)).toEqual(["list", "get", "get"])
    expect(registry.calls[1]).toMatchObject({ method: "get", backendId: "claude", found: true })
    expect(registry.calls[2]).toMatchObject({ method: "get", backendId: "missing", found: false })
  })
})
