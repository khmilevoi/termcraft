import { describe, expect, mock, test } from "bun:test";

import { context } from "@reatom/core";

import { createKernelCounters } from "core/kernel/model/counters";
import {
  type CanonicalHashError,
  CommandDecodeError,
  type CommandKindV1,
  type CommandResultV1,
  type EventPayloadByKindV1,
  type UnavailableReason,
} from "core/protocol";
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

import type { GuardDecision, GuardTarget, HandlerOutcome, KernelStateSnapshot } from "../types";
import { createDedupeLedger } from "./dedupe-ledger";
import { type Dispatch, type DispatchDeps, createDispatch } from "./dispatch";
import { type EventEnvelopeV1, createEventBus } from "./event-bus";
import type { ActiveTurnCancelState, TurnCancelProbe } from "./revision-guard";

/** An arbitrary fixed "now" so dedupe expiry never depends on wall-clock time. */
const BASE_MS = 1_700_000_000_000;

function makeClock(initialMs: number): Clock {
  return { now: () => new Date(initialMs) };
}

/**
 * A minimal valid `kernel.snapshot` payload the event bus needs to construct. Every
 * model sits at its machine's real initial phase (§7.1-§7.7's `initial`, transcribed
 * in each `reatom*StateMachine` factory).
 */
function fakeSnapshotPayload(): Omit<EventPayloadByKindV1["kernel.snapshot"], "eventSeq"> {
  return {
    models: {
      project: { phase: "closed", trust: null },
      turn: { phase: "idle", activeTurnId: null, commitIntentRecorded: false },
      restore: { phase: "idle" },
      commit: { phase: "idle" },
      export: { phase: "idle" },
      preview: { phase: "disabled", sourceKind: null },
      migration: { phase: "idle" },
    },
    projectId: null,
    activePageSlug: null,
    activeChatId: null,
    trust: null,
    capabilities: [],
    pageDescriptors: [],
    gitStatus: { repositoryId: "repo", head: null, sequencerState: "none", scopes: {} },
    agentIdentity: null,
  };
}

/** `selection.clear`'s payload is the exact empty object (§8.2) — the simplest kind for
 * pipeline-shape tests that do not care about payload content. */
function makeRawCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    commandId: uuidv7(),
    expectedRevision: "0",
    kind: "selection.clear",
    payload: {},
    ...overrides,
  };
}

function noAvailableTarget(): GuardTarget {
  return null;
}

function alwaysAvailableGuard(): GuardDecision {
  return { available: true };
}

function fakeCancelProbe(active: ActiveTurnCancelState | null = null): TurnCancelProbe {
  return { activeTurn: () => active };
}

function reason(code: UnavailableReason["code"]): UnavailableReason {
  // Every code this suite uses is a details-free reason; cast narrows the literal.
  return { code } as UnavailableReason;
}

/**
 * Builds a full `DispatchDeps` AND `createDispatch(deps)` inside ONE `context.start(...)`
 * frame — matching the shape `createDispatch`'s own comment requires ("there is exactly
 * one Kernel Reatom context for this mailbox's whole process lifetime"). Building
 * `counters`/`dedupeLedger`/`eventBus` in a DIFFERENT frame than `createDispatch` (or in
 * none at all) would hide exactly the bug this shape exists to catch: every atom this
 * suite touches lives ONLY in the frame captured here, and every call below reaches
 * `dispatch()` from OUTSIDE this function, after `context.start(...)` has already
 * returned — so the whole suite only passes if `dispatch.ts`'s `wrap` calls actually do
 * their job.
 */
function setup(overrides: Partial<DispatchDeps> = {}): {
  deps: DispatchDeps;
  dispatch: Dispatch["dispatch"];
} {
  return context.start(() => {
    const counters = createKernelCounters();
    const dedupeLedger = createDedupeLedger({ clock: makeClock(BASE_MS), capacity: 100 });
    const eventBus = createEventBus({ counters, buildSnapshotPayload: fakeSnapshotPayload });
    const deps: DispatchDeps = {
      counters,
      dedupeLedger,
      eventBus,
      cancelProbe: fakeCancelProbe(),
      readKernelState: (): KernelStateSnapshot => null,
      extractTarget: noAvailableTarget,
      evaluateGuard: alwaysAvailableGuard,
      handle: () => ({ disposition: "completed", events: [] }),
      ...overrides,
    };
    return { deps, dispatch: createDispatch(deps).dispatch };
  });
}

