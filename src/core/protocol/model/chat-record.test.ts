import { describe, expect, test } from "bun:test";

import { uuidv7 } from "infrastructure/uuid";

import { chatRecordDtoV1Schema } from "./chat-record";

const uid = () => uuidv7();
const TS = "2026-07-24T00:00:00.000Z";

describe("chatRecordDtoV1Schema", () => {
  const validUser = {
    kind: "user",
    recordId: uid(),
    turnId: uid(),
    text: "Add a dark theme toggle",
    selection: null,
    pins: [],
    ts: TS,
  };

  const validAgent = {
    kind: "agent",
    recordId: uid(),
    turnId: uid(),
    text: "Done — added a **theme** toggle.",
    changedPages: ["dashboard"],
    warnings: [],
    ts: TS,
  };

  const validSystemError = {
    kind: "system:error",
    recordId: uid(),
    turnId: uid(),
    actionId: null,
    outcome: "error",
    reason: null,
    text: "the agent backend failed",
    ts: TS,
  };

  const validSystemCancelled = {
    kind: "system:cancelled",
    recordId: uid(),
    turnId: null,
    actionId: uid(),
    text: "cancelled by the user",
    ts: TS,
  };

  const validSystemRestore = {
    kind: "system:restore",
    recordId: uid(),
    restoreActionId: uid(),
    pageSlug: "dashboard",
    sourceCommit: "a".repeat(40),
    ts: TS,
  };

  test("parses a valid sample of each of the five arms", () => {
    expect(chatRecordDtoV1Schema.safeParse(validUser).success).toBe(true);
    expect(chatRecordDtoV1Schema.safeParse(validAgent).success).toBe(true);
    expect(chatRecordDtoV1Schema.safeParse(validSystemError).success).toBe(true);
    expect(chatRecordDtoV1Schema.safeParse(validSystemCancelled).success).toBe(true);
    expect(chatRecordDtoV1Schema.safeParse(validSystemRestore).success).toBe(true);
  });

  test("rejects a kind outside the five closed members", () => {
    expect(chatRecordDtoV1Schema.safeParse({ ...validUser, kind: "system:info" }).success).toBe(
      false,
    );
  });

  test("rejects an unknown key on any arm (strict objects)", () => {
    expect(chatRecordDtoV1Schema.safeParse({ ...validUser, extra: "x" }).success).toBe(false);
    expect(chatRecordDtoV1Schema.safeParse({ ...validAgent, extra: "x" }).success).toBe(false);
    expect(chatRecordDtoV1Schema.safeParse({ ...validSystemError, extra: "x" }).success).toBe(
      false,
    );
    expect(chatRecordDtoV1Schema.safeParse({ ...validSystemCancelled, extra: "x" }).success).toBe(
      false,
    );
    expect(chatRecordDtoV1Schema.safeParse({ ...validSystemRestore, extra: "x" }).success).toBe(
      false,
    );
  });

  test("a user record parses regardless of its text's first line — name derivation is Task 4's concern, not this schema's", () => {
    expect(
      chatRecordDtoV1Schema.safeParse({ ...validUser, text: "\nsecond line only" }).success,
    ).toBe(true);
    expect(chatRecordDtoV1Schema.safeParse({ ...validUser, text: "" }).success).toBe(true);
  });

  test("accepts an explicit selection and non-empty pins on a user record", () => {
    const withSelectionAndPins = {
      ...validUser,
      selection: { pageSlug: "dashboard", element: "header" },
      pins: [uid()],
    };
    expect(chatRecordDtoV1Schema.safeParse(withSelectionAndPins).success).toBe(true);
  });

  test("requires explicit null turnId/actionId on system:error/system:cancelled, never omission", () => {
    const { turnId: _dropped, ...missingTurnId } = validSystemError;
    expect(chatRecordDtoV1Schema.safeParse(missingTurnId).success).toBe(false);
    const { actionId: _dropped2, ...missingActionId } = validSystemCancelled;
    expect(chatRecordDtoV1Schema.safeParse(missingActionId).success).toBe(false);
  });

  test("requires an explicit null reason on system:error when absent, never omission", () => {
    const { reason: _dropped, ...missingReason } = validSystemError;
    expect(chatRecordDtoV1Schema.safeParse(missingReason).success).toBe(false);
  });

  test("accepts every one of the three fixed system:error outcome codes", () => {
    for (const outcome of ["error", "stale", "interrupted"]) {
      expect(chatRecordDtoV1Schema.safeParse({ ...validSystemError, outcome }).success).toBe(true);
    }
  });

  test("rejects an outcome outside the closed set", () => {
    expect(
      chatRecordDtoV1Schema.safeParse({ ...validSystemError, outcome: "aborted" }).success,
    ).toBe(false);
  });

  describe("per-warning file/line (Task 11, design-agent-feedback-loop repair)", () => {
    test("accepts a warning carrying an explicit file/line", () => {
      const withLocatedWarning = {
        ...validAgent,
        warnings: [
          {
            kind: "nondeterministic-time",
            message: "`Date.now()` reads wall-clock time",
            file: "pages/stopwatch.tsx",
            line: 55,
          },
        ],
      };
      expect(chatRecordDtoV1Schema.safeParse(withLocatedWarning).success).toBe(true);
    });

    test("requires explicit null file/line on a warning, never omission — the DTO's own rule", () => {
      const omittedFileLine = {
        ...validAgent,
        warnings: [{ kind: "gate:orphan-import", message: "unused import" }],
      };
      expect(chatRecordDtoV1Schema.safeParse(omittedFileLine).success).toBe(false);

      const explicitNulls = {
        ...validAgent,
        warnings: [
          { kind: "gate:orphan-import", message: "unused import", file: null, line: null },
        ],
      };
      expect(chatRecordDtoV1Schema.safeParse(explicitNulls).success).toBe(true);
    });
  });
});
