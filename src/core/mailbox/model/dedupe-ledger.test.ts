import { describe, expect, mock, test } from "bun:test";

import { context } from "@reatom/core";

import {
  type AcceptedCommandV1,
  CanonicalHashError,
  type CommandResultV1,
  type UUIDv7,
} from "core/protocol";
import type { Clock } from "infrastructure/clock";

import {
  DEDUPE_HORIZON_MS,
  DedupeRejectionError,
  createDedupeLedger,
  uuidv7TimestampMs,
} from "./dedupe-ledger";

/** An arbitrary fixed "now" so tests never depend on wall-clock time. */
const BASE_MS = 1_700_000_000_000;

/** A fake {@link Clock} whose reading is fully test-controlled — never `Date.now()`. */
function makeClock(initialMs: number): Clock {
  return { now: () => new Date(initialMs) };
}

/**
 * Builds a canonical-looking UUIDv7 embedding an exact millisecond timestamp in its
 * first 48 bits, so dedupe-floor tests can pin an id's age precisely. The random tail
 * is a monotonic counter so distinct calls never collide even at the same timestamp.
 */
let idTailCounter = 0;
function makeCommandId(tsMs: number): UUIDv7 {
  idTailCounter += 1;
  const tsHex = Math.trunc(tsMs).toString(16).padStart(12, "0");
  const tailHex = idTailCounter.toString(16).padStart(12, "0");
  return `${tsHex.slice(0, 8)}-${tsHex.slice(8, 12)}-7000-8000-${tailHex}`;
}

/** A minimal fixture envelope; `dedupe-ledger` only ever hashes it, never validates it. */
function makeEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    kind: "pin.create",
    expectedRevision: "0",
    payload: { pageSlug: "home", elementId: "btn-1", fx: 0.25, fy: 0.75 },
    ...overrides,
  };
}

function makeAccepted(commandId: UUIDv7, operationId: string): AcceptedCommandV1 {
  return {
    protocolVersion: 1,
    commandId,
    status: "accepted",
    acceptedRevision: "5",
    resultingRevision: "6",
    disposition: "started",
    operationId,
  };
}

describe("uuidv7TimestampMs", () => {
  test("extracts 0 from an id whose first 48 bits are all zero", () => {
    expect(uuidv7TimestampMs("00000000-0000-7000-8000-000000000000")).toBe(0);
  });

  test("extracts the RFC 9562 §5.7 worked example's timestamp", () => {
    // Independently computed from RFC 9562's own worked example UUID
    // "017F22E2-79B0-7CC3-98C4-DC0C0C07398F" -> 1645557742000 ms == 2022-02-22T19:22:22.000Z.
    // Not derived from this module's own encode/decode logic.
    expect(uuidv7TimestampMs("017f22e2-79b0-7cc3-98c4-dc0c0c07398f")).toBe(1_645_557_742_000);
  });
});

