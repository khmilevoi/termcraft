import { describe, expect, test } from "bun:test";

import {
  FAILURE_DETAILS_MAX_KEYS,
  FAILURE_DETAIL_KEY_MAX_LENGTH,
  FAILURE_DETAIL_STRING_VALUE_MAX_LENGTH,
  OPERATIONAL_FAILURE_CODES_V1,
  OPERATIONAL_FAILURE_CODE_COUNT,
  failureDtoV1Schema,
  isOperationalFailureCode,
  operationalFailureCodeSchema,
} from "./failure";

// Transcribed by hand from kernel-command-contract §11.2's "Code" column, table order,
// comma-separated cells expanded left-to-right one entry per code — independently of
// OPERATIONAL_FAILURE_CODES_V1 itself, so this test cannot pass by construction the way
// iterating the array under test always would. A misspelling such as `TURN_RUNNIG` (same
// length, wrong spelling) fails this `toEqual`, where a length-only or Set-based check
// would not. `DESIGN_SYSTEM_REJECTED`/`DESIGN_SYSTEM_TREE_CHANGED` are appended last and are NOT
// from §11.2's table — both are project-design-systems §8.3/§12's own codes (decisions D6, I2),
// added to this same closed registry rather than a second one (`core/protocol/model/failure.ts`'s
// own header explains why).
const OPERATIONAL_FAILURE_CODES_V1_PER_SPEC = [
  "BACKEND_UNAVAILABLE",
  "BACKEND_FAILED",
  "TURN_DEADLINE_EXCEEDED",
  "GATE_RETRY_EXHAUSTED",
  "APPLY_SOURCE_CHANGED",
  "APPLY_STALE",
  "STALE_BACKEND_EVENT_DROPPED",
  "TRANSACTION_RECOVERY_CONFLICT",
  "RESTORE_SOURCE_CHANGED",
  "RESTORE_OBJECT_MISSING",
  "RESTORE_GATE_FAILED",
  "RESTORE_RECORD_PENDING",
  "COMMIT_PLAN_STALE",
  "GIT_IDENTITY_MISSING",
  "GIT_HOOK_FAILED",
  "GIT_SIGNING_FAILED",
  "GIT_INDEX_BUSY",
  "GIT_COMMAND_FAILED",
  "EXPORT_SNAPSHOT_STALE",
  "EXPORT_RENDER_FAILED",
  "EXPORT_PUBLICATION_FAILED",
  "MIGRATION_BACKUP_FAILED",
  "MIGRATION_STALE",
  "MIGRATION_TRANSFORM_FAILED",
  "MIGRATION_PUBLICATION_FAILED",
  "HOST_START_FAILED",
  "HOST_PROTOCOL_FAILED",
  "HOST_CIRCUIT_OPEN",
  "PERSISTENCE_FAILED",
  "RESOURCE_LIMIT_EXCEEDED",
  "DESIGN_SYSTEM_REJECTED",
  "DESIGN_SYSTEM_TREE_CHANGED",
] as const;

describe("OPERATIONAL_FAILURE_CODES_V1", () => {
  test("has exactly the 30 codes kernel-command-contract §11.2 fixes, plus DESIGN_SYSTEM_REJECTED and DESIGN_SYSTEM_TREE_CHANGED", () => {
    expect(OPERATIONAL_FAILURE_CODES_V1.length).toBe(32);
    expect(OPERATIONAL_FAILURE_CODE_COUNT).toBe(32);
  });

  test("array length matches the exported count constant — the two cannot silently drift apart", () => {
    expect(OPERATIONAL_FAILURE_CODES_V1.length).toBe(OPERATIONAL_FAILURE_CODE_COUNT);
  });

  test("has no duplicate codes", () => {
    expect(new Set(OPERATIONAL_FAILURE_CODES_V1).size).toBe(OPERATIONAL_FAILURE_CODES_V1.length);
  });

  test("matches the §11.2 table verbatim (plus DESIGN_SYSTEM_REJECTED and DESIGN_SYSTEM_TREE_CHANGED appended last), spelling and order pinned", () => {
    expect(OPERATIONAL_FAILURE_CODES_V1).toEqual(OPERATIONAL_FAILURE_CODES_V1_PER_SPEC);
  });
});

