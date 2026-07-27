import { describe, expect, test } from "bun:test";

import { HANDSHAKE_TIMEOUT_MS, HANDSHAKE_TIMEOUT_REASON } from "./timeouts";

describe("handshake budget", () => {
  // The reason string is operator-facing (it reaches the UI through
  // `ui/preview/model/host-failure-phrase.ts`) and used to be a hand-written literal at two
  // call sites, both saying "3s". Deriving it is what stops the next change to the budget from
  // shipping a message that lies about it.
  test("the reason text is derived from the constant", () => {
    expect(HANDSHAKE_TIMEOUT_REASON).toBe(`no host.hello within ${HANDSHAKE_TIMEOUT_MS / 1_000}s`);
  });

  test("the budget clears the measured 2-3 s spawn-to-first-statement gap", () => {
    expect(HANDSHAKE_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});
