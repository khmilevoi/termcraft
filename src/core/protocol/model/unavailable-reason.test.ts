import { describe, expect, spyOn, test } from "bun:test"

import { uuidv7 } from "infrastructure/uuid"

import {
  REASON_CODES_V1,
  UNAVAILABLE_REASON_PRIORITY_V1,
  primaryReason,
  unavailableReasonV1Schema,
  type UnavailableReason,
} from "./unavailable-reason"

type ReasonCode = (typeof REASON_CODES_V1)[number]

describe("unavailableReasonV1Schema", () => {
  test("accepts a details-free reason", () => {
    expect(unavailableReasonV1Schema.safeParse({ code: "CAPABILITY_UNAVAILABLE" }).success).toBe(
      true,
    )
  })

  test("rejects a details-free reason carrying an unknown key such as a display message — branching happens on code alone, never message text", () => {
    expect(
      unavailableReasonV1Schema.safeParse({ code: "CAPABILITY_UNAVAILABLE", message: "nope" })
        .success,
    ).toBe(false)
  })

  test("accepts a turn-scoped reason with its bounded turnId detail", () => {
    expect(
      unavailableReasonV1Schema.safeParse({ code: "TURN_RUNNING", turnId: uuidv7() }).success,
    ).toBe(true)
  })

  test("rejects a turn-scoped reason missing its required turnId", () => {
    expect(unavailableReasonV1Schema.safeParse({ code: "TURN_RUNNING" }).success).toBe(false)
  })

  test("rejects a turn-scoped reason with a malformed turnId", () => {
    expect(
      unavailableReasonV1Schema.safeParse({ code: "TURN_RUNNING", turnId: "not-a-uuid" }).success,
    ).toBe(false)
  })

  test("accepts the git scope detail with its closed scope enum", () => {
    expect(
      unavailableReasonV1Schema.safeParse({ code: "GIT_SCOPE_CLEAN", scope: "whole-project" })
        .success,
    ).toBe(true)
  })

  test("rejects an unknown scope value", () => {
    expect(
      unavailableReasonV1Schema.safeParse({ code: "GIT_SCOPE_CLEAN", scope: "everything" })
        .success,
    ).toBe(false)
  })

  test("accepts the plan detail with plan family and plan id", () => {
    expect(
      unavailableReasonV1Schema.safeParse({
        code: "PLAN_STALE",
        planKind: "commit",
        planId: uuidv7(),
      }).success,
    ).toBe(true)
  })

  test("rejects a plan detail with an unknown plan family", () => {
    expect(
      unavailableReasonV1Schema.safeParse({
        code: "PLAN_NOT_FOUND",
        planKind: "backup",
        planId: uuidv7(),
      }).success,
    ).toBe(false)
  })

  test("accepts the page-slug detail", () => {
    expect(
      unavailableReasonV1Schema.safeParse({ code: "SOURCE_STAGED", pageSlug: "dashboard" })
        .success,
    ).toBe(true)
  })

  test("rejects an invalid page slug", () => {
    expect(
      unavailableReasonV1Schema.safeParse({ code: "SOURCE_STAGED", pageSlug: "NOPE" }).success,
    ).toBe(false)
  })

  test("accepts the required-revision detail as a canonical uint64 string", () => {
    expect(
      unavailableReasonV1Schema.safeParse({ code: "STALE_REVISION", requiredRevision: "7" })
        .success,
    ).toBe(true)
  })

  test("rejects a non-canonical required revision", () => {
    expect(
      unavailableReasonV1Schema.safeParse({ code: "STALE_REVISION", requiredRevision: "07" })
        .success,
    ).toBe(false)
  })

  test("rejects an unrecognized code entirely", () => {
    expect(unavailableReasonV1Schema.safeParse({ code: "NOT_A_REAL_CODE" }).success).toBe(false)
  })

  test("rejects a details-free code carrying an extra bounded-detail field meant for a different code", () => {
    expect(
      unavailableReasonV1Schema.safeParse({ code: "CAPABILITY_UNAVAILABLE", turnId: uuidv7() })
        .success,
    ).toBe(false)
  })
})

