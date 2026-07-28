import { describe, expect, test } from "bun:test";

import { HANDSHAKE_TIMEOUT_MS, HANDSHAKE_TIMEOUT_REASON } from "./timeouts";

describe("handshake budget", () => {
  // The reason string is operator-facing: `supervisor.ts`'s `failureMessage: String(error.reason)`
  // flows through to `Workspace.tsx`'s `hostMessage={preview.finalFailure.safeMessage}`, rendered
  // verbatim by `HostUnavailablePanel`. It used to be a hand-written literal at two call sites,
  // both saying "3s". Deriving it is what stops the next change to the budget from shipping a
  // message that lies about it.
  test("the reason text is derived from the constant", () => {
    expect(HANDSHAKE_TIMEOUT_REASON).toBe(`no host.hello within ${HANDSHAKE_TIMEOUT_MS / 1_000}s`);
  });

  // The name states only what the assertion checks. It used to claim the budget "clears the
  // measured 2-3 s spawn-to-first-statement gap" — a number nobody had measured (see
  // `timeouts.ts`), pinned as fact by a test that never looked at a handshake at all. The real
  // measured wait is 464-1799 ms across 43 live handshakes, so 10 s is deliberate headroom.
  test("the budget stays at or above the 10 s floor", () => {
    expect(HANDSHAKE_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});
