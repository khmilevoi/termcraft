import { describe, expect, spyOn, test } from "bun:test";

import type { AgentBackend } from "agent";
import { createFakeAgentBackend, createFakeAgentRegistry } from "core/ports/fakes";

import {
  agentHealthFromAgentInfo,
  createAgentHealthProbe,
  resolveDefaultAgentSelection,
} from "./agent-health";

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

describe("agentHealthFromAgentInfo (finding §2.7, phase-8 Task 15: five outcomes)", () => {
  test("ready carries the backend id, and no detail at all", () => {
    const health = agentHealthFromAgentInfo({ ...base, health: { status: "ready" } });

    expect(health).toEqual({ kind: "ready", agent: "claude" });
  });

  test("not-installed is the missing-agent state (full-screen takeover)", () => {
    const health = agentHealthFromAgentInfo({ ...base, health: { status: "not-installed" } });

    expect(health).toEqual({ kind: "missing", agent: "claude", detail: "claude CLI not found" });
  });

  test("not-logged-in is blocked/login, and says so honestly — never the version design's sample carries", () => {
    const health = agentHealthFromAgentInfo({ ...base, health: { status: "not-logged-in" } });

    expect(health).toEqual({
      kind: "blocked",
      agent: "claude",
      panel: "login",
      detail: "claude found · not signed in",
    });
  });

  // CORRECTED (fix round 1, Finding 3 — Important, plan-mandated): this used to map to
  // `advisory/shutdown`, telling the user Enter would work. `unhealthy-unconfirmed-exit` is the
  // backend's own POSITIVELY established latch (`agent/claude/backend/model/backend.ts`) — a
  // prior run's exit was never confirmed, and `startTurn` REFUSES new turns until restart. That
  // is a genuine block, not an unproven reading; `advisory` said Enter worked when a real turn
  // would be rejected. `blocked/latched` is the honest mapping — no design mock covers this
  // cause, so `HomeHealthPanel`'s own `panelSpec` documents the divergence.
  test("an unconfirmed exit is blocked/latched — a confirmed lockout, never advisory and never ready", () => {
    const health = agentHealthFromAgentInfo({
      ...base,
      health: { status: "unhealthy-unconfirmed-exit" },
    });

    expect(health).toEqual({
      kind: "blocked",
      agent: "claude",
      panel: "latched",
      detail: "claude exited without confirming shutdown; locked out until restarted",
    });
  });

  // The genuinely unproven case (fix round 1, Finding 3): the PROBE itself could not reach a
  // verdict (deadline/abort/clean-close — `agent/health/model/probe.ts`'s `inconclusive`), which
  // proves nothing about whether a turn would work — unlike the confirmed latch above.
  test("probe-inconclusive is advisory/shutdown — genuinely unproven, submit stays allowed", () => {
    const health = agentHealthFromAgentInfo({
      ...base,
      health: { status: "probe-inconclusive" },
    });

    expect(health).toEqual({
      kind: "advisory",
      agent: "claude",
      panel: "shutdown",
      detail: "claude's health probe ended without a confirmed verdict",
    });
  });

  // The design's own fixed `homeHealth('sandbox')` wording (`design/termcraft-engine.js:185`,
  // "sandbox unavailable — {agent} runs unconfined") — NOT the backend's free-text `detail`
  // (`"seatbelt unavailable"` here), which this outcome no longer folds in: `HomeHealthPanel`
  // renders this exact string, and inventing a second, backend-specific wording alongside the
  // design's own would contradict the one honest line the panel shows. The backend's own detail
  // is not silently discarded, though (fix round 1, Minor finding) — it is logged.
  test("sandbox-degraded is advisory/sandbox, with design's own fixed wording, and logs the backend's own cause", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    const health = agentHealthFromAgentInfo({
      ...base,
      health: { status: "sandbox-degraded", detail: "seatbelt unavailable" },
    });

    if (health.kind !== "advisory") throw new Error("expected an advisory outcome");
    expect(health.panel).toBe("sandbox");
    expect(health.detail).toBe("sandbox unavailable — claude runs unconfined");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.join(" ")).toContain("seatbelt unavailable");
    warnSpy.mockRestore();
  });
});

describe("createAgentHealthProbe", () => {
  test("a successful reading is health only — no capabilities()/model/effort folded in (phase-8 Task 13, finding §2.7)", async () => {
    const backend = createFakeAgentBackend({ capabilities: CAPABILITIES });
    backend.queueHealth({ backendId: "claude", health: { status: "ready" }, account: null });

    const probe = createAgentHealthProbe(backend);
    const health = await probe();

    expect(health).toEqual({ kind: "ready", agent: "claude" });
  });

  test("a rejected healthCheck() becomes advisory/shutdown, never blocked (a spawn fault is unproven), and is logged", async () => {
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

    if (health.kind !== "advisory") throw new Error("expected an advisory outcome");
    expect(health.panel).toBe("shutdown");
    expect(health.agent).toBe("claude");
    expect(health.detail).toContain("spawn ENOENT");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

describe("resolveDefaultAgentSelection (phase-8 Task 13, finding §2.7)", () => {
  test("null for demo mode — no registry, never a fabricated identity", () => {
    expect(resolveDefaultAgentSelection(null)).toBeNull();
  });

  test("null for an empty catalog", () => {
    const registry = createFakeAgentRegistry([]);

    expect(resolveDefaultAgentSelection(registry)).toBeNull();
  });

  test("the sole registered backend's declared default (WP-4), read synchronously off the catalog", () => {
    const backend = createFakeAgentBackend({ capabilities: CAPABILITIES });
    const registry = createFakeAgentRegistry([backend]);

    expect(resolveDefaultAgentSelection(registry)).toEqual({
      agent: "claude",
      model: "claude-sonnet-5",
      effort: "high",
    });
  });
});
