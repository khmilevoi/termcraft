import { describe, expect, test } from "bun:test";

import type { FailureDtoV1 } from "core/protocol";

import { isDesignRenderFailure } from "./failure-class";

function circuitFailure(details: FailureDtoV1["details"]): FailureDtoV1 {
  return {
    code: "HOST_CIRCUIT_OPEN",
    retryable: true,
    safeMessage: "whatever the host said",
    details,
  };
}

describe("isDesignRenderFailure", () => {
  test("is true only for the code that means the page itself threw", () => {
    expect(
      isDesignRenderFailure(
        circuitFailure({
          pageSlug: "dashboard",
          attempts: 4,
          hostFailureCode: "DESIGN_RENDER_FAILED",
        }),
      ),
    ).toBe(true);
  });

  test("is false for every failure the host hit before it ever ran the page", () => {
    for (const code of [
      "SPAWN_FAILED",
      "HANDSHAKE_TIMEOUT",
      "MOUNT_TIMEOUT",
      "CHILD_EXITED",
      "TRANSPORT_ERROR",
      "HEARTBEAT_TIMEOUT",
      "RUNTIME_INTEGRITY_MISMATCH",
      "KIT_API_MISMATCH",
      "SOURCE_HASH_MISMATCH",
      "PROTOCOL_NEGOTIATION_FAILED",
    ]) {
      expect(
        isDesignRenderFailure(
          circuitFailure({ pageSlug: "dashboard", attempts: 1, hostFailureCode: code }),
        ),
      ).toBe(false);
    }
  });

  test("is false when no code was carried — absent is not evidence the page failed", () => {
    expect(isDesignRenderFailure(circuitFailure({ pageSlug: "dashboard", attempts: 4 }))).toBe(
      false,
    );
  });
});