// §11.1's bounded, code-specific detail for every code that requires more than `code`
// itself, kept in table order. This is deliberately its own hand-transcription rather than
// a re-derivation from the schema module, so the test proves the schema against an
// independent source of "what a minimal valid reason looks like" for every one of the 31
// codes — the adversarial review found the suite previously only ever exercised 7 of them.
const MINIMAL_REASON_DETAILS_BY_CODE: Readonly<Record<ReasonCode, Readonly<Record<string, unknown>>>> = {
  UNSUPPORTED_PROTOCOL: {},
  INVALID_ENVELOPE: {},
  COMMAND_ID_REUSE_MISMATCH: {},
  COMMAND_ID_EXPIRED: {},
  COMMAND_DEDUPE_CAPACITY: {},
  STALE_REVISION: { requiredRevision: "7" },
  PROJECT_NOT_READY: {},
  PROJECT_UNTRUSTED: {},
  TURN_ALREADY_ACTIVE: { turnId: uuidv7() },
  TURN_RUNNING: { turnId: uuidv7() },
  TURN_NOT_ACTIVE: {},
  TURN_ID_MISMATCH: { turnId: uuidv7() },
  CANCEL_TOO_LATE: { turnId: uuidv7() },
  HISTORICAL_PREVIEW_READ_ONLY: {},
  GIT_UNAVAILABLE: {},
  NOT_GIT_REPOSITORY: {},
  GIT_SCOPE_CLEAN: { scope: "whole-project" },
  GIT_SEQUENCER_ACTIVE: {},
  SOURCE_STAGED: { pageSlug: "dashboard" },
  PLAN_NOT_FOUND: { planKind: "commit", planId: uuidv7() },
  PLAN_STALE: { planKind: "commit", planId: uuidv7() },
  CONFIRMATION_REQUIRED: {},
  NO_PAGES: {},
  OPERATION_BUSY: {},
  HOST_BACKPRESSURED: {},
  TOO_MANY_REQUESTS: {},
  FRAME_TOKEN_INVALID: {},
  FRAME_TOKEN_STALE: {},
  GEOMETRY_TOKEN_INVALID: {},
  GEOMETRY_TOKEN_STALE: {},
  CAPABILITY_UNAVAILABLE: {},
}

describe("unavailableReasonV1Schema — completeness across all 31 §11.1 codes", () => {
  test("accepts a minimal valid reason for every code, not just the ones exercised above", () => {
    for (const code of REASON_CODES_V1) {
      const candidate = { code, ...MINIMAL_REASON_DETAILS_BY_CODE[code] }
      const result = unavailableReasonV1Schema.safeParse(candidate)
      expect(result.success).toBe(true)
    }
  })

  test("the discriminated union carries exactly 31 options — one per §11.1 code, no fewer", () => {
    expect(unavailableReasonV1Schema.options.length).toBe(31)
  })
})

describe("UNAVAILABLE_REASON_PRIORITY_V1", () => {
  test("orders exactly the 31 §11.1 codes with no duplicates", () => {
    expect(UNAVAILABLE_REASON_PRIORITY_V1.length).toBe(31)
    expect(new Set(UNAVAILABLE_REASON_PRIORITY_V1).size).toBe(31)
  })
})

describe("primaryReason", () => {
  const turnRunning: UnavailableReason = { code: "TURN_RUNNING", turnId: uuidv7() }
  const gitScopeClean: UnavailableReason = { code: "GIT_SCOPE_CLEAN", scope: "whole-project" }
  const capabilityUnavailable: UnavailableReason = { code: "CAPABILITY_UNAVAILABLE" }

  test("picks the higher-priority reason regardless of input order", () => {
    expect(primaryReason([turnRunning, gitScopeClean]).code).toBe("TURN_RUNNING")
    expect(primaryReason([gitScopeClean, turnRunning]).code).toBe("TURN_RUNNING")
  })

  test("stays deterministic across every ordering of three reasons", () => {
    const permutations: readonly (readonly [
      UnavailableReason,
      UnavailableReason,
      UnavailableReason,
    ])[] = [
      [turnRunning, gitScopeClean, capabilityUnavailable],
      [capabilityUnavailable, gitScopeClean, turnRunning],
      [gitScopeClean, capabilityUnavailable, turnRunning],
      [capabilityUnavailable, turnRunning, gitScopeClean],
    ]
    for (const reasons of permutations) {
      expect(primaryReason(reasons).code).toBe("TURN_RUNNING")
    }
  })

  test("returns the sole reason when only one is given", () => {
    expect(primaryReason([capabilityUnavailable]).code).toBe("CAPABILITY_UNAVAILABLE")
  })

  test("an unranked code (unreachable via the public type, reached here only by bypassing it) still resolves and is logged rather than silently dropped", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    const unranked = { code: "NOT_A_REAL_CODE" } as unknown as UnavailableReason
    const result = primaryReason([unranked, capabilityUnavailable])
    expect(result.code).toBe("CAPABILITY_UNAVAILABLE")
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain("NOT_A_REAL_CODE")
    warnSpy.mockRestore()
  })

  test("branches purely on code — the chosen reason carries no message field to read", () => {
    const chosen = primaryReason([gitScopeClean, capabilityUnavailable])
    expect(chosen.code).toBe("GIT_SCOPE_CLEAN")
    expect(Object.keys(chosen).sort()).toEqual(["code", "scope"])
  })
})
