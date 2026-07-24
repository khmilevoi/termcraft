import { describe, expect, test } from "bun:test";

import type { ChatRecordDtoV1 } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";

import { deriveChatDisplayName } from "./display-name";

const TS = "2026-07-24T00:00:00.000Z";

function userRecord(text: string): ChatRecordDtoV1 {
  return {
    kind: "user",
    recordId: uuidv7(),
    turnId: uuidv7(),
    text,
    selection: null,
    pins: [],
    ts: TS,
  };
}

function agentRecord(text: string): ChatRecordDtoV1 {
  return {
    kind: "agent",
    recordId: uuidv7(),
    turnId: uuidv7(),
    text,
    changedPages: [],
    warnings: [],
    ts: TS,
  };
}

function systemErrorRecord(text: string): ChatRecordDtoV1 {
  return {
    kind: "system:error",
    recordId: uuidv7(),
    turnId: uuidv7(),
    actionId: null,
    outcome: "error",
    reason: null,
    text,
    ts: TS,
  };
}

describe("deriveChatDisplayName (design §3.9)", () => {
  test("returns null when no user record exists", () => {
    expect(deriveChatDisplayName([])).toBeNull();
    expect(deriveChatDisplayName([agentRecord("a stray agent record")])).toBeNull();
  });

  test("takes the first line of the first user record", () => {
    expect(deriveChatDisplayName([userRecord("Add a dark theme toggle")])).toBe(
      "Add a dark theme toggle",
    );
  });

  test("skips a leading system/agent record and finds the first user record", () => {
    const records = [
      systemErrorRecord("unrelated system noise"),
      agentRecord("unrelated agent noise"),
      userRecord("Redesign the dashboard layout"),
    ];
    expect(deriveChatDisplayName(records)).toBe("Redesign the dashboard layout");
  });

  test("wins with the FIRST user record when more than one exists", () => {
    const records = [userRecord("First request"), userRecord("Second request")];
    expect(deriveChatDisplayName(records)).toBe("First request");
  });

  test("takes only line 1 of a multi-line message", () => {
    expect(deriveChatDisplayName([userRecord("Line one\nLine two\nLine three")])).toBe("Line one");
  });

  test("trims surrounding whitespace on the first line", () => {
    expect(deriveChatDisplayName([userRecord("   padded text   \nrest")])).toBe("padded text");
  });

  test("truncates a first line longer than 60 characters", () => {
    const longLine = "x".repeat(75);
    const result = deriveChatDisplayName([userRecord(longLine)]);
    expect(result).toBe("x".repeat(60));
    expect(result?.length).toBe(60);
  });

  test("does not truncate a first line at exactly 60 characters", () => {
    const exactLine = "y".repeat(60);
    expect(deriveChatDisplayName([userRecord(exactLine)])).toBe(exactLine);
  });
});