describe("createDedupeLedger — §8.5 exactly-once handling", () => {
  test("a first-seen commandId executes exactly once and returns execute's result", async () => {
    const clock = makeClock(BASE_MS);
    const ledger = context.start(() => createDedupeLedger({ clock, capacity: 10 }));
    const commandId = makeCommandId(BASE_MS - 1_000);
    const envelope = makeEnvelope();
    const expected = makeAccepted(commandId, "op-1");
    const execute = mock(async () => expected);

    const result = await ledger.run(envelope, commandId, execute);

    expect(result).toEqual(expected);
    expect(execute.mock.calls.length).toBe(1);
  });

  test("a concurrent duplicate shares the in-flight promise; execute runs exactly once", async () => {
    const clock = makeClock(BASE_MS);
    const ledger = context.start(() => createDedupeLedger({ clock, capacity: 10 }));
    const commandId = makeCommandId(BASE_MS - 1_000);
    const envelope = makeEnvelope();
    const expected = makeAccepted(commandId, "op-2");
    const { promise: execPromise, resolve } = Promise.withResolvers<CommandResultV1>();
    const execute = mock(() => execPromise);

    // Both calls issued before `execute` settles — the second must find the first's
    // in-flight promise already recorded rather than starting its own execution.
    const p1 = ledger.run(envelope, commandId, execute);
    const p2 = ledger.run(envelope, commandId, execute);
    resolve(expected);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(expected);
    expect(r2).toEqual(expected);
    expect(execute.mock.calls.length).toBe(1);
  });

  test("a completed duplicate returns the exact stored result, including operationId, without re-executing", async () => {
    const clock = makeClock(BASE_MS);
    const ledger = context.start(() => createDedupeLedger({ clock, capacity: 10 }));
    const commandId = makeCommandId(BASE_MS - 1_000);
    const envelope = makeEnvelope();
    const expected = makeAccepted(commandId, "op-3");
    const execute = mock(async () => expected);

    const first = await ledger.run(envelope, commandId, execute);
    const second = await ledger.run(envelope, commandId, execute);

    expect(second).toEqual(expected);
    expect(second).toEqual(first);
    expect(execute.mock.calls.length).toBe(1);
  });

  test("reusing commandId with a different envelope field returns COMMAND_ID_REUSE_MISMATCH and does not execute again", async () => {
    const clock = makeClock(BASE_MS);
    const ledger = context.start(() => createDedupeLedger({ clock, capacity: 10 }));
    const commandId = makeCommandId(BASE_MS - 1_000);
    const envelopeA = makeEnvelope({ expectedRevision: "0" });
    const envelopeB = makeEnvelope({ expectedRevision: "1" });
    const execute = mock(async () => makeAccepted(commandId, "op-4"));

    await ledger.run(envelopeA, commandId, execute);
    const rejection = await ledger.run(envelopeB, commandId, execute);

    if (!(rejection instanceof DedupeRejectionError))
      throw new Error("expected DedupeRejectionError");
    expect(rejection.code).toBe("COMMAND_ID_REUSE_MISMATCH");
    expect(execute.mock.calls.length).toBe(1);
  });

  test("a commandId older than the dedupe floor rejects COMMAND_ID_EXPIRED and never executes", async () => {
    const clock = makeClock(BASE_MS);
    const ledger = context.start(() =>
      createDedupeLedger({ clock, capacity: 10, horizonMs: DEDUPE_HORIZON_MS }),
    );
    const staleId = makeCommandId(BASE_MS - DEDUPE_HORIZON_MS - 1_000);
    const envelope = makeEnvelope();
    const execute = mock(async () => makeAccepted(staleId, "op-5"));

    const rejection = await ledger.run(envelope, staleId, execute);

    if (!(rejection instanceof DedupeRejectionError))
      throw new Error("expected DedupeRejectionError");
    expect(rejection.code).toBe("COMMAND_ID_EXPIRED");
    expect(execute.mock.calls.length).toBe(0);
  });

  test("an id exactly at the dedupe floor is not expired (only strictly-older ids are)", async () => {
    const clock = makeClock(BASE_MS);
    const ledger = context.start(() =>
      createDedupeLedger({ clock, capacity: 10, horizonMs: DEDUPE_HORIZON_MS }),
    );
    const floorId = makeCommandId(BASE_MS - DEDUPE_HORIZON_MS);
    const envelope = makeEnvelope();
    const expected = makeAccepted(floorId, "op-5b");
    const execute = mock(async () => expected);

    const result = await ledger.run(envelope, floorId, execute);
    expect(result).toEqual(expected);
    expect(execute.mock.calls.length).toBe(1);
  });

  test("at capacity, a new commandId rejects COMMAND_DEDUPE_CAPACITY while an existing one still resolves, and the existing entry is not evicted", async () => {
    const clock = makeClock(BASE_MS);
    const ledger = context.start(() => createDedupeLedger({ clock, capacity: 1 }));
    const firstId = makeCommandId(BASE_MS - 1_000);
    const envelope1 = makeEnvelope({ expectedRevision: "0" });
    const expected1 = makeAccepted(firstId, "op-6");
    const execute1 = mock(async () => expected1);

    const firstResult = await ledger.run(envelope1, firstId, execute1);
    expect(firstResult).toEqual(expected1);

    const secondId = makeCommandId(BASE_MS - 500);
    const envelope2 = makeEnvelope({ expectedRevision: "1" });
    const execute2 = mock(async () => makeAccepted(secondId, "op-7"));

    const rejection = await ledger.run(envelope2, secondId, execute2);
    if (!(rejection instanceof DedupeRejectionError))
      throw new Error("expected DedupeRejectionError");
    expect(rejection.code).toBe("COMMAND_DEDUPE_CAPACITY");
    expect(execute2.mock.calls.length).toBe(0);

    // Crucial per §8.5: capacity pressure must not evict the still-in-horizon first entry —
    // the ledger refuses new work rather than dropping an old result.
    const stillThere = await ledger.run(envelope1, firstId, execute1);
    expect(stillThere).toEqual(expected1);
    expect(execute1.mock.calls.length).toBe(1);
  });

  test("an envelope that cannot be canonicalized returns the hash error instead of silently proceeding", async () => {
    const clock = makeClock(BASE_MS);
    const ledger = context.start(() => createDedupeLedger({ clock, capacity: 10 }));
    const commandId = makeCommandId(BASE_MS - 1_000);
    const execute = mock(async () => makeAccepted(commandId, "op-8"));

    const result = await ledger.run({ bad: undefined }, commandId, execute);

    expect(result).toBeInstanceOf(CanonicalHashError);
    expect(execute.mock.calls.length).toBe(0);
  });

  // --- Regression tests for the review's Critical/Important findings -----------------

  test("exactly-once survives a change of Reatom context frame", async () => {
    // The ledger's state must NOT live in an atom: context.start() opens an ISOLATED
    // context, so a duplicate arriving in a different frame would miss the entry and
    // execute a second time — destroying the one guarantee §8.5 exists to provide.
    const clock = makeClock(BASE_MS);
    const ledger = createDedupeLedger({ clock, capacity: 10 });
    const commandId = makeCommandId(BASE_MS - 1_000);
    const envelope = makeEnvelope({ commandId });
    const execute = mock(async () => makeAccepted(commandId, "op-frames"));

    const first = await context.start(() => ledger.run(envelope, commandId, execute));
    const second = await context.start(() => ledger.run(envelope, commandId, execute));

    expect(execute.mock.calls.length).toBe(1);
    expect(second).toEqual(first);
  });

  test("a full ledger accepts a fresh command once its entries fall past the horizon", async () => {
    // §8.5 forbids evicting entries BEFORE the horizon — not after. Without the sweep the
    // ledger deadlocks for the life of the process once it fills.
    let nowMs = BASE_MS;
    const clock: Clock = { now: () => new Date(nowMs) };
    const ledger = createDedupeLedger({ clock, capacity: 1 });

    const oldId = makeCommandId(BASE_MS - 1_000);
    await ledger.run(
      makeEnvelope({ commandId: oldId }),
      oldId,
      mock(async () => makeAccepted(oldId, "op-old")),
    );
    expect(ledger.size()).toBe(1);

    // Move well past the horizon so the stored entry could only ever answer EXPIRED now.
    nowMs = BASE_MS + DEDUPE_HORIZON_MS * 3;
    const freshId = makeCommandId(nowMs - 1_000);
    const freshExecute = mock(async () => makeAccepted(freshId, "op-fresh"));
    const result = await ledger.run(makeEnvelope({ commandId: freshId }), freshId, freshExecute);

    expect(result).not.toBeInstanceOf(DedupeRejectionError);
    expect(freshExecute.mock.calls.length).toBe(1);
  });

  test("a malformed commandId comes back as a value, never a synchronous throw", async () => {
    // UUIDv7 is a plain string alias, so nothing at the type level stops this; parsing it
    // with BigInt() would throw a SyntaxError straight out of `run`, past its declared
    // Error | T return.
    const ledger = createDedupeLedger({ clock: makeClock(BASE_MS), capacity: 10 });
    const bogus = "not-a-uuid" as UUIDv7;
    const execute = mock(async () => makeAccepted(bogus, "op-bogus"));

    const result = await ledger.run(makeEnvelope({ commandId: bogus }), bogus, execute);

    expect(result).toBeInstanceOf(DedupeRejectionError);
    expect(execute.mock.calls.length).toBe(0);
  });

  test("a synchronously throwing execute rejects the returned promise instead of throwing out of run", async () => {
    const ledger = createDedupeLedger({ clock: makeClock(BASE_MS), capacity: 10 });
    const commandId = makeCommandId(BASE_MS - 1_000);
    const execute = () => {
      throw new Error("guard exploded synchronously");
    };

    // The call itself must not throw — a caller cannot .catch() what has no promise yet.
    const pending = ledger.run(makeEnvelope({ commandId }), commandId, execute);
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toThrow("guard exploded synchronously");
  });

  test("execute is recorded before it runs, so a re-entrant duplicate does not start a second execution", async () => {
    const ledger = createDedupeLedger({ clock: makeClock(BASE_MS), capacity: 10 });
    const commandId = makeCommandId(BASE_MS - 1_000);
    const envelope = makeEnvelope({ commandId });
    let innerCalls = 0;

    const innerExecute = mock(async () => makeAccepted(commandId, "op-inner"));
    const execute = mock(async () => {
      // Re-enter with the same id while the first execution is still in flight. The
      // returned promise is deliberately NOT awaited: it is the outer call's own promise,
      // so awaiting it here would self-deadlock. What matters is that the ledger already
      // holds the entry, so the inner call resolves from it and never starts a second
      // execution. Recording after calling execute would let innerExecute run.
      innerCalls += 1;
      void ledger.run(envelope, commandId, innerExecute);
      return makeAccepted(commandId, "op-outer");
    });

    await ledger.run(envelope, commandId, execute);

    expect(innerCalls).toBe(1);
    expect(execute.mock.calls.length).toBe(1);
    expect(innerExecute.mock.calls.length).toBe(0);
  });
});
