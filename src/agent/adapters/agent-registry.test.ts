import { describe, expect, test } from "bun:test";

import type { DesignCheckerPort } from "agent/checks";
import { createProductionClaudeBackend } from "agent/claude";
import type { AgentBackend, BackendCapabilities } from "core/ports";
import { createFakeAgentRegistry } from "core/ports/fakes";

import { createProductionAgentRegistry } from "./agent-registry";

/**
 * Behavioral-oracle contract test (WP-2 Task 7 method): `createFakeAgentRegistry`
 * is the oracle for how `AgentRegistry.list`/`get` must behave, keyed by each
 * backend's own `capabilities().backendId` (`fakes/agent-registry.ts:21-24`). This
 * asserts the production registry — one entry, `createProductionClaudeBackend(stubDesignChecker)` —
 * reproduces the same dispositions the fake does for the same scenarios: a known
 * id resolves, an unknown id is `null` (never a thrown lookup), and `list()`
 * reports the real backend's own honest capabilities, not an invented label.
 */

/** The `gate`-backed design self-check the composition root injects (spec WP-10). This suite
 *  asserts registry LOOKUP, never a turn, so a clean stub is the honest stand-in. */
const stubDesignChecker: DesignCheckerPort = {
  check: () => Promise.resolve({ errors: [], warnings: [] }),
};

function stubBackend(backendId: string): AgentBackend {
  const capabilities: BackendCapabilities = {
    backendId,
    models: [{ model: "test-model", efforts: ["medium"] }],
    confinement: "canUseTool",
    sessionWorkspaceBinding: "fixed",
    defaultSelection: { model: "test-model", effort: "medium" },
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
    const registry = createProductionAgentRegistry(stubDesignChecker);
    const expected = createProductionClaudeBackend(stubDesignChecker).capabilities();

    expect(registry.list()).toEqual([expected]);
  });

  test("get(backendId) resolves the real backend for its own reported id — same disposition as the fake", () => {
    const registry = createProductionAgentRegistry(stubDesignChecker);
    const backendId = registry.list()[0]?.backendId;
    if (backendId === undefined) throw new Error("registry.list() returned no entries");
    const fake = createFakeAgentRegistry([stubBackend(backendId)]);

    const resolved = registry.get(backendId);
    expect(resolved).not.toBeNull();
    expect(resolved?.capabilities().backendId).toBe(backendId);
    expect(fake.get(backendId)).not.toBeNull();
  });

  test("get(unknown) is null — the AGENT_UNAVAILABLE rejection path, matching the fake's disposition", () => {
    const registry = createProductionAgentRegistry(stubDesignChecker);
    const knownId = registry.list()[0]?.backendId ?? "claude";
    const fake = createFakeAgentRegistry([stubBackend(knownId)]);

    expect(registry.get("unknown-backend")).toBeNull();
    expect(fake.get("unknown-backend")).toBeNull();
  });

  test("records no calls log of its own — that is a fake-only affordance, not part of the port", () => {
    const registry = createProductionAgentRegistry(stubDesignChecker);
    expect("calls" in registry).toBe(false);
  });
});
