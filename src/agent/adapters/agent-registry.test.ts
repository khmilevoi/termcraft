import { describe, expect, test } from "bun:test";

import { createProductionClaudeBackend } from "agent/claude";
import type { AgentBackend, BackendCapabilities } from "core/ports";
import { createFakeAgentRegistry } from "core/ports/fakes";

import { createProductionAgentRegistry } from "./agent-registry";

/**
 * Behavioral-oracle contract test (WP-2 Task 7 method): `createFakeAgentRegistry`
 * is the oracle for how `AgentRegistry.list`/`get` must behave, keyed by each
 * backend's own `capabilities().backendId` (`fakes/agent-registry.ts:21-24`). This
 * asserts the production registry — one entry, `createProductionClaudeBackend()` —
 * reproduces the same dispositions the fake does for the same scenarios: a known
 * id resolves, an unknown id is `null` (never a thrown lookup), and `list()`
 * reports the real backend's own honest capabilities, not an invented label.
 */

function stubBackend(backendId: string): AgentBackend {
  const capabilities: BackendCapabilities = {
    backendId,
    models: [{ model: "test-model", efforts: ["medium"] }],
    confinement: "canUseTool",
    sessionWorkspaceBinding: "fixed",
  };
  return {
    startTurn: () => {
      throw new Error("not used in this contract test");
    },
    cancel: async () => {},
    healthCheck: async () => ({ backendId, health: { status: "ready" }, account: null }),
    capabilities: () => capabilities,
    sessionScope: () => "unused",
  };
}

describe("createProductionAgentRegistry", () => {
  test("list() reports exactly the real Claude backend's own honest capabilities", () => {
    const registry = createProductionAgentRegistry();
    const expected = createProductionClaudeBackend().capabilities();

    expect(registry.list()).toEqual([expected]);
  });

  test("get(backendId) resolves the real backend for its own reported id — same disposition as the fake", () => {
    const registry = createProductionAgentRegistry();
    const backendId = registry.list()[0]?.backendId;
    if (backendId === undefined) throw new Error("registry.list() returned no entries");
    const fake = createFakeAgentRegistry([stubBackend(backendId)]);

    const resolved = registry.get(backendId);
    expect(resolved).not.toBeNull();
    expect(resolved?.capabilities().backendId).toBe(backendId);
    expect(fake.get(backendId)).not.toBeNull();
  });

  test("get(unknown) is null — the AGENT_UNAVAILABLE rejection path, matching the fake's disposition", () => {
    const registry = createProductionAgentRegistry();
    const knownId = registry.list()[0]?.backendId ?? "claude";
    const fake = createFakeAgentRegistry([stubBackend(knownId)]);

    expect(registry.get("unknown-backend")).toBeNull();
    expect(fake.get("unknown-backend")).toBeNull();
  });

  test("records no calls log of its own — that is a fake-only affordance, not part of the port", () => {
    const registry = createProductionAgentRegistry();
    expect("calls" in registry).toBe(false);
  });
});
