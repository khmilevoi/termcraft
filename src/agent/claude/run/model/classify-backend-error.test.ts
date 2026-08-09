import { describe, expect, test } from "bun:test";

import type { SDKResultError } from "@anthropic-ai/claude-agent-sdk";

import { classifyBackendErrorCause } from "./classify-backend-error";

/**
 * A minimal `SDKResultError` fixture, shaped after spike 12's measured observations A/D
 * (`docs/spikes/12-resume-rejection/SPIKE.md`): `is_error: true`, `num_turns: 0`,
 * `duration_api_ms: 0`, `total_cost_usd: 0`, `modelUsage: {}`. `overrides` lets a test flip
 * exactly one structural field to prove it is load-bearing, matching `normalize.test.ts`'s own
 * fixture-plus-overrides convention for this same vendor type.
 */
function sdkErrorFor(errorText: string, overrides: Record<string, unknown> = {}): SDKResultError {
  return {
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 50,
    duration_api_ms: 0,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    errors: [errorText],
    uuid: "u1",
    session_id: "s1",
    ...overrides,
  } as unknown as SDKResultError;
}

describe("classifyBackendErrorCause", () => {
  test("the SDK's unknown-session error classifies as a resume rejection", () => {
    const msg = sdkErrorFor("No conversation found with session ID: abc");
    expect(classifyBackendErrorCause("resume", msg)).toBe("resume-rejected");
  });

  test("an unrelated backend error does NOT classify as a resume rejection", () => {
    for (const text of ["rate limit exceeded", "ECONNRESET", "invalid api key"]) {
      const msg = sdkErrorFor(text);
      expect(classifyBackendErrorCause("resume", msg)).toBeNull();
    }
  });

  test("a resume rejection is only ever classified on a run that ASKED for a resume", () => {
    // The guard that makes the classification safe: a fresh-session run cannot produce a
    // rejected resume, so a message-shaped false positive can never send the driver into a
    // pointless fallback — even when every OTHER structural field (is_error, num_turns, the
    // exact measured text) matches perfectly. This is what a design page's own string literal
    // cannot forge: the run itself has to have asked for a resume in the first place.
    const msg = sdkErrorFor("No conversation found with session ID: abc");
    expect(classifyBackendErrorCause("fresh", msg)).toBeNull();
  });

  test("is_error: false never classifies, even with matching text and num_turns: 0", () => {
    const msg = sdkErrorFor("No conversation found with session ID: abc", { is_error: false });
    expect(classifyBackendErrorCause("resume", msg)).toBeNull();
  });

  test("num_turns > 0 never classifies — the API WAS called, so this is not an unresolved resume", () => {
    const msg = sdkErrorFor("No conversation found with session ID: abc", { num_turns: 3 });
    expect(classifyBackendErrorCause("resume", msg)).toBeNull();
  });

  test("a malformed/missing errors[] is treated as no match rather than throwing", () => {
    const msg = sdkErrorFor("unused") as unknown as Record<string, unknown>;
    delete msg.errors;
    expect(classifyBackendErrorCause("resume", msg as unknown as SDKResultError)).toBeNull();
  });
});