type DispatchResult = CanonicalHashError | CommandDecodeError | CommandResultV1;

function expectAccepted(
  result: DispatchResult,
): asserts result is Extract<CommandResultV1, { status: "accepted" }> {
  if (result instanceof Error) throw result;
  if (result.status !== "accepted")
    throw new Error(`expected accepted, got ${JSON.stringify(result)}`);
}

function expectRejected(
  result: DispatchResult,
): asserts result is Extract<CommandResultV1, { status: "rejected" }> {
  if (result instanceof Error) throw result;
  if (result.status !== "rejected")
    throw new Error(`expected rejected, got ${JSON.stringify(result)}`);
}

/**
 * Proves the CURRENT revision is `expected` by dispatching a fresh probe command at
 * that `expectedRevision` and requiring it to be accepted — rather than reading
 * `deps.counters.stateRevision()` directly. A direct read is unreliable across this
 * test file's `context.start(...)` boundary (atom state is per-frame, see
 * `dispatch.ts`'s `wrap` comment); `dispatch()`'s own public contract already threads
 * every call through the correct frame, so routing the check back through `dispatch()`
 * itself is both safer and closer to what a real caller can actually observe.
 */
async function expectRevisionIs(
  dispatch: (raw: unknown) => Promise<DispatchResult>,
  expected: string,
): Promise<void> {
  const probe = await dispatch(makeRawCommand({ expectedRevision: expected }));
  expectAccepted(probe);
}

describe("createDispatch — §12.1 step 2: decode before dedupe", () => {
  test("an unsupported protocol version is rejected as a CommandDecodeError, not a CommandResultV1", async () => {
    const { deps, dispatch } = setup();

    const result = await dispatch(makeRawCommand({ protocolVersion: 2 }));

    expect(result).toBeInstanceOf(CommandDecodeError);
    if (!(result instanceof CommandDecodeError)) return;
    expect(result.code).toBe("UNSUPPORTED_PROTOCOL");
    expect(deps.dedupeLedger.size()).toBe(0);
  });

  test("a malformed envelope never poisons the dedupe ledger for its commandId", async () => {
    // §8.5 keys dedupe on SUBMITTED commands; a decode failure was never one. A client
    // that fixes its bug and resubmits the SAME commandId with a valid envelope must be
    // treated as first-seen, not COMMAND_ID_REUSE_MISMATCH.
    const handle = mock((): HandlerOutcome => ({ disposition: "completed", events: [] }));
    const { dispatch } = setup({ handle });
    const commandId = uuidv7();

    const badResult = await dispatch(
      makeRawCommand({ commandId, kind: "selection.clear", payload: { bogus: true } }),
    );
    expect(badResult).toBeInstanceOf(CommandDecodeError);

    const goodResult = await dispatch(
      makeRawCommand({ commandId, kind: "selection.clear", payload: {} }),
    );
    expectAccepted(goodResult);
    expect(handle.mock.calls.length).toBe(1);
  });
});

describe("createDispatch — §8.4 revision check runs before the guard", () => {
  test("a stale expectedRevision rejects with STALE_REVISION and never calls the guard or handler", async () => {
    const evaluateGuard = mock((): GuardDecision => {
      throw new Error("guard must not run when the revision check already rejected");
    });
    const handle = mock((): HandlerOutcome => ({ disposition: "completed", events: [] }));
    const { dispatch } = setup({ evaluateGuard, handle });

    const result = await dispatch(makeRawCommand({ expectedRevision: "9" }));

    expectRejected(result);
    expect(result.code).toBe("STALE_REVISION");
    expect(result.currentRevision).toBe("0");
    expect(result.reasons).toEqual([{ code: "STALE_REVISION", requiredRevision: "0" }]);
    expect(evaluateGuard.mock.calls.length).toBe(0);
    expect(handle.mock.calls.length).toBe(0);
  });

  test("turn.cancel while already stopping is an accepted no-op: no revision change, no publish, no handler call", async () => {
    const turnId = uuidv7();
    const handle = mock((): HandlerOutcome => ({ disposition: "completed", events: [] }));
    const { deps, dispatch } = setup({
      cancelProbe: fakeCancelProbe({ turnId, phase: "stopping", durableIntentRecorded: false }),
      handle,
    });
    const received: EventEnvelopeV1[] = [];
    const unsub = deps.eventBus.subscribe((e) => received.push(e));
    if (unsub instanceof Error) throw unsub;

    const result = await dispatch(
      makeRawCommand({ kind: "turn.cancel", expectedRevision: "0", payload: { turnId } }),
    );

    expectAccepted(result);
    expect(result.disposition).toBe("no-op");
    expect(result.acceptedRevision).toBe("0");
    expect(result.resultingRevision).toBe("0");
    expect(handle.mock.calls.length).toBe(0);
    await expectRevisionIs(dispatch, "0");
    expect(received).toHaveLength(1); // only the subscribe-time snapshot
  });
});

