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
  test("is true for the codes that mean the page itself is what failed", () => {
    expect(
      isDesignRenderFailure(
        circuitFailure({
          pageSlug: "dashboard",
          attempts: 4,
          hostFailureCode: "DESIGN_RENDER_FAILED",
        }),
      ),
    ).toBe(true);
    // A mount timeout means the handshake already succeeded — the child is proven alive — so
    // a hang that follows is the page's own module-init/render loop, not the host's (design §9.4).
    expect(
      isDesignRenderFailure(
        circuitFailure({ pageSlug: "dashboard", attempts: 4, hostFailureCode: "MOUNT_TIMEOUT" }),
      ),
    ).toBe(true);
  });

  test("is false for every failure the host hit before it ever ran the page", () => {
    for (const code of [
      "SPAWN_FAILED",
      "HANDSHAKE_TIMEOUT",
      "CHILD_EXITED",
      "TRANSPORT_ERROR",
      "HEARTBEAT_TIMEOUT",
      "RUNTIME_INTEGRITY_MISMATCH",
      "KIT_API_MISMATCH",
      "SOURCE_HASH_MISMATCH",
      "PROTOCOL_NEGOTIATION_FAILED",
      "HOST_CAPACITY",
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
