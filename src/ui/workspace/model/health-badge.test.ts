import { describe, expect, test } from "bun:test";

import type { AgentHealth } from "ui/agent-health";

import { agentDeadNotice, agentHealthBadge } from "./health-badge";

const CLAUDE = "claude";

describe("agentHealthBadge (design 30, engine agentBadge :208-218)", () => {
  test("ready draws nothing, matching Home", () => {
    expect(agentHealthBadge({ kind: "ready", agent: CLAUDE }, false)).toBeNull();
  });

  test("checking reads amberHi on line and names the agent", () => {
    expect(agentHealthBadge({ kind: "checking", agent: CLAUDE }, false)).toEqual({
      text: "⠹ checking claude",
      fg: "amberHi",
      bg: "line",
    });
  });

  test("advisory tells its two panels apart", () => {
    const sandbox: AgentHealth = {
      kind: "advisory",
      agent: CLAUDE,
      panel: "sandbox",
      detail: "sandbox unavailable",
    };
    const shutdown: AgentHealth = {
      kind: "advisory",
      agent: CLAUDE,
      panel: "shutdown",
      detail: "exited without confirming shutdown",
    };
    expect(agentHealthBadge(sandbox, false)?.text).toBe("⚠ sandbox degraded");
    expect(agentHealthBadge(shutdown, false)?.text).toBe("⚠ health unconfirmed");
    expect(agentHealthBadge(shutdown, false)?.bg).toBe("line");
  });

  test("blocked reads bg-on-red and tells login from latched", () => {
    const login: AgentHealth = {
      kind: "blocked",
      agent: CLAUDE,
      panel: "login",
      detail: "not signed in",
    };
    const latched: AgentHealth = {
      kind: "blocked",
      agent: CLAUDE,
      panel: "latched",
      detail: "unconfirmed exit lockout",
    };
    expect(agentHealthBadge(login, false)).toEqual({
      text: "✗ claude not signed in",
      fg: "bg",
      bg: "red",
    });
    expect(agentHealthBadge(latched, false)?.text).toBe("✗ claude unavailable");
  });

  test("missing gets a badge here — no full-screen takeover in the Workspace", () => {
    expect(
      agentHealthBadge({ kind: "missing", agent: CLAUDE, detail: "not on PATH" }, false),
    ).toEqual({ text: "✗ claude not found", fg: "bg", bg: "red" });
  });

  test("short drops the agent name for the 80-column floor", () => {
    expect(agentHealthBadge({ kind: "checking", agent: CLAUDE }, true)?.text).toBe("⠹ checking");
    expect(
      agentHealthBadge({ kind: "blocked", agent: CLAUDE, panel: "login", detail: "x" }, true)?.text,
    ).toBe("✗ not signed in");
    expect(
      agentHealthBadge({ kind: "blocked", agent: CLAUDE, panel: "latched", detail: "x" }, true)
        ?.text,
    ).toBe("✗ unavailable");
    expect(agentHealthBadge({ kind: "missing", agent: CLAUDE, detail: "x" }, true)?.text).toBe(
      "✗ not found",
    );
    // The advisory phrases never carry the agent name, so `short` cannot change them.
    expect(
      agentHealthBadge({ kind: "advisory", agent: CLAUDE, panel: "sandbox", detail: "x" }, true)
        ?.text,
    ).toBe("⚠ sandbox degraded");
  });
});

describe("agentDeadNotice (design 30, the collision)", () => {
  test("a healthy or merely advisory agent produces no notice", () => {
    expect(agentDeadNotice({ kind: "ready", agent: "claude" })).toBeNull();
    expect(agentDeadNotice({ kind: "checking", agent: "claude" })).toBeNull();
    expect(
      agentDeadNotice({ kind: "advisory", agent: "claude", panel: "shutdown", detail: "x" }),
    ).toBeNull();
  });

  test("blocked/login gets the design's own F6 detail and its red line", () => {
    expect(
      agentDeadNotice({ kind: "blocked", agent: "claude", panel: "login", detail: "x" }),
    ).toEqual({
      f6Detail: "claude is not signed in — nothing runs until it is",
      line: "✗ claude not signed in — F6 fills the composer, but nothing runs yet",
    });
  });

  test("latched and missing get the generic line, and leave F6's own detail alone", () => {
    expect(
      agentDeadNotice({ kind: "blocked", agent: "claude", panel: "latched", detail: "x" }),
    ).toEqual({
      f6Detail: null,
      line: "✗ claude unavailable — F6 fills the composer, but nothing runs yet",
    });
    expect(agentDeadNotice({ kind: "missing", agent: "claude", detail: "x" })).toEqual({
      f6Detail: null,
      line: "✗ claude not found — F6 fills the composer, but nothing runs yet",
    });
  });
});