describe("createDispatch — §12.1 step 3: guard failure rejects without a model transition", () => {
  test("an unavailable guard decision rejects with its primary reason's code and never calls the handler", async () => {
    const handle = mock((): HandlerOutcome => ({ disposition: "completed", events: [] }));
    const { dispatch } = setup({
      evaluateGuard: () => ({ available: false, reasons: [reason("PROJECT_NOT_READY")] }),
      handle,
    });

    const result = await dispatch(makeRawCommand());

    expectRejected(result);
    expect(result.code).toBe("PROJECT_NOT_READY");
    expect(result.reasons).toEqual([{ code: "PROJECT_NOT_READY" }]);
    // The guard always rejects here, so a follow-up probe can't distinguish revision —
    // `handle` never running is itself the proof nothing advanced it (only
    // `applyTransition`, gated on `handle`, ever calls `counters.advanceRevision()`).
    expect(handle.mock.calls.length).toBe(0);
  });

  test("the guard's primary reason is selected by §10.1's stable priority table, not array order", async () => {
    const { dispatch } = setup({
      // TURN_RUNNING (tier 3) outranks HOST_BACKPRESSURED (tier 8) — listed here in the
      // OPPOSITE order to prove selection is priority-driven, not first-in-array.
      evaluateGuard: () => ({
        available: false,
        reasons: [
          { code: "HOST_BACKPRESSURED" } as UnavailableReason,
          { code: "TURN_RUNNING", turnId: uuidv7() } as UnavailableReason,
        ],
      }),
    });

    const result = await dispatch(makeRawCommand());

    expectRejected(result);
    expect(result.code).toBe("TURN_RUNNING");
  });

  test("extractTarget and evaluateGuard receive the decoded kind/payload and the injected state", async () => {
    const state: KernelStateSnapshot = { marker: "current-state" };
    const sentinelTarget: GuardTarget = { marker: "extracted-target" };
    const extractTarget = mock((_kind: CommandKindV1, _payload: unknown) => sentinelTarget);
    const evaluateGuard = mock(
      (_kind: CommandKindV1, _target: GuardTarget, _state: KernelStateSnapshot): GuardDecision => ({
        available: true,
      }),
    );
    const { dispatch } = setup({ readKernelState: () => state, extractTarget, evaluateGuard });

    await dispatch(makeRawCommand({ kind: "selection.clear", payload: {} }));

    expect(extractTarget.mock.calls[0]).toEqual(["selection.clear" as CommandKindV1, {}]);
    expect(evaluateGuard.mock.calls[0]).toEqual([
      "selection.clear" as CommandKindV1,
      sentinelTarget,
      state,
    ]);
  });
});

