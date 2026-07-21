import { describe, expect, test } from "bun:test";

import { context } from "@reatom/core";

import { isUuidv7 } from "core/protocol";

import { MAX_TURN_ATTEMPTS, createTurnFence } from "./fence";

const TURN_ID = "0192f6f0-0000-7000-8000-00000000aaaa";

/** Narrows the `Error | TurnFence` union once, so each test reads as its own assertion. */
function openFence(turnId: string = TURN_ID) {
  const fence = createTurnFence(turnId);
  if (fence instanceof Error) throw fence;
  return fence;
}

describe("createTurnFence", () => {
  test("attempt 1 mints the first lease for the turn", () => {
    context.start(() => {
      const fence = openFence();
      const lease = fence.beginAttempt();
      if (lease instanceof Error) throw lease;

      expect(lease.turnId).toBe(TURN_ID);
      expect(lease.attempt).toBe(1);
      expect(fence.currentLease()).toEqual(lease);
    });
  });

  test("no lease exists before the first attempt starts", () => {
    // §7.2: "The first per-attempt lease nonce is minted only when attempt 1 starts."
    context.start(() => {
      expect(openFence().currentLease()).toBeNull();
    });
  });

  test("a retry keeps the turnId, increments attempt, and REPLACES the nonce", () => {
    // §12.2 item 4, verbatim: "A retry keeps `turnId`, increments `attempt`, and replaces
    // `leaseNonce`."
    context.start(() => {
      const fence = openFence();
      const first = fence.beginAttempt();
      if (first instanceof Error) throw first;
      const second = fence.beginAttempt();
      if (second instanceof Error) throw second;

      expect(second.turnId).toBe(first.turnId);
      expect(second.attempt).toBe(first.attempt + 1);
      expect(second.leaseNonce).not.toBe(first.leaseNonce);
    });
  });

  test("the nonce is a fresh 128-bit base64url value on every attempt", () => {
    // §12.2 item 2: "The nonce is a cryptographically random 128-bit value encoded
    // base64url." A predictable nonce would let a stale attempt's events be accepted.
    context.start(() => {
      const seen = new Set<string>();
      for (let i = 0; i < MAX_TURN_ATTEMPTS; i += 1) {
        const lease = openFence().beginAttempt();
        if (lease instanceof Error) throw lease;
        // base64url alphabet only, and 128 bits => 22 unpadded characters.
        expect(lease.leaseNonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
        seen.add(lease.leaseNonce);
      }
      expect(seen.size).toBe(MAX_TURN_ATTEMPTS);
    });
  });

  test("attempts are integers 1 through 4, and a fifth is refused", () => {
    // §7.2: "Attempts are integers 1 through 4."
    context.start(() => {
      const fence = openFence();
      for (let i = 1; i <= MAX_TURN_ATTEMPTS; i += 1) {
        const lease = fence.beginAttempt();
        if (lease instanceof Error) throw lease;
        expect(lease.attempt).toBe(i);
      }
      expect(fence.beginAttempt()).toBeInstanceOf(Error);
      // A refused attempt must not disturb the live lease.
      expect(fence.currentLease()?.attempt).toBe(MAX_TURN_ATTEMPTS);
    });
  });

  test("retirement clears the lease so no later signal can match", () => {
    // §12.2 item 5 + TD §6.4: the fence is retired before the candidate is frozen, so an
    // in-flight event arriving afterwards has nothing to match against.
    context.start(() => {
      const fence = openFence();
      const lease = fence.beginAttempt();
      if (lease instanceof Error) throw lease;

      fence.retire();

      expect(fence.currentLease()).toBeNull();
      expect(fence.accepts(lease)).toBe(false);
    });
  });

  describe("the §13.3 mismatch matrix — every one-field and multi-field mismatch", () => {
    const OTHER_TURN = "0192f6f0-0000-7000-8000-00000000bbbb";

    test("the exact live lease is accepted (control case)", () => {
      context.start(() => {
        const fence = openFence();
        const lease = fence.beginAttempt();
        if (lease instanceof Error) throw lease;
        expect(fence.accepts(lease)).toBe(true);
      });
    });

    test("all 7 non-empty subsets of {turnId, attempt, leaseNonce} are rejected", () => {
      context.start(() => {
        const fence = openFence();
        const live = fence.beginAttempt();
        if (live instanceof Error) throw live;

        const wrong = {
          turnId: OTHER_TURN,
          attempt: live.attempt + 1,
          leaseNonce: "AAAAAAAAAAAAAAAAAAAAAA",
        };

        // 1..7 as a bitmask over the three fields: every non-empty subset, none skipped.
        for (let mask = 1; mask <= 7; mask += 1) {
          const candidate = {
            turnId: (mask & 1) !== 0 ? wrong.turnId : live.turnId,
            attempt: (mask & 2) !== 0 ? wrong.attempt : live.attempt,
            leaseNonce: (mask & 4) !== 0 ? wrong.leaseNonce : live.leaseNonce,
          };
          expect(fence.accepts(candidate), `subset mask ${mask} must be rejected`).toBe(false);
        }
      });
    });

    test("an earlier attempt's lease is stale the instant the retry mints its own", () => {
      // §12.2 item 4: "An event from any earlier attempt is stale EVEN IF it arrives
      // before cancellation cleanup."
      context.start(() => {
        const fence = openFence();
        const first = fence.beginAttempt();
        if (first instanceof Error) throw first;
        expect(fence.accepts(first)).toBe(true);

        const second = fence.beginAttempt();
        if (second instanceof Error) throw second;

        expect(fence.accepts(first)).toBe(false);
        expect(fence.accepts(second)).toBe(true);
      });
    });

    test("the lease is read LIVE on every check, not captured once", () => {
      // A static matrix cannot tell a live read from a lease cached at construction — that
      // exact gap shipped in slice 6B's signal ingress. Bind the probe BEFORE any attempt
      // exists, then check it after two retries.
      context.start(() => {
        const fence = openFence();
        const probe = fence.probe; // captured while currentLease() is still null

        expect(probe.currentLease()).toBeNull();

        const first = fence.beginAttempt();
        if (first instanceof Error) throw first;
        expect(probe.currentLease()).toEqual(first);

        const second = fence.beginAttempt();
        if (second instanceof Error) throw second;
        expect(probe.currentLease()).toEqual(second);

        fence.retire();
        expect(probe.currentLease()).toBeNull();
      });
    });
  });

  test("the lease atom carries a hierarchical trace name", () => {
    context.start(() => {
      expect(openFence().leaseAtom.name).toBe("kernel.turn.lease");
    });
  });

  test("the turnId must be a canonical UUIDv7", () => {
    context.start(() => {
      expect(isUuidv7(TURN_ID)).toBe(true);
      expect(createTurnFence("not-a-uuid")).toBeInstanceOf(Error);
    });
  });
});
