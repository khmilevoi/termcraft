import { describe, expect, test } from "bun:test";

import type { AgentHealth } from "../types";
import { agentBlockedNote, agentHealthBadge } from "./badge";

const WIDE = { short: false } as const;
const NARROW = { short: true } as const;

describe("agentHealthBadge (design 30 · badge vocabulary, engine agentBadge :208-218)", () => {
  test("ready draws nothing, matching Home", () => {
    expect(agentHealthBadge({ kind: "ready", agent: "claude" }, WIDE)).toBeNull();
  });

  test("checking reads amber-on-line and drops the agent name at 80 columns", () => {
    expect(agentHealthBadge({ kind: "checking", agent: "claude" }, WIDE)).toEqual({
      text: "⠹ checking claude",
      fg: "amberHi",
      bg: "line",
    });
    expect(agentHealthBadge({ kind: "checking", agent: "claude" }, NARROW)?.text).toBe(
      "⠹ checking",
    );
  });

  test("advisory names its own cause and never carries the agent name", () => {
    const sandbox: AgentHealth = {
      kind: "advisory",
      agent: "claude",
      panel: "sandbox",
      detail: "x",
    };
    const shutdown: AgentHealth = {
      kind: "advisory",
      agent: "claude",
      panel: "shutdown",
      detail: "x",
    };
    expect(agentHealthBadge(sandbox, WIDE)).toEqual({
      text: "⚠ sandbox degraded",
      fg: "amberHi",
      bg: "line",
    });
    expect(agentHealthBadge(shutdown, WIDE)?.text).toBe("⚠ health unconfirmed");
    expect(agentHealthBadge(shutdown, NARROW)?.text).toBe("⚠ health unconfirmed");
  });

  test("blocked reads bg-on-red and tells its two causes apart", () => {
    const login: AgentHealth = { kind: "blocked", agent: "claude", panel: "login", detail: "x" };
    const latched: AgentHealth = {
      kind: "blocked",
      agent: "claude",
      panel: "latched",
      detail: "x",
    };
    expect(agentHealthBadge(login, WIDE)).toEqual({
      text: "✗ claude not signed in",
      fg: "bg",
      bg: "red",
    });
    expect(agentHealthBadge(login, NARROW)?.text).toBe("✗ not signed in");
    expect(agentHealthBadge(latched, WIDE)?.text).toBe("✗ claude unavailable");
    expect(agentHealthBadge(latched, NARROW)?.text).toBe("✗ unavailable");
  });

  test("missing gets the badge the design invented for it", () => {
    const missing: AgentHealth = {
      kind: "missing",
      agent: "claude",
      detail: "claude CLI not found",
    };
    expect(agentHealthBadge(missing, WIDE)).toEqual({
      text: "✗ claude not found",
      fg: "bg",
      bg: "red",
    });
    expect(agentHealthBadge(missing, NARROW)?.text).toBe("✗ not found");
  });
});

describe("agentBlockedNote (design 30 · the collision)", () => {
  test("only the two red states block a repair turn", () => {
    expect(agentBlockedNote({ kind: "ready", agent: "claude" })).toBeNull();
    expect(agentBlockedNote({ kind: "checking", agent: "claude" })).toBeNull();
    expect(
      agentBlockedNote({ kind: "advisory", agent: "claude", panel: "shutdown", detail: "x" }),
    ).toBeNull();
  });

  test("the login case is the design's own two lines, verbatim", () => {
    expect(
      agentBlockedNote({ kind: "blocked", agent: "claude", panel: "login", detail: "x" }),
    ).toEqual({
      line: "✗ claude not signed in — F6 fills the composer, but nothing runs yet",
      f6Detail: "claude is not signed in — nothing runs until it is",
    });
  });

  test("the other two blocking causes keep the same sentence shape", () => {
    expect(
      agentBlockedNote({ kind: "blocked", agent: "claude", panel: "latched", detail: "x" })
        ?.f6Detail,
    ).toBe("claude is unavailable — nothing runs until it is");
    expect(
      agentBlockedNote({ kind: "missing", agent: "claude", detail: "claude CLI not found" })
        ?.f6Detail,
    ).toBe("claude is not installed — nothing runs until it is");
  });
});