describe("createDispatch — §12.1 steps 4-6: transition, revision, and publication", () => {
  test("an accepted transition calls the handler once, advances the revision by exactly one, and publishes its events", async () => {
    const operationId = uuidv7();
    const handle = mock(
      (): HandlerOutcome => ({
        disposition: "started",
        events: [{ kind: "selection.changed", payload: null }],
        operationId,
      }),
    );
    const { deps, dispatch } = setup({ handle });
    const received: EventEnvelopeV1[] = [];
    const unsub = deps.eventBus.subscribe((e) => received.push(e));
    if (unsub instanceof Error) throw unsub;

    const result = await dispatch(makeRawCommand());

    expectAccepted(result);
    expect(result.disposition).toBe("started");
    expect(result.operationId).toBe(operationId);
    expect(result.acceptedRevision).toBe("0");
    expect(result.resultingRevision).toBe("1");
    expect(handle.mock.calls.length).toBe(1);
    // snapshot + one selection.changed event, both at the new revision
    expect(received).toHaveLength(2);
    expect(received[1]?.kind).toBe("selection.changed");
    expect(received[1]?.stateRevision).toBe("1");
  });

  test("an accepted no-op from the handler does not advance the revision or publish anything", async () => {
    const { deps, dispatch } = setup({ handle: () => ({ disposition: "no-op", events: [] }) });
    const received: EventEnvelopeV1[] = [];
    const unsub = deps.eventBus.subscribe((e) => received.push(e));
    if (unsub instanceof Error) throw unsub;

    const result = await dispatch(makeRawCommand());

    expectAccepted(result);
    expect(result.disposition).toBe("no-op");
    expect(result.resultingRevision).toBe("0");
    await expectRevisionIs(dispatch, "0");
    expect(received).toHaveLength(1); // only the subscribe-time snapshot
  });

  test("a no-op handler outcome carrying events logs a warning and still discards them", async () => {
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const { dispatch } = setup({
        handle: () => ({
          disposition: "no-op",
          events: [{ kind: "selection.changed", payload: null }],
        }),
      });

      const result = await dispatch(makeRawCommand());

      expectAccepted(result);
      expect(result.disposition).toBe("no-op");
      expect(warnings.length).toBe(1);
      await expectRevisionIs(dispatch, "0");
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("createDispatch — wrap re-enters the frame captured at construction (§6)", () => {
  test("two independently constructed pipelines do not cross-contaminate state when interleaved", async () => {
    // Reatom's `context.start(...)` opens an ISOLATED frame (`dedupe-ledger.ts`'s own
    // comment: "atom state is per-frame"). Each `setup()` call below builds its OWN
    // `counters`/`dispatch` inside its OWN frame, then returns — popping back to
    // whatever frame is ambient OUTSIDE any `context.start(...)`. Pipeline B is built
    // WHILE pipeline A's first `dispatch()` call is still in flight (its `execute`
    // microtask has not run yet), so if `dispatch.ts` did not `wrap` its deferred
    // continuation to A's OWN construction-time frame, that continuation would instead
    // run against whatever frame happens to be ambient by the time it fires — which, by
    // then, could easily be B's, not A's.
    const pipelineA = setup();
    const pendingA = pipelineA.dispatch(makeRawCommand({ expectedRevision: "0" }));

    const pipelineB = setup();
    const resultB = await pipelineB.dispatch(makeRawCommand({ expectedRevision: "0" }));
    const resultA = await pendingA;

    expectAccepted(resultA);
    expectAccepted(resultB);
    expect(resultA.resultingRevision).toBe("1");
    expect(resultB.resultingRevision).toBe("1");

    // The decisive check: each pipeline's OWN revision must have advanced independently
    // FROM "0" — a follow-up command on EACH pipeline at `expectedRevision: "1"` must be
    // accepted. If A's write had leaked into B's frame (or vice versa), one pipeline's
    // counter would have been bumped twice and the other never bumped at all, and one of
    // these two follow-ups would come back `STALE_REVISION` instead.
    const followUpA = await pipelineA.dispatch(makeRawCommand({ expectedRevision: "1" }));
    const followUpB = await pipelineB.dispatch(makeRawCommand({ expectedRevision: "1" }));
    expectAccepted(followUpA);
    expectAccepted(followUpB);
  });
});

describe("createDispatch — §8.5 dedupe: exactly-once end to end", () => {
  test("the same commandId and envelope in flight concurrently calls the handler exactly once", async () => {
    const handle = mock((): HandlerOutcome => ({ disposition: "completed", events: [] }));
    const { dispatch } = setup({ handle });
    const raw = makeRawCommand();

    const [r1, r2] = await Promise.all([dispatch(raw), dispatch(raw)]);

    expectAccepted(r1);
    expectAccepted(r2);
    expect(r1).toEqual(r2);
    expect(handle.mock.calls.length).toBe(1);
  });

  test("reusing a commandId with a different envelope rejects COMMAND_ID_REUSE_MISMATCH without re-running the handler", async () => {
    const handle = mock((): HandlerOutcome => ({ disposition: "completed", events: [] }));
    const { dispatch } = setup({ handle });
    const commandId = uuidv7();

    const first = await dispatch(makeRawCommand({ commandId, expectedRevision: "0" }));
    expectAccepted(first);

    const second = await dispatch(makeRawCommand({ commandId, expectedRevision: "1" }));

    expectRejected(second);
    expect(second.code).toBe("COMMAND_ID_REUSE_MISMATCH");
    // The first dispatch already accepted (disposition "completed"), so the CURRENT
    // revision is "1" by the time the mismatched duplicate is rejected — proving
    // `toDedupeRejection` reads a live, correctly-framed revision rather than a stale one.
    expect(second.currentRevision).toBe("1");
    expect(handle.mock.calls.length).toBe(1);
  });

  // --- Regression tests for the review's findings ------------------------------------

  test("a guard rejection neither advances the revision nor publishes a domain event", async () => {
    // §4: "Rejections ... do not increment it". §9: "A rejected command emits no domain
    // event." Asserting only that `handle` was not called is reasoning about the current
    // code, not a check — it survives adding an advanceRevision() to the rejection branch.
    let open = false;
    const { deps, dispatch } = setup({
      evaluateGuard: (): GuardDecision =>
        open ? { available: true } : { available: false, reasons: [reason("PROJECT_NOT_READY")] },
    });
    const received: unknown[] = [];
    const sub = deps.eventBus.subscribe(() => received.push(1));
    if (sub instanceof Error) throw sub;

    const rejectedResult = await dispatch(makeRawCommand({ expectedRevision: "0" }));
    expectRejected(rejectedResult);
    expect(received).toHaveLength(1); // the initial snapshot only — no domain event

    // If the rejection had advanced the revision, "0" would now be stale and this would
    // reject with STALE_REVISION instead of being accepted at revision 0.
    open = true;
    const acceptedResult = await dispatch(makeRawCommand({ expectedRevision: "0" }));
    expectAccepted(acceptedResult);
    expect(acceptedResult.resultingRevision).toBe("1");
  });

  test("a stale-revision rejection neither advances the revision nor publishes a domain event", async () => {
    const { deps, dispatch } = setup();
    const received: unknown[] = [];
    const sub = deps.eventBus.subscribe(() => received.push(1));
    if (sub instanceof Error) throw sub;

    const stale = await dispatch(makeRawCommand({ expectedRevision: "7" }));
    expectRejected(stale);
    expect(stale.code).toBe("STALE_REVISION");
    expect(received).toHaveLength(1);

    const fresh = await dispatch(makeRawCommand({ expectedRevision: "0" }));
    expectAccepted(fresh);
    expect(fresh.resultingRevision).toBe("1");
  });

  test("a stale-revision rejection reports the live current revision, not a hardcoded zero", async () => {
    const { dispatch } = setup();
    const first = await dispatch(makeRawCommand({ expectedRevision: "0" }));
    expectAccepted(first);

    const stale = await dispatch(makeRawCommand({ expectedRevision: "0" }));
    expectRejected(stale);
    expect(stale.currentRevision).toBe("1");
    expect(stale.reasons).toEqual([{ code: "STALE_REVISION", requiredRevision: "1" }]);
  });

  test("a throwing handler returns a value and does not poison the commandId forever", async () => {
    // dedupe-ledger records the in-flight promise BEFORE execution, so a rejected promise
    // would stay recorded and every later retry of the same id would inherit the failure.
    let broken = true;
    const { dispatch } = setup({
      handle: () => {
        if (broken) throw new Error("6C handler exploded");
        return { disposition: "completed", events: [] };
      },
    });

    const raw = makeRawCommand({ expectedRevision: "0" });
    const failure = await dispatch(raw);
    expectRejected(failure);

    // A NEW commandId after the handler is fixed must work — and so must the pipeline.
    broken = false;
    const recovered = await dispatch(
      makeRawCommand({ expectedRevision: "0", commandId: uuidv7() }),
    );
    expectAccepted(recovered);
  });

  test("readKernelState is read fresh on every command, never cached across commands", async () => {
    const states: KernelStateSnapshot[] = [];
    let current: KernelStateSnapshot = null;
    const { dispatch } = setup({
      readKernelState: () => current,
      evaluateGuard: (_kind, _target, state): GuardDecision => {
        states.push(state);
        return { available: true };
      },
    });

    await dispatch(makeRawCommand({ expectedRevision: "0" }));
    current = { marker: "second" } as unknown as KernelStateSnapshot;
    await dispatch(makeRawCommand({ expectedRevision: "1", commandId: uuidv7() }));

    expect(states).toHaveLength(2);
    expect(states[1]).not.toBe(states[0]);
  });
});
