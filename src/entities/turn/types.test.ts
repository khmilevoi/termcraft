import { describe, expect, test } from "bun:test";

import type { AgentEvent, TurnFence } from "./types";

// Compile-time exhaustiveness: adding a variant breaks this switch.
function describeEvent(event: AgentEvent): string {
  switch (event.kind) {
    case "reasoning":
      return `reasoning:${event.text}`;
    case "tool":
      return `tool:${event.op}:${event.target}`;
    case "final":
      return `final:${event.text}`;
    case "usage":
      return `usage:${event.tokens.inputTokens}/${event.tokens.outputTokens}`;
    case "error":
      return `error:${event.message}`;
  }
}

describe("AgentEvent", () => {
  test("narrows every variant of the §6.1 taxonomy", () => {
    const events: AgentEvent[] = [
      { kind: "reasoning", text: "planning" },
      { kind: "tool", op: "edit", target: "pages/main.tsx" },
      { kind: "final", text: "done" },
      {
        kind: "usage",
        tokens: { inputTokens: 10, outputTokens: 5, contextPercent: null },
      },
      { kind: "error", message: "boom" },
    ];
    expect(events.map(describeEvent)).toEqual([
      "reasoning:planning",
      "tool:edit:pages/main.tsx",
      "final:done",
      "usage:10/5",
      "error:boom",
    ]);
  });

  test("TurnFence carries turnId, attempt, leaseNonce", () => {
    const fence: TurnFence = {
      turnId: "0198b1c2-0000-7000-8000-000000000000",
      attempt: 1,
      leaseNonce: "a1b2c3",
    };
    expect(fence.attempt).toBe(1);
  });
});
