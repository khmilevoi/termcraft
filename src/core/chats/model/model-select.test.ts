import { describe, expect, test } from "bun:test"

import type { FailureDtoV1 } from "core/protocol"
import { createFakeAgentBackend, createFakeAgentRegistry, createFakeProjectStore } from "core/ports/fakes"

import { selectModel, validateModelSelection } from "./model-select"

function registryWithOneBackend() {
  const backend = createFakeAgentBackend({
    capabilities: {
      backendId: "claude",
      models: [
        { model: "sonnet", efforts: ["low", "medium", "high"] },
        { model: "opus", efforts: ["high", "xhigh"] },
      ],
      confinement: "canUseTool",
      sessionWorkspaceBinding: "fixed",
    },
  })
  return createFakeAgentRegistry([backend])
}

describe("validateModelSelection", () => {
  test("accepts a (backend, model, effort) triple the registry actually offers", () => {
    const registry = registryWithOneBackend()
    const result = validateModelSelection(registry, { backend: "claude", model: "sonnet", effort: "high" })
    expect(result).toEqual({ backend: "claude", model: "sonnet", effort: "high" })
  })

  test("rejects an unknown backend with CAPABILITY_UNAVAILABLE", () => {
    const registry = registryWithOneBackend()
    const result = validateModelSelection(registry, { backend: "unknown", model: "sonnet", effort: "high" })
    expect(result).toEqual({ code: "CAPABILITY_UNAVAILABLE" })
  })

  test("rejects a model the backend does not offer, even though the backend itself exists", () => {
    const registry = registryWithOneBackend()
    const result = validateModelSelection(registry, { backend: "claude", model: "haiku", effort: "high" })
    expect(result).toEqual({ code: "CAPABILITY_UNAVAILABLE" })
  })

  test("rejects an effort the chosen model does not offer, even though another model on the same backend does", () => {
    const registry = registryWithOneBackend()
    // "low" is valid for sonnet but not for opus.
    const result = validateModelSelection(registry, { backend: "claude", model: "opus", effort: "low" })
    expect(result).toEqual({ code: "CAPABILITY_UNAVAILABLE" })
  })
})

describe("selectModel", () => {
  const FAILURE: FailureDtoV1 = { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: "disk unavailable", details: {} }

  test("persists a validated selection to workspace state", async () => {
    const registry = registryWithOneBackend()
    const projectStore = createFakeProjectStore({ root: "C:/proj" })

    const result = await selectModel({ registry, projectStore }, { backend: "claude", model: "sonnet", effort: "medium" })

    expect(result).toEqual({ kind: "selected" })
    const workspace = await projectStore.readWorkspaceState()
    if ("code" in workspace) throw workspace
    expect(workspace.state.backend).toBe("claude")
    expect(workspace.state.model).toBe("sonnet")
    expect(workspace.state.effort).toBe("medium")
  })

  test("rejects an invalid selection without writing workspace state", async () => {
    const registry = registryWithOneBackend()
    const projectStore = createFakeProjectStore({ root: "C:/proj" })

    const result = await selectModel({ registry, projectStore }, { backend: "claude", model: "haiku", effort: "high" })

    expect(result).toEqual({ code: "CAPABILITY_UNAVAILABLE" })
    expect(projectStore.calls.some((c) => c.method === "writeWorkspaceState")).toBe(false)
  })

  test("propagates a workspace-state write failure", async () => {
    const registry = registryWithOneBackend()
    const projectStore = createFakeProjectStore({ root: "C:/proj" })
    projectStore.failNext("writeWorkspaceState", FAILURE)

    const result = await selectModel({ registry, projectStore }, { backend: "claude", model: "sonnet", effort: "high" })

    expect(result).toEqual(FAILURE)
  })
})