describe("isOperationalFailureCode / operationalFailureCodeSchema", () => {
  test("accepts every listed code", () => {
    for (const code of OPERATIONAL_FAILURE_CODES_V1) {
      expect(isOperationalFailureCode(code)).toBe(true);
      expect(operationalFailureCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  test("rejects a code outside the closed set", () => {
    expect(isOperationalFailureCode("NETWORK_TIMEOUT")).toBe(false);
    expect(operationalFailureCodeSchema.safeParse("NETWORK_TIMEOUT").success).toBe(false);
  });
});

describe("failureDtoV1Schema", () => {
  const valid = {
    code: "BACKEND_FAILED",
    retryable: true,
    safeMessage: "the backend process exited before completing the turn",
    details: { exitCode: 1, signal: null, host: "local" },
  };

  test("accepts a well-formed failure with bounded primitive details", () => {
    expect(failureDtoV1Schema.safeParse(valid).success).toBe(true);
  });

  test("accepts an empty details record", () => {
    expect(failureDtoV1Schema.safeParse({ ...valid, details: {} }).success).toBe(true);
  });

  test("rejects an unknown top-level key", () => {
    expect(failureDtoV1Schema.safeParse({ ...valid, stack: "at foo()" }).success).toBe(false);
  });

  test("rejects a code outside the closed union", () => {
    expect(failureDtoV1Schema.safeParse({ ...valid, code: "UNKNOWN_CODE" }).success).toBe(false);
  });

  test("rejects a non-boolean retryable", () => {
    expect(failureDtoV1Schema.safeParse({ ...valid, retryable: "true" }).success).toBe(false);
  });

  test("rejects a nested object as a detail value", () => {
    expect(failureDtoV1Schema.safeParse({ ...valid, details: { nested: { a: 1 } } }).success).toBe(
      false,
    );
  });

  test("rejects a native Error instance as a detail value — no native error may ride along", () => {
    expect(
      failureDtoV1Schema.safeParse({ ...valid, details: { cause: new Error("boom") } }).success,
    ).toBe(false);
  });

  test("rejects an array as a detail value", () => {
    expect(failureDtoV1Schema.safeParse({ ...valid, details: { list: [1, 2, 3] } }).success).toBe(
      false,
    );
  });

  test("rejects more detail keys than the bounded limit", () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: FAILURE_DETAILS_MAX_KEYS + 1 }, (_, i) => [`k${i}`, i]),
    );
    expect(failureDtoV1Schema.safeParse({ ...valid, details: tooMany }).success).toBe(false);
  });

  test("accepts exactly the bounded key limit", () => {
    const atLimit = Object.fromEntries(
      Array.from({ length: FAILURE_DETAILS_MAX_KEYS }, (_, i) => [`k${i}`, i]),
    );
    expect(failureDtoV1Schema.safeParse({ ...valid, details: atLimit }).success).toBe(true);
  });

  test("accepts a detail key exactly at the bounded key-length limit, rejects one key longer", () => {
    const atLimit = "k".repeat(FAILURE_DETAIL_KEY_MAX_LENGTH);
    const overLimit = "k".repeat(FAILURE_DETAIL_KEY_MAX_LENGTH + 1);
    expect(failureDtoV1Schema.safeParse({ ...valid, details: { [atLimit]: 1 } }).success).toBe(
      true,
    );
    expect(failureDtoV1Schema.safeParse({ ...valid, details: { [overLimit]: 1 } }).success).toBe(
      false,
    );
  });

  test("accepts a string detail value exactly at the bounded value-length limit, rejects one character longer", () => {
    const atLimit = "v".repeat(FAILURE_DETAIL_STRING_VALUE_MAX_LENGTH);
    const overLimit = "v".repeat(FAILURE_DETAIL_STRING_VALUE_MAX_LENGTH + 1);
    expect(failureDtoV1Schema.safeParse({ ...valid, details: { note: atLimit } }).success).toBe(
      true,
    );
    expect(failureDtoV1Schema.safeParse({ ...valid, details: { note: overLimit } }).success).toBe(
      false,
    );
  });
});

describe("failureDtoV1Schema — §11.2's two typed-part codes", () => {
  test("APPLY_SOURCE_CHANGED accepts its own closed part vocabulary", () => {
    for (const part of ["page", "manifest"]) {
      const candidate = {
        code: "APPLY_SOURCE_CHANGED",
        retryable: true,
        safeMessage: "a page or manifest precondition drifted before apply",
        details: { part },
      };
      expect(failureDtoV1Schema.safeParse(candidate).success).toBe(true);
    }
  });

  test("APPLY_STALE accepts its own closed part vocabulary", () => {
    for (const part of ["chat", "pins"]) {
      const candidate = {
        code: "APPLY_STALE",
        retryable: true,
        safeMessage: "captured chat or pins drifted before apply",
        details: { part },
      };
      expect(failureDtoV1Schema.safeParse(candidate).success).toBe(true);
    }
  });

  test("rejects a part value outside the closed enum for either code", () => {
    expect(
      failureDtoV1Schema.safeParse({
        code: "APPLY_SOURCE_CHANGED",
        retryable: true,
        safeMessage: "x",
        details: { part: "banana" },
      }).success,
    ).toBe(false);
    expect(
      failureDtoV1Schema.safeParse({
        code: "APPLY_SOURCE_CHANGED",
        retryable: true,
        safeMessage: "x",
        details: { part: 42 },
      }).success,
    ).toBe(false);
    expect(
      failureDtoV1Schema.safeParse({
        code: "APPLY_STALE",
        retryable: true,
        safeMessage: "x",
        details: { part: "banana" },
      }).success,
    ).toBe(false);
  });

  test("rejects a missing part for either typed-part code", () => {
    expect(
      failureDtoV1Schema.safeParse({
        code: "APPLY_SOURCE_CHANGED",
        retryable: true,
        safeMessage: "x",
        details: {},
      }).success,
    ).toBe(false);
    expect(
      failureDtoV1Schema.safeParse({
        code: "APPLY_STALE",
        retryable: true,
        safeMessage: "x",
        details: {},
      }).success,
    ).toBe(false);
  });

  test("the two part vocabularies are not interchangeable — APPLY_STALE's part is invalid on APPLY_SOURCE_CHANGED and vice versa", () => {
    expect(
      failureDtoV1Schema.safeParse({
        code: "APPLY_SOURCE_CHANGED",
        retryable: true,
        safeMessage: "x",
        details: { part: "chat" },
      }).success,
    ).toBe(false);
    expect(
      failureDtoV1Schema.safeParse({
        code: "APPLY_STALE",
        retryable: true,
        safeMessage: "x",
        details: { part: "page" },
      }).success,
    ).toBe(false);
  });

  test("a code outside the two typed-part codes still accepts an unconstrained part value", () => {
    expect(
      failureDtoV1Schema.safeParse({
        code: "BACKEND_FAILED",
        retryable: true,
        safeMessage: "x",
        details: { part: "anything-goes-here" },
      }).success,
    ).toBe(true);
  });
});
