import { describe, expect, spyOn, test } from "bun:test";

import type { AgentBackend } from "agent";
import { createFakeAgentBackend } from "core/ports/fakes";

import { createAgentHealthProbe, homeHealthFromAgentInfo } from "./agent-health";

// Matches the REAL `AgentInfo` shape (`agent/types.ts`) exactly — `backendId`, `health`,
// `account` — no deviation from the plan's sketch was needed.
const base = { backendId: "claude", account: null } as const;

const CAPABILITIES = {
  backendId: "claude",
  models: [{ model: "claude-sonnet-5", efforts: ["high"] as const }],
  confinement: "canUseTool" as const,
  sessionWorkspaceBinding: "fixed" as const,
  defaultSelection: { model: "claude-sonnet-5", effort: "high" as const },
};

describe("homeHealthFromAgentInfo", () => {
  test("ready is present, with the backend id and no invented version", () => {
    const health = homeHealthFromAgentInfo({ ...base, health: { status: "ready" } });

    expect(health.present).toBe(true);
    expect(health.agent).toBe("claude");
    expect(health.detail).toBe("agent ready");
    expect(health.version).toBeNull();
  });

  test("not-installed is the missing-agent state", () => {
    const health = homeHealthFromAgentInfo({ ...base, health: { status: "not-installed" } });

    expect(health.present).toBe(false);
    expect(health.detail).toBe("claude CLI not found");
  });

  test("not-logged-in is not present, and says so honestly", () => {
    const health = homeHealthFromAgentInfo({ ...base, health: { status: "not-logged-in" } });

    expect(health.present).toBe(false);
    expect(health.detail).toBe("claude CLI found but not logged in");
  });

  test("an unconfirmed exit is not reported as ready", () => {
    const health = homeHealthFromAgentInfo({
      ...base,
      health: { status: "unhealthy-unconfirmed-exit" },
    });

    expect(health.present).toBe(false);
  });

  test("sandbox-degraded carries the backend's own detail", () => {
    const health = homeHealthFromAgentInfo({
      ...base,
      health: { status: "sandbox-degraded", detail: "seatbelt unavailable" },
    });

    expect(health.detail).toContain("seatbelt unavailable");
  });
});

describe("createAgentHealthProbe", () => {
  test("a successful reading folds the backend's declared default model/effort in (WP-4 + WP-5)", async () => {
    const backend = createFakeAgentBackend({ capabilities: CAPABILITIES });
    backend.queueHealth({ backendId: "claude", health: { status: "ready" }, account: null });

    const probe = createAgentHealthProbe(backend);
    const health = await probe();

    expect(health).toEqual({
      present: true,
      agent: "claude",
      detail: "agent ready",
      version: null,
      model: "claude-sonnet-5",
      effort: "high",
    });
  });

  test("a rejected healthCheck() becomes an honest not-present reading, never a fabricated ready, and is logged", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    // `startTurn`/`cancel`/`sessionScope` are typed stubs the probe must never reach — mirrors
    // `create-shell.test.ts`'s own `NEVER_SPAWN` pattern for "must not be called" doubles.
    const backend: AgentBackend = {
      startTurn: () => {
        throw new Error("startTurn must not be called by the health probe");
      },
      cancel: () => Promise.resolve(),
      healthCheck: () => Promise.reject(new Error("spawn ENOENT")),
      capabilities: () => CAPABILITIES,
      sessionScope: () => "unused",
    };

    const probe = createAgentHealthProbe(backend);
    const health = await probe();

    expect(health.present).toBe(false);
    expect(health.agent).toBe("claude");
    expect(health.detail).toContain("spawn ENOENT");
    expect(health.model).toBe("claude-sonnet-5");
    expect(health.effort).toBe("high");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
