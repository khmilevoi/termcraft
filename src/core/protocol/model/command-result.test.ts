import { describe, expect, test } from "bun:test";

import { uuidv7 } from "infrastructure/uuid";

import {
  COMMAND_REJECTION_CODES_V1,
  COMMAND_REJECTION_CODE_COUNT,
  commandResultV1Schema,
  isCommandRejectionCode,
} from "./command-result";

// Transcribed by hand from kernel-command-contract §11.1's "Code" column, table order —
// independently of COMMAND_REJECTION_CODES_V1 itself (which re-exports unavailable-reason's
// REASON_CODES_V1), so this test cannot pass by construction the way iterating the array
// under test always would. A misspelling such as `TURN_RUNNIG` (same length, wrong
// spelling) fails this `toEqual`, where a length-only or Set-based check would not.
const COMMAND_REJECTION_CODES_V1_PER_SPEC = [
  "UNSUPPORTED_PROTOCOL",
  "INVALID_ENVELOPE",
  "COMMAND_ID_REUSE_MISMATCH",
  "COMMAND_ID_EXPIRED",
  "COMMAND_DEDUPE_CAPACITY",
  "STALE_REVISION",
  "PROJECT_NOT_READY",
  "PROJECT_UNTRUSTED",
  "TURN_ALREADY_ACTIVE",
  "TURN_RUNNING",
  "TURN_NOT_ACTIVE",
  "TURN_ID_MISMATCH",
  "CANCEL_TOO_LATE",
  "HISTORICAL_PREVIEW_READ_ONLY",
  "GIT_UNAVAILABLE",
  "NOT_GIT_REPOSITORY",
  "GIT_SCOPE_CLEAN",
  "GIT_SEQUENCER_ACTIVE",
  "SOURCE_STAGED",
  "PLAN_NOT_FOUND",
  "PLAN_STALE",
  "CONFIRMATION_REQUIRED",
  "NO_PAGES",
  "OPERATION_BUSY",
  "HOST_BACKPRESSURED",
  "TOO_MANY_REQUESTS",
  "FRAME_TOKEN_INVALID",
  "FRAME_TOKEN_STALE",
  "GEOMETRY_TOKEN_INVALID",
  "GEOMETRY_TOKEN_STALE",
  "CAPABILITY_UNAVAILABLE",
] as const;

describe("COMMAND_REJECTION_CODES_V1", () => {
  test("has exactly the 31 codes kernel-command-contract §11.1 fixes", () => {
    expect(COMMAND_REJECTION_CODES_V1.length).toBe(31);
    expect(COMMAND_REJECTION_CODE_COUNT).toBe(31);
  });

  test("array length matches the exported count constant — the two cannot silently drift apart", () => {
    expect(COMMAND_REJECTION_CODES_V1.length).toBe(COMMAND_REJECTION_CODE_COUNT);
  });

  test("has no duplicate codes", () => {
    expect(new Set(COMMAND_REJECTION_CODES_V1).size).toBe(COMMAND_REJECTION_CODES_V1.length);
  });

  test("matches the §11.1 table verbatim, spelling and order pinned", () => {
    expect(COMMAND_REJECTION_CODES_V1).toEqual(COMMAND_REJECTION_CODES_V1_PER_SPEC);
  });
});

describe("isCommandRejectionCode", () => {
  test("accepts every listed code and rejects an unknown one", () => {
    for (const code of COMMAND_REJECTION_CODES_V1) {
      expect(isCommandRejectionCode(code)).toBe(true);
    }
    expect(isCommandRejectionCode("NOT_A_CODE")).toBe(false);
  });
});

describe("commandResultV1Schema — accepted", () => {
  const valid = {
    protocolVersion: 1,
    commandId: uuidv7(),
    status: "accepted",
    acceptedRevision: "4",
    resultingRevision: "5",
    disposition: "started",
  };

  test("accepts each closed disposition without an operationId", () => {
    for (const disposition of ["completed", "started", "no-op"]) {
      expect(commandResultV1Schema.safeParse({ ...valid, disposition }).success).toBe(true);
    }
  });

  test("accepts the spec-optional operationId when present", () => {
    expect(commandResultV1Schema.safeParse({ ...valid, operationId: uuidv7() }).success).toBe(true);
  });

  test("rejects an unknown key", () => {
    expect(commandResultV1Schema.safeParse({ ...valid, note: "x" }).success).toBe(false);
  });

  test("rejects a wrong-type revision — not a canonical uint64 string", () => {
    expect(commandResultV1Schema.safeParse({ ...valid, acceptedRevision: 4 }).success).toBe(false);
  });

  test("rejects an unrecognized disposition", () => {
    expect(commandResultV1Schema.safeParse({ ...valid, disposition: "retried" }).success).toBe(
      false,
    );
  });

  test("rejects a protocolVersion other than 1", () => {
    expect(commandResultV1Schema.safeParse({ ...valid, protocolVersion: 2 }).success).toBe(false);
  });
});

describe("commandResultV1Schema — rejected", () => {
  const valid = {
    protocolVersion: 1,
    commandId: uuidv7(),
    status: "rejected",
    currentRevision: "9",
    code: "TURN_RUNNING",
    reasons: [{ code: "TURN_RUNNING", turnId: uuidv7() }],
  };

  test("accepts a rejection with a non-empty reasons array", () => {
    expect(commandResultV1Schema.safeParse(valid).success).toBe(true);
  });

  test("rejects an empty reasons array — RejectedCommandV1 always carries at least one", () => {
    expect(commandResultV1Schema.safeParse({ ...valid, reasons: [] }).success).toBe(false);
  });

  test("rejects a reasons entry that is not a valid UnavailableReason", () => {
    expect(
      commandResultV1Schema.safeParse({ ...valid, reasons: [{ code: "NOT_A_CODE" }] }).success,
    ).toBe(false);
  });

  test("rejects a code outside the closed rejection union", () => {
    expect(commandResultV1Schema.safeParse({ ...valid, code: "NOT_A_CODE" }).success).toBe(false);
  });

  test("rejects an unknown key", () => {
    expect(commandResultV1Schema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});

describe("commandResultV1Schema — discrimination", () => {
  test("rejects a status outside the closed accepted/rejected union", () => {
    expect(
      commandResultV1Schema.safeParse({
        protocolVersion: 1,
        commandId: uuidv7(),
        status: "pending",
      }).success,
    ).toBe(false);
  });

  test("rejects an accepted-only field carried on a rejected result", () => {
    const mixed = {
      protocolVersion: 1,
      commandId: uuidv7(),
      status: "rejected",
      currentRevision: "9",
      code: "TURN_RUNNING",
      reasons: [{ code: "TURN_RUNNING", turnId: uuidv7() }],
      disposition: "completed",
    };
    expect(commandResultV1Schema.safeParse(mixed).success).toBe(false);
  });
});
