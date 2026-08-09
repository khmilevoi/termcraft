import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import { reatomTurnStateMachine } from "core/machines";
import type {
  AgentRunOutcome,
  AgentTask,
  ChatReader,
  GateRunResultV1,
  StagedTurnReadSetV1,
} from "core/ports";
import {
  type FakeAgentBackend,
  type FakeGateRunner,
  type FakeSessionCheckpointService,
  type FakeStagingService,
  type FakeTurnTransactionService,
  createFakeAgentBackend,
  createFakeGateRunner,
  createFakePinStore,
  createFakeSessionCheckpointService,
  createFakeStagingService,
  createFakeTurnTransactionService,
} from "core/ports/fakes";
import type { FailureDtoV1 } from "core/protocol";
import { type PageSlug, parsePageSlug } from "entities/page";
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

import type { AdmissionInputV1 } from "../types";
import { type TurnDeadlineCheckV1, type TurnDeadlines, createTurnDeadlines } from "./deadlines";
import { type TurnGateFoldInputV1, foldGateDiagnosticsIntoPrompt } from "./prompt";
import { type RunTurnDeps, type RunTurnInputV1, runTurn } from "./run-turn";

/**
 * `runTurn` end to end against 6D's fakes only, matching `admission.test.ts`'s/
 * `attempt.test.ts`'s own harness style — no real process, no real disk, no real clock.
 *
 * DRIVING A MULTI-AWAIT COMPOSITION: unlike the six leaf files' own tests, `runTurn` awaits
 * several fakes in sequence before it ever calls `AgentBackend.startTurn`. `waitForStartCount`
 * drains the microtask queue (the same `await wrap(Bun.sleep(0))` idiom `attempt.test.ts`
 * already uses to let a fake's call-log push land) until the Nth attempt has actually begun,
 * then the test completes that exact attempt's run before the next `waitForStartCount` call.
 */

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const PAGE_HOME = slug("home");
const T0 = 1_700_000_000_000;

function manualClock(startMs: number): Clock {
  return { now: () => new Date(startMs) };
}

/**
 * A `TurnDeadlines` fake that reports a scripted sequence of `check()` results by call
 * order — the last entry repeats once the queue is exhausted. Only the hardening tests
 * below use this; every other test keeps the default `createTurnDeadlines` + `manualClock`
 * pairing `harness()` already builds. `noteEvent`/`noteAttemptStarted`/`noteSessionFallback`
 * are no-ops: these tests drive `check()`'s return value directly rather than through
 * elapsed clock time.
 */
function scriptedDeadlines(sequence: readonly TurnDeadlineCheckV1[]): TurnDeadlines {
  let index = 0;
  function check(): TurnDeadlineCheckV1 {
    const result = sequence[index] ?? sequence[sequence.length - 1];
    index++;
    return result ?? { kind: "ok" };
  }
  return {
    noteEvent: () => {},
    noteAttemptStarted: () => {},
    noteSessionFallback: () => {},
    check,
    absoluteDeadlineAt: () => T0 + 30 * 60 * 1000,
  };
}

/** `chat` is deliberately absent — see `admission.test.ts`'s identical `baseReadSet()` header. */
function baseReadSet(): Omit<StagedTurnReadSetV1, "chat"> {
  return {
    manifest: { sha256: "a".repeat(64), size: 10 },
    designFiles: [
      { relPath: "screens/landing.tsx", snapshot: { sha256: "b".repeat(64), size: 20 } },
    ],
    pins: [],
  };
}

/** A minimal `Pick<ChatReader, "readAppendBase">` double — matches `admission.test.ts`'s identical helper (duplicated per this ring's own "each fake/double gets its own tiny copy" convention). */
function fakeChatAppendBaseReader(): Pick<ChatReader, "readAppendBase"> {
  return { readAppendBase: async () => ({ length: 42, prefixSha256: "f".repeat(64) }) };
}

/**
 * Minted once per test run via `baseAdmission()` — `AdmissionInputV1.turnId` is now the
 * CALLER's job (fix-bundle spec §1.2, `../types.ts`'s own header), never `runAdmission`'s.
 * `harness()` below is the "caller" this file stands in for: it applies `beginAdmission`
 * itself before `runTurn`/`runAdmission` is ever invoked, matching what
 * `core/kernel/model/handlers/turn.ts`'s `beginTurn` now always does in production.
 */
const TURN_ID = uuidv7();

function baseAdmission(): AdmissionInputV1 {
  return {
    turnId: TURN_ID,
    targetChatId: "chat-1",
    text: "please add a page",
    candidatePins: [],
    workspace: {
      // `pages.json` is a real staged tree file now (plan Task 7) — `freezeTurnCandidate`
      // reads it back via `StagingService.readCandidateFile` to populate `manifestText`.
      // CORRECTED (task-13 review round 2, Minor M-a): staging one here is no longer
      // required to avoid a failure — an UNLISTED manifest is now an honest empty
      // `manifestText` (`candidate.ts`'s own "AN ABSENT design/pages.json IS AN HONEST
      // ABSENCE" header), never a 404. It stays staged anyway so these fixtures exercise the
      // ordinary "manifest present" path `staging.calls` below asserts a `readCandidateFile`
      // call for, matching a real turn.
      treeFiles: [
        { relPath: "pages.json", sourcePath: "/fake/pages.json" },
        { relPath: "screens/landing.tsx", sourcePath: "/fake/landing.tsx" },
      ],
      runtimeDocs: [],
      readSet: baseReadSet(),
    },
  };
}

function baseTask(): Omit<AgentTask, "fence"> {
  return {
    workspacePath: "/unset", // always overridden by runTurn from the minted workspace root
    systemPrompt: "system",
    userMessage: "please add a page",
    model: "fake-model",
    effort: "medium",
    session: { kind: "fresh", seed: [] },
  };
}

const PASSING_PAGE_RESULT: GateRunResultV1 = {
  ok: true,
  errors: [],
  warnings: [],
  descriptor: {
    slug: PAGE_HOME,
    meta: { kitApiVersion: 1, title: "Home", minSize: { w: 80, h: 24 }, theme: "default" },
  },
};

const FAILING_PAGE_RESULT: GateRunResultV1 = {
  ok: false,
  errors: [{ kind: "type", code: "TS2322", message: "type error" }],
  warnings: [],
  descriptor: null,
};

function baseRunTurnInput(): RunTurnInputV1 {
  return {
    admission: baseAdmission(),
    baseTask: baseTask(),
    // WHOLE-TREE material (task 14). The fake `GateRunner`'s `runManifestSlice` returns an
    // honest-empty slice unless a test queues one, so no `runPage` call fires from this
    // default — which is correct: which pages exist is now decided by decoding the
    // manifest, and an empty/undecodable manifest legitimately names none.
    buildValidationInput: () => ({
      manifestText: "[]",
      treePaths: ["screens/landing.tsx"],
      treeInventory: [{ relPath: "screens/landing.tsx", sha256: "0".repeat(64) }],
      // A first turn's own send-time read set (design §8 step 8): nothing to diff against, so
      // every page this driver's fixtures reach smokes — the behaviour these tests already had.
      sendTimeInventory: { files: [] },
      files: new Map([["screens/landing.tsx", "export default function Home() {}"]]),
      designRoot: "/fake-candidate/design",
    }),
    buildFinalizeInput: ({ turnId, attempt }) => ({
      changedFiles: [
        {
          relPath: "screens/landing.tsx",
          change: "replace",
          newBytes: new TextEncoder().encode("v2"),
        },
      ],
      changedPageSlugs: [PAGE_HOME],
      agentRecord: {
        kind: "agent",
        recordId: "0192f6f0-0000-7000-8000-00000000cccc",
        turnId,
        text: attempt.finalText,
        changedPages: [PAGE_HOME],
        warnings: [],
        ts: "2024-06-01T12:00:00.000Z",
      },
      sentPins: [],
    }),
  };
}

interface Harness {
  readonly deps: RunTurnDeps;
  readonly turnTransactions: FakeTurnTransactionService;
  readonly staging: FakeStagingService;
  readonly agentBackend: FakeAgentBackend;
  readonly gateRunner: FakeGateRunner;
  readonly sessionCheckpoint: FakeSessionCheckpointService;
  readonly startedTasks: readonly (Omit<AgentTask, "fence"> & { readonly fence: unknown })[];
  readonly foldCalls: readonly TurnGateFoldInputV1[];
}

/**
 * Fresh fakes + a fresh turn machine per test — never shared across tests (matching every
 * sibling harness in this directory). `deadlines` defaults to the real `createTurnDeadlines`
 * bound to `clock`; the hardening tests below override it with `scriptedDeadlines` to drive
 * `check()` directly instead of through elapsed clock time. `sessionCheckpoint` defaults to an
 * empty fake — only `RunTurnDeps.sessionCheckpoint`'s own consumer, `fallbackToFreshSession`
 * (design-agent-feedback-loop repair, Task 9), ever reads it; every test that does not classify
 * a resume rejection never touches it at all.
 */
function harness(
  clock: Clock = manualClock(T0),
  deadlines: TurnDeadlines = createTurnDeadlines({ clock }),
  sessionCheckpoint: FakeSessionCheckpointService = createFakeSessionCheckpointService(),
): Harness {
  const machine = reatomTurnStateMachine();
  // `runTurn` (`run-turn.ts`) calls `runAdmission` directly and applies no transition of its
  // own — the caller (`core/kernel/model/handlers/turn.ts`'s `beginTurn`, in production) is
  // the one that moves `idle -> admitting` before `runTurn` is ever invoked (fix-bundle spec
  // §1.2). This harness stands in for that caller so every test below still reaches a legal
  // `finishAdmission`, matching `baseAdmission()`'s own `TURN_ID` above.
  const began = machine.apply("beginAdmission");
  if (began.kind !== "changed") {
    throw new Error(`test setup: beginAdmission was not a real transition (${began.kind})`);
  }
  const pinReader = createFakePinStore();
  const turnTransactions = createFakeTurnTransactionService();
  const staging = createFakeStagingService();
  const agentBackend = createFakeAgentBackend();
  const gateRunner = createFakeGateRunner();
  // ONE manifest entry, always — `runTurnValidation` decides which pages to run `runPage`
  // against by decoding the candidate's `design/pages.json`, and this fake's honest-empty
  // default slice names none. Without this every Gate-outcome test below would run ZERO pages
  // and pass vacuously. Wrapped rather than replaced so the call still reaches the fake's own
  // `calls` log, which several tests assert the ordering of. The entry is
  // `screens/landing.tsx`, matching `buildValidationInput`'s own `files` map and deliberately
  // NOT derivable from the slug.
  const originalRunManifestSlice = gateRunner.runManifestSlice.bind(gateRunner);
  gateRunner.runManifestSlice = async (input) => {
    const result = await originalRunManifestSlice(input);
    return {
      errors: result.errors,
      slice: { pages: [{ slug: PAGE_HOME, entry: "screens/landing.tsx" }], active: null },
    };
  };
  const published: unknown[] = [];

  // Traces the exact task each attempt started with (the fake's own call log only records
  // the fence, per `agent-backend.ts`'s header — this is the only way to observe the
  // folded retry prompt actually reaching the backend), matching `finalize.test.ts`'s own
  // wrap-and-delegate tracing idiom for a fake it does not otherwise instrument.
  const startedTasks: (Omit<AgentTask, "fence"> & { readonly fence: unknown })[] = [];
  const originalStartTurn = agentBackend.startTurn.bind(agentBackend);
  agentBackend.startTurn = (task) => {
    startedTasks.push(task);
    return originalStartTurn(task);
  };

  const foldCalls: TurnGateFoldInputV1[] = [];
  const foldSpy: typeof foldGateDiagnosticsIntoPrompt = (foldInput) => {
    foldCalls.push(foldInput);
    return foldGateDiagnosticsIntoPrompt(foldInput);
  };

  const deps: RunTurnDeps = {
    machine,
    clock,
    pinReader,
    turnTransactions,
    chatReader: fakeChatAppendBaseReader(),
    staging,
    agentBackend,
    gateRunner,
    deadlines,
    sessionCheckpoint,
    publish: (event) => published.push(event),
    foldGateDiagnosticsIntoPrompt: foldSpy,
  };

  return {
    deps,
    turnTransactions,
    staging,
    agentBackend,
    gateRunner,
    sessionCheckpoint,
    startedTasks,
    foldCalls,
  };
}

/** Drains the microtask queue until the Nth `startTurn` call has landed — see this file's header. */
async function waitForStartCount(h: Harness, count: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (h.agentBackend.calls.filter((c) => c.method === "startTurn").length >= count) return;
    await wrap(Bun.sleep(0));
  }
  throw new Error(`waitForStartCount: never observed ${count} startTurn call(s)`);
}

/** Completes exactly the Nth attempt's run with `outcome`. */
function completeAttempt(h: Harness, count: number, outcome: AgentRunOutcome): void {
  const startCalls = h.agentBackend.calls.filter((c) => c.method === "startTurn");
  const call = startCalls[count - 1];
  if (call?.method !== "startTurn") throw new Error(`expected startTurn call #${count}`);
  h.agentBackend.completeRun(call.fence, outcome);
}

const completedOutcome = (n: number): AgentRunOutcome => ({
  kind: "completed",
  finalText: `done-${n}`,
  usage: null,
  sessionId: `s${n}`,
});

describe("runTurn — admission -> attempt/freeze/validate retry loop -> finalize/terminalize", () => {
  test("(a) happy path: admit -> attempt -> freeze -> validate-pass -> finalize -> committed", async () => {
    await context.start(async () => {
      const h = harness();
      // Captures the exact root `finalizeTurn` itself retires on a committed exit (review
      // finding #1) — `buildFinalizeInput` receives the same frozen `TurnCandidateV1` the
      // driver's own `candidate.root` retires by, so this is the ground truth to compare
      // the retire call's own `root` against, not a hand-rederived fake-path literal.
      let capturedCandidateRoot: string | null = null;
      const base = baseRunTurnInput();
      const runInput: RunTurnInputV1 = {
        ...base,
        buildFinalizeInput: (args) => {
          capturedCandidateRoot = args.candidate.root;
          return base.buildFinalizeInput(args);
        },
      };
      const runPromise = wrap(runTurn(h.deps, runInput));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1));

      const result = await wrap(runPromise);

      if (result.kind !== "finalized")
        throw new Error(`expected finalized, got ${JSON.stringify(result)}`);
      expect(result.result.kind).toBe("committed");
      expect(h.turnTransactions.calls.map((c) => c.method)).toEqual(["admit", "finalize"]);
      // `finalizeTurn` retires its own frozen candidate unconditionally on a committed exit
      // (`finalize.ts`'s own "CANDIDATE RETIREMENT" header) — the sequence below is not
      // driven by `run-turn.ts`'s own `terminalize()` helper at all on this happy path.
      // `readCandidateFile` is `freezeTurnCandidate`'s own manifest-text read (`candidate.ts`'s
      // header, "manifestText IS the one deliberate exception").
      expect(h.staging.calls.map((c) => c.method)).toEqual([
        "createTurnWorkspace",
        "snapshotToCandidate",
        "readCandidateFile",
        "retireCandidate",
      ]);
      const retireCall = h.staging.calls.find((c) => c.method === "retireCandidate");
      if (retireCall?.method !== "retireCandidate")
        throw new Error("expected a retireCandidate call");
      if (capturedCandidateRoot === null)
        throw new Error("expected buildFinalizeInput to have captured a candidate root");
      expect(retireCall.root).toBe(capturedCandidateRoot);
      expect(h.gateRunner.calls.map((c) => c.method)).toEqual([
        "runManifestSlice",
        "runTree",
        "runPage",
      ]);
      expect(h.startedTasks.length).toBe(1);
      expect(h.startedTasks[0]?.workspacePath).not.toBe("/unset");
    });
  });

  test("(b) one gate retry then pass: prompt fold observed, second attempt passes", async () => {
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT);
      h.gateRunner.queueRunPageResult(PASSING_PAGE_RESULT);
      const runPromise = wrap(runTurn(h.deps, baseRunTurnInput()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1));

      await waitForStartCount(h, 2);
      completeAttempt(h, 2, completedOutcome(2));

      const result = await wrap(runPromise);

      if (result.kind !== "finalized")
        throw new Error(`expected finalized, got ${JSON.stringify(result)}`);
      expect(result.result.kind).toBe("committed");

      // The fold ran exactly once, for exactly the attempt-1-rejected -> attempt-2 edge.
      expect(h.foldCalls.length).toBe(1);
      expect(h.foldCalls[0]?.rejectedAttempt).toBe(1);
      expect(h.foldCalls[0]?.nextAttempt).toBe(2);
      expect(h.foldCalls[0]?.diagnostics.errors).toEqual([
        {
          kind: "type",
          code: "TS2322",
          message: "type error",
          file: null,
          line: null,
          column: null,
          blockedPages: null,
        },
      ]);

      // The folded diagnostics reach the second attempt as a RESUME of the first attempt's
      // own session (task 8) — `userMessage` reverts to the user's own original text, and the
      // fold rides `session.promptDelta` instead. Never both, never neither: see run-turn.ts's
      // `session` doc comment and the dedicated "Gate retry resumes..." describe block below
      // for the invariant pinned across every branch.
      expect(h.startedTasks.length).toBe(2);
      expect(h.startedTasks[0]?.userMessage).toBe("please add a page");
      expect(h.startedTasks[0]?.session).toEqual({ kind: "fresh", seed: [] });
      expect(h.startedTasks[1]?.userMessage).toBe("please add a page");
      const secondSession = h.startedTasks[1]?.session;
      if (secondSession?.kind !== "resume") throw new Error("expected a resume session plan");
      expect(secondSession.sessionId).toBe("s1");
      expect(secondSession.promptDelta).toContain("Gate rejected the previous attempt");
      expect(secondSession.promptDelta).toContain("TS2322");

      // Two FULL validation passes: manifest slice + whole-tree import scan + one page,
      // twice. The import scan is per-ATTEMPT, not per-turn: a retry restages and refreezes,
      // so the tree it must vouch for is a different tree.
      expect(h.gateRunner.calls.map((c) => c.method)).toEqual([
        "runManifestSlice",
        "runTree",
        "runPage",
        "runManifestSlice",
        "runTree",
        "runPage",
      ]);
    });
  });

  test("(c) exhaustion after 4 failed validations: terminalizeTurn with GATE_RETRY_EXHAUSTED", async () => {
    await context.start(async () => {
      const h = harness();
      for (let i = 0; i < 4; i++) h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT);
      const runPromise = wrap(runTurn(h.deps, baseRunTurnInput()));

      for (let attempt = 1; attempt <= 4; attempt++) {
        await waitForStartCount(h, attempt);
        completeAttempt(h, attempt, completedOutcome(attempt));
      }

      const result = await wrap(runPromise);

      if (result.kind !== "terminalized")
        throw new Error(`expected terminalized, got ${JSON.stringify(result)}`);
      expect(result.result.kind).toBe("recorded");
      expect(h.startedTasks.length).toBe(4);
      expect(h.foldCalls.length).toBe(3); // one fold per retry: 1->2, 2->3, 3->4; none after 4

      const terminalizeCall = h.turnTransactions.calls.find((c) => c.method === "terminalize");
      if (terminalizeCall?.method !== "terminalize") throw new Error("expected a terminalize call");
      if (terminalizeCall.input.record.kind !== "system:error") {
        throw new Error(`expected system:error, got ${terminalizeCall.input.record.kind}`);
      }
      expect(terminalizeCall.input.record.outcome).toBe("error");
      expect(terminalizeCall.input.record.reason).toBe("GATE_RETRY_EXHAUSTED");

      // No finalize was ever attempted — the candidate never passed Gate.
      expect(h.turnTransactions.calls.map((c) => c.method)).toEqual(["admit", "terminalize"]);
    });
  });

  test("(c2) a cancel that lands DURING Gate validation records a cancel — never 'the turn's commit landed durably'", async () => {
    await context.start(async () => {
      const h = harness();
      // The race, reproduced exactly and at the exact moment it happens in production: the cancel
      // lands WHILE the Gate is running, so it is driven from inside `runPage` itself.
      // `requestCancel` is legal from `validating` (`turn-machine.ts`'s own table) and
      // `runTurnValidation` never consults the machine — so validation keeps going and returns
      // "passed" against a machine that has already left. `finalizeTurn`'s `beginFinalization` is
      // then illegal and it returns BEFORE `turnTransactions.finalize` is ever called.
      const cancelApplied: string[] = [];
      const originalRunPage = h.gateRunner.runPage.bind(h.gateRunner);
      h.gateRunner.runPage = async (input) => {
        if (cancelApplied.length === 0) {
          cancelApplied.push(h.deps.machine.apply("requestCancel").kind);
        }
        return originalRunPage(input);
      };

      const runPromise = wrap(runTurn(h.deps, baseRunTurnInput()));
      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1));

      const result = await wrap(runPromise);
      expect(cancelApplied).toEqual(["changed"]); // the fixture really did cancel mid-validation

      if (result.kind !== "terminalized")
        throw new Error(`expected terminalized, got ${JSON.stringify(result)}`);
      // Nothing was written: `finalize` never ran, only the admission and the terminal record.
      expect(h.turnTransactions.calls.map((c) => c.method)).toEqual(["admit", "terminalize"]);

      const terminalizeCall = h.turnTransactions.calls.find((c) => c.method === "terminalize");
      if (terminalizeCall?.method !== "terminalize") throw new Error("expected a terminalize call");
      // THE DEFECT: this record is written verbatim into the user's chat. It used to read "the
      // turn's commit landed durably, but the turn machine could not settle onto it" — told to a
      // user who had just pressed Esc, about an edit that was never saved.
      expect(terminalizeCall.input.record.kind).toBe("system:cancelled");
      expect(JSON.stringify(terminalizeCall.input.record)).not.toContain("landed durably");
    });
  });

  test("(d) mid-attempt cancellation: terminalizeTurn with cancelled", async () => {
    await context.start(async () => {
      const h = harness();
      const runPromise = wrap(runTurn(h.deps, baseRunTurnInput()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, { kind: "cancelled", exitConfirmed: true });

      const result = await wrap(runPromise);

      if (result.kind !== "terminalized")
        throw new Error(`expected terminalized, got ${JSON.stringify(result)}`);
      expect(result.result.kind).toBe("recorded");

      const terminalizeCall = h.turnTransactions.calls.find((c) => c.method === "terminalize");
      if (terminalizeCall?.method !== "terminalize") throw new Error("expected a terminalize call");
      expect(terminalizeCall.input.record.kind).toBe("system:cancelled");

      // Never reached freeze/validation/finalize — only admission's own workspace creation ran.
      expect(h.staging.calls.map((c) => c.method)).toEqual(["createTurnWorkspace"]);
      expect(h.gateRunner.calls).toEqual([]);
      expect(h.turnTransactions.calls.map((c) => c.method)).toEqual(["admit", "terminalize"]);
    });
  });

  test("(e) attempt completes past the absolute deadline: terminalizes before freeze/validate", async () => {
    // Pins the finding-1 hardening: without the post-attempt-outcome recheck this attempt
    // would freeze the candidate and run it fully through Gate before `finalizeTurn`'s own
    // internal deadline check rejected it — wasted Gate work. RED before that fix: the
    // driver reached freeze/validate/finalize and returned `finalized`, not `terminalized`.
    await context.start(async () => {
      const deadlines = scriptedDeadlines([
        { kind: "ok" }, // loop-top check before attempt 1 starts
        { kind: "expired", bound: "absolute" }, // the new post-attempt-outcome check
      ]);
      const h = harness(manualClock(T0), deadlines);
      const runPromise = wrap(runTurn(h.deps, baseRunTurnInput()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1));

      const result = await wrap(runPromise);

      if (result.kind !== "terminalized")
        throw new Error(`expected terminalized, got ${JSON.stringify(result)}`);
      expect(result.result.kind).toBe("recorded");

      const terminalizeCall = h.turnTransactions.calls.find((c) => c.method === "terminalize");
      if (terminalizeCall?.method !== "terminalize") throw new Error("expected a terminalize call");
      if (terminalizeCall.input.record.kind !== "system:error") {
        throw new Error(`expected system:error, got ${terminalizeCall.input.record.kind}`);
      }
      expect(terminalizeCall.input.record.outcome).toBe("error");
      expect(terminalizeCall.input.record.text).toBe(
        "the turn's absolute deadline expired before the next attempt could start",
      );

      // Never froze or validated the completed attempt's candidate.
      expect(h.staging.calls.map((c) => c.method)).toEqual(["createTurnWorkspace"]);
      expect(h.gateRunner.calls).toEqual([]);
    });
  });

  test('(f) attempt outcome "failed": terminalizeTurn with the failed record, reason "BACKEND_FAILED"', async () => {
    await context.start(async () => {
      const h = harness();
      const runPromise = wrap(runTurn(h.deps, baseRunTurnInput()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, {
        kind: "backend-error",
        message: "the backend crashed",
        sessionId: null,
        // Fences this test as "an ordinary backend error still terminalizes as BACKEND_FAILED"
        // (design-agent-feedback-loop repair, Task 9) — an UNCLASSIFIED failure must never route
        // through the session fallback; the dedicated describe block below covers the classified
        // "resume-rejected" branch this `cause: null` deliberately does not exercise.
        cause: null,
      });

      const result = await wrap(runPromise);

      if (result.kind !== "terminalized")
        throw new Error(`expected terminalized, got ${JSON.stringify(result)}`);
      expect(result.result.kind).toBe("recorded");
      // Gate-exhaustion-vs-backend-failure follow-up to WP-8 item 4
      // (`core/kernel/model/handlers/turn.ts`'s own header): this call site used to pass
      // `reason: undefined`, the exact gap that left an agent-backend failure indistinguishable
      // from Gate exhaustion (which already passed a typed `"GATE_RETRY_EXHAUSTED"` reason, test
      // (c) above) once both reached `"recorded"`. `TerminalizeTurnResultV1.reason` now echoes
      // the typed `"BACKEND_FAILED"` code back to the caller.
      if (result.result.kind !== "recorded") throw new Error("expected recorded");
      expect(result.result.reason).toBe("BACKEND_FAILED");

      const terminalizeCall = h.turnTransactions.calls.find((c) => c.method === "terminalize");
      if (terminalizeCall?.method !== "terminalize") throw new Error("expected a terminalize call");
      if (terminalizeCall.input.record.kind !== "system:error") {
        throw new Error(`expected system:error, got ${terminalizeCall.input.record.kind}`);
      }
      expect(terminalizeCall.input.record.outcome).toBe("error");
      expect(terminalizeCall.input.record.text).toBe("the backend crashed");
      expect(terminalizeCall.input.record.reason).toBe("BACKEND_FAILED");

      // Never reached freeze/validation/finalize.
      expect(h.staging.calls.map((c) => c.method)).toEqual(["createTurnWorkspace"]);
      expect(h.gateRunner.calls).toEqual([]);
    });
  });

  test('(g) attempt outcome "backend-unhealthy": folds into a failed terminal record (documented divergence)', async () => {
    // See run-turn.ts's own header, "BACKEND-UNHEALTHY DIVERGENCE": the real quarantine/
    // health-check supervisor is out of this task's scope, so an unconfirmed process exit
    // folds into an ordinary terminal `failed` record rather than the spec's own
    // `backend-unhealthy` phase. This test asserts exactly that documented behavior.
    await context.start(async () => {
      const h = harness();
      const runPromise = wrap(runTurn(h.deps, baseRunTurnInput()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, { kind: "unconfirmed-exit" });

      const result = await wrap(runPromise);

      if (result.kind !== "terminalized")
        throw new Error(`expected terminalized, got ${JSON.stringify(result)}`);
      expect(result.result.kind).toBe("recorded");

      const terminalizeCall = h.turnTransactions.calls.find((c) => c.method === "terminalize");
      if (terminalizeCall?.method !== "terminalize") throw new Error("expected a terminalize call");
      if (terminalizeCall.input.record.kind !== "system:error") {
        throw new Error(`expected system:error, got ${terminalizeCall.input.record.kind}`);
      }
      expect(terminalizeCall.input.record.outcome).toBe("error");
      expect(terminalizeCall.input.record.text).toBe("the backend could not confirm a clean exit");
      expect(terminalizeCall.input.record.reason).toBe("unhealthy_unconfirmed_exit");

      // Never reached freeze/validation/finalize.
      expect(h.staging.calls.map((c) => c.method)).toEqual(["createTurnWorkspace"]);
      expect(h.gateRunner.calls).toEqual([]);
    });
  });

  test("(h) deadline expires between attempts: terminalizes at the loop top without starting attempt 2", async () => {
    await context.start(async () => {
      const deadlines = scriptedDeadlines([
        { kind: "ok" }, // loop-top check before attempt 1 starts
        { kind: "ok" }, // the post-attempt-outcome check, right after attempt 1 completes
        { kind: "expired", bound: "absolute" }, // loop-top check before attempt 2 would start
      ]);
      const h = harness(manualClock(T0), deadlines);
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT); // forces attempt 1's Gate retry

      const runPromise = wrap(runTurn(h.deps, baseRunTurnInput()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1));

      const result = await wrap(runPromise);

      if (result.kind !== "terminalized")
        throw new Error(`expected terminalized, got ${JSON.stringify(result)}`);
      expect(result.result.kind).toBe("recorded");

      const terminalizeCall = h.turnTransactions.calls.find((c) => c.method === "terminalize");
      if (terminalizeCall?.method !== "terminalize") throw new Error("expected a terminalize call");
      if (terminalizeCall.input.record.kind !== "system:error") {
        throw new Error(`expected system:error, got ${terminalizeCall.input.record.kind}`);
      }
      expect(terminalizeCall.input.record.text).toBe(
        "the turn's absolute deadline expired before the next attempt could start",
      );

      // Attempt 1 ran and was Gate-rejected (one fold, one retry decision), but attempt 2
      // never started — the loop-top deadline check terminalized first.
      expect(h.foldCalls.length).toBe(1);
      expect(h.startedTasks.length).toBe(1);
    });
  });

  // NOTE on finding 3's second half: `run-turn.ts`'s own `attempt > MAX_TURN_ATTEMPTS`
  // defensive branch (its own comment: "unreachable via this driver's own sequencing... but
  // never silently trusted either") is not exercised by a test here. `TurnFence.beginAttempt`
  // (fence.ts) independently enforces the identical MAX_TURN_ATTEMPTS budget and is the ONLY
  // place the fence's own attempt counter advances; `runTurnValidation`'s `nextAttemptAfter`
  // (validation.ts) never returns a `nextAttempt` past 4 because `canRetryAfterGate` gates
  // every "retry" decision on `attempt < MAX_TURN_ATTEMPT` first. Driving the local `attempt`
  // variable past 4 through this module's public `runTurn` entry point with fakes would
  // require that lockstep between the driver and the fence to already be broken — i.e. a
  // separate bug, not a reachable input. Left untested rather than contrived, per the
  // review's own instruction for a genuinely unreachable defensive branch.

  test("(i) freeze failure: a failing snapshotToCandidate terminalizes without reaching Gate", async () => {
    await context.start(async () => {
      const h = harness();
      const failure: FailureDtoV1 = {
        code: "PERSISTENCE_FAILED",
        retryable: false,
        safeMessage: "candidate snapshot failed",
        details: {},
      };
      h.staging.failNext("snapshotToCandidate", failure);

      const runPromise = wrap(runTurn(h.deps, baseRunTurnInput()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1));

      const result = await wrap(runPromise);

      if (result.kind !== "terminalized")
        throw new Error(`expected terminalized, got ${JSON.stringify(result)}`);
      expect(result.result.kind).toBe("recorded");

      const terminalizeCall = h.turnTransactions.calls.find((c) => c.method === "terminalize");
      if (terminalizeCall?.method !== "terminalize") throw new Error("expected a terminalize call");
      if (terminalizeCall.input.record.kind !== "system:error") {
        throw new Error(`expected system:error, got ${terminalizeCall.input.record.kind}`);
      }
      expect(terminalizeCall.input.record.text).toBe("candidate snapshot failed");
      expect(terminalizeCall.input.record.reason).toBe("PERSISTENCE_FAILED");

      // Gate never ran — the candidate never froze.
      expect(h.gateRunner.calls).toEqual([]);
    });
  });

  test("(j) finalize failure (e.g. a stale read-set): bridges finalizing -> terminalizing and settles to idle — NEVER strands the machine (§10 smoke closeout fix)", async () => {
    // RED before the fix: `finalizeTurn`'s own header marks the `finalizing ->
    // terminalizing` edge "reached by a caller this function does not own" — an earlier
    // version of `runTurn` was never that caller. It returned
    // `{kind:"finalized", result:{kind:"failed"}}` as-is, leaving the machine stuck in
    // "finalizing" permanently (every later `chat.*`/`turn.*`/`export.*` command in the
    // same process then guard-rejected `CAPABILITY_UNAVAILABLE` forever — the §10 smoke
    // report's "compounding second effect").
    await context.start(async () => {
      const h = harness();
      const failure: FailureDtoV1 = {
        code: "APPLY_STALE",
        retryable: true,
        safeMessage: "chat append base advanced since this turn's read-set was captured",
        details: { part: "chat" },
      };
      h.turnTransactions.failNext("finalize", failure);

      const runPromise = wrap(runTurn(h.deps, baseRunTurnInput()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1));

      const result = await wrap(runPromise);

      if (result.kind !== "terminalized")
        throw new Error(`expected terminalized, got ${JSON.stringify(result)}`);
      expect(result.result.kind).toBe("recorded");

      const terminalizeCall = h.turnTransactions.calls.find((c) => c.method === "terminalize");
      if (terminalizeCall?.method !== "terminalize") throw new Error("expected a terminalize call");
      if (terminalizeCall.input.record.kind !== "system:error") {
        throw new Error(`expected system:error, got ${terminalizeCall.input.record.kind}`);
      }
      expect(terminalizeCall.input.record.outcome).toBe("error");
      expect(terminalizeCall.input.record.text).toBe(failure.safeMessage);
      expect(terminalizeCall.input.record.reason).toBe("APPLY_STALE");

      // The machine genuinely settled all the way to idle — never stranded in "finalizing".
      expect(h.deps.machine.phase()).toBe("idle");
      expect(h.turnTransactions.calls.map((c) => c.method)).toEqual([
        "admit",
        "finalize",
        "terminalize",
      ]);
    });
  });

  test("(k) a concurrent cancel races finalize's own durable write: markCommitted goes illegal, but the driver bridges to terminalizing instead of reporting a false 'finalized' success (fixlane-K1-turn-spine.json's domain finding)", async () => {
    // RED before the fix: `finalizeResult.kind === \"illegal\"` fell through to
    // `return {kind:\"finalized\", result: finalizeResult}` — a false success signal — leaving
    // the machine stranded in \"terminalizing\" (never settled to idle).
    await context.start(async () => {
      const h = harness();
      // Simulate a `turn.cancel` landing in the pre-intent window `finalize.ts`'s own header
      // documents as legitimate: AFTER `turnTransactions.finalize` durably resolves, but
      // BEFORE `finalizeTurn`'s own `markCommitted` call runs — `requestCancel` is
      // phase-legal from "finalizing" (`turn-machine.ts`'s own table).
      const originalFinalize = h.turnTransactions.finalize.bind(h.turnTransactions);
      h.turnTransactions.finalize = async (input) => {
        // `wrap(...)` around the awaited promise (not the whole async function) — matching
        // `run-turn.ts`'s own `await wrap(finalizeTurn(...))` idiom — is required here: an
        // unwrapped continuation after this `await` resumes OUTSIDE the test's own
        // `context.start(...)` frame, so `h.deps.machine.apply(...)` would silently observe a
        // different (fresh, uninitiated) machine instead of the SAME one `runTurn` drives.
        const result = await wrap(originalFinalize(input));
        const cancelled = h.deps.machine.apply("requestCancel");
        if (cancelled.kind === "illegal") {
          throw new Error(
            `test setup: requestCancel was illegal (${cancelled.code}) — harness assumption broken`,
          );
        }
        return result;
      };

      const runPromise = wrap(runTurn(h.deps, baseRunTurnInput()));
      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1));

      const result = await wrap(runPromise);

      if (result.kind !== "terminalized")
        throw new Error(`expected terminalized, got ${JSON.stringify(result)}`);
      expect(result.result.kind).toBe("recorded");

      const terminalizeCall = h.turnTransactions.calls.find((c) => c.method === "terminalize");
      if (terminalizeCall?.method !== "terminalize") throw new Error("expected a terminalize call");
      if (terminalizeCall.input.record.kind !== "system:error") {
        throw new Error(`expected system:error, got ${terminalizeCall.input.record.kind}`);
      }
      // `TURN_ALREADY_ACTIVE` is the turn machine's one table-wide illegal code
      // (`turn-machine.ts`'s own `TURN_ILLEGAL_CODE`) — this is `markCommitted`'s own illegal
      // result's `code`, threaded through as this terminalize's `reason`.
      expect(terminalizeCall.input.record.reason).toBe("TURN_ALREADY_ACTIVE");

      // The machine genuinely settled all the way to idle — never stranded in "terminalizing".
      expect(h.deps.machine.phase()).toBe("idle");
      expect(h.turnTransactions.calls.map((c) => c.method)).toEqual([
        "admit",
        "finalize",
        "terminalize",
      ]);
    });
  });
});

describe("runTurn — a Gate retry resumes the attempt it is correcting (design-agent-feedback-loop repair, task 8)", () => {
  // Within one turn the workspace is identical across every attempt (the SDK indexes sessions
  // by cwd, and a turn's workspace never changes across its own attempts) — so a retry can
  // RESUME the rejected attempt's own session rather than starting a fresh one that re-reads
  // every doc and page from scratch. The fold rides as `session.promptDelta`, never as a fresh
  // first message: `agent/session/model/prompt.ts:13` reads
  // `task.session.promptDelta ?? task.userMessage`, so on a resume the delta IS the prompt and
  // `userMessage` is not sent at all. The two channels are mutually exclusive by construction —
  // every test below pins that the fold appears EXACTLY ONCE, never in both, never in neither.

  // `file` is TREE-relative in Gate's own vocabulary (`pages/alarm.tsx`, no `design/` prefix) —
  // `prompt.ts`'s `toWorkspacePath` translates it to `design/pages/alarm.tsx` for the agent
  // (Task 3's own path-translation fix). Present here so the "fold travels as promptDelta"
  // test below can pin that translation survives end to end into a RESUMED retry's delta.
  const FAILING_PAGE_RESULT_1: GateRunResultV1 = {
    ok: false,
    errors: [{ kind: "type", code: "TS1111", message: "first rejection", file: "pages/alarm.tsx" }],
    warnings: [],
    descriptor: null,
  };
  const FAILING_PAGE_RESULT_2: GateRunResultV1 = {
    ok: false,
    errors: [{ kind: "type", code: "TS2222", message: "second rejection" }],
    warnings: [],
    descriptor: null,
  };

  function resumeSession(
    task: (Omit<AgentTask, "fence"> & { readonly fence: unknown }) | undefined,
  ) {
    const session = task?.session;
    if (session?.kind !== "resume") throw new Error("expected a resume session plan");
    return session;
  }

  /**
   * Mirrors `agent/session/model/prompt.ts:13`'s channel-selection rule for a `resume` plan
   * exactly (`task.session.promptDelta ?? task.userMessage`) — reproduced rather than imported
   * because `core` test files do not import `agent` (module-boundary rule, `CLAUDE.md`
   * "Imports"). Used by the round-1-review regression test below so the assertion pins the
   * REAL invariant — what the agent will actually read — not a hand-checked approximation.
   */
  function effectivePromptFor(
    task: (Omit<AgentTask, "fence"> & { readonly fence: unknown }) | undefined,
  ): string {
    if (task === undefined) throw new Error("expected a started task");
    if (task.session.kind === "resume") return task.session.promptDelta ?? task.userMessage;
    return task.userMessage;
  }

  test("attempt 2 of a rejected turn resumes attempt 1's session", async () => {
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT_1);
      h.gateRunner.queueRunPageResult(PASSING_PAGE_RESULT);
      const runPromise = wrap(runTurn(h.deps, baseRunTurnInput()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1)); // sessionId "s1"

      await waitForStartCount(h, 2);
      completeAttempt(h, 2, completedOutcome(2));

      const result = await wrap(runPromise);
      if (result.kind !== "finalized")
        throw new Error(`expected finalized, got ${JSON.stringify(result)}`);

      const secondSession = resumeSession(h.startedTasks[1]);
      expect(secondSession).toEqual({
        kind: "resume",
        sessionId: "s1",
        promptDelta: expect.stringContaining("Gate rejected"),
      });
    });
  });

  test("the fold travels as promptDelta, not as a fresh first message", async () => {
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT_1);
      h.gateRunner.queueRunPageResult(PASSING_PAGE_RESULT);
      const input = baseRunTurnInput();
      const runPromise = wrap(runTurn(h.deps, input));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1));

      await waitForStartCount(h, 2);
      completeAttempt(h, 2, completedOutcome(2));

      const result = await wrap(runPromise);
      if (result.kind !== "finalized")
        throw new Error(`expected finalized, got ${JSON.stringify(result)}`);

      // The retry's userMessage stays the ORIGINAL message; the diagnostics ride the delta.
      expect(h.startedTasks[1]?.userMessage).toBe(input.baseTask.userMessage);
      const secondSession = resumeSession(h.startedTasks[1]);
      // Task 3's own path-translation vocabulary survives end to end into a resumed retry's
      // delta: Gate's tree-relative `pages/alarm.tsx` becomes the workspace-relative path the
      // agent must type into its own tools.
      expect(secondSession.promptDelta).toContain("design/pages/alarm.tsx");
    });
  });

  test("a rejected attempt with no session id falls back to the turn's original plan, and the fold rides userMessage instead (the defensive branch)", async () => {
    // Cannot happen for a `completed` outcome (`sessionId` is a non-optional `string` there —
    // `TurnAttemptOutcomeV1`'s own `completed` variant) — this pins the DEFENSIVE branch: if
    // the type ever widens to admit a completed attempt without a session id, the retry
    // degrades to the turn's original session plan rather than constructing a resume of
    // nothing, and the fold moves back onto `userMessage` since a non-resume plan has no
    // `promptDelta` slot to carry it in.
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT_1);
      h.gateRunner.queueRunPageResult(PASSING_PAGE_RESULT);
      const input = baseRunTurnInput();
      const runPromise = wrap(runTurn(h.deps, input));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, {
        kind: "completed",
        finalText: "done-1",
        usage: null,
        sessionId: "", // stands in for "no session id" — see the header above
      });

      await waitForStartCount(h, 2);
      completeAttempt(h, 2, completedOutcome(2));

      const result = await wrap(runPromise);
      if (result.kind !== "finalized")
        throw new Error(`expected finalized, got ${JSON.stringify(result)}`);

      // `session` falls back to the turn's original plan — no promptDelta slot exists on it.
      expect(h.startedTasks[1]?.session).toEqual(input.baseTask.session);
      // So the fold must ride userMessage instead (fold appears exactly once, never neither).
      expect(h.startedTasks[1]?.userMessage).toContain(input.baseTask.userMessage);
      expect(h.startedTasks[1]?.userMessage).toContain("Gate rejected the previous attempt");
      expect(h.startedTasks[1]?.userMessage).toContain("TS1111");
    });
  });

  test("a rejected attempt with no session id, when the turn's OWN plan is already a same-process resume with a non-null promptDelta, folds onto that promptDelta rather than a dead userMessage channel (round-1 review fix)", async () => {
    // Round-1 review finding: `input.baseTask.session` is NOT always a "fresh" plan with no
    // `promptDelta` slot. WP-7's same-process chat resume
    // (`store/adapters/session-checkpoint.ts`'s `renderPromptDelta`,
    // `core/turns/model/session-plan.ts:49-50`'s `evaluateSessionPlan`) can hand this driver a
    // "resume" plan whose `promptDelta` is already a real, non-null transcript. Appending the
    // fold to `userMessage` in that case — the defensive branch's OLD behavior — reaches a
    // channel `agent/session/model/prompt.ts:13`'s `promptDelta ?? userMessage` never even
    // looks at once `promptDelta` is non-null: the fold would silently vanish, reaching
    // neither channel the agent actually reads.
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT_1);
      h.gateRunner.queueRunPageResult(PASSING_PAGE_RESULT);
      const base = baseRunTurnInput();
      const input: RunTurnInputV1 = {
        ...base,
        baseTask: {
          ...base.baseTask,
          session: { kind: "resume", sessionId: "s0", promptDelta: "original resume text" },
        },
      };
      const runPromise = wrap(runTurn(h.deps, input));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, {
        kind: "completed",
        finalText: "done-1",
        usage: null,
        sessionId: "", // forces the defensive branch on this turn's very first retry
      });

      await waitForStartCount(h, 2);
      completeAttempt(h, 2, completedOutcome(2));

      const result = await wrap(runPromise);
      if (result.kind !== "finalized")
        throw new Error(`expected finalized, got ${JSON.stringify(result)}`);

      const retrySession = h.startedTasks[1]?.session;
      if (retrySession?.kind !== "resume") throw new Error("expected a resume session plan");
      // Still resuming the SAME underlying session the turn was already resuming — never a
      // fresh conversation, and never a different session id than the one already established.
      expect(retrySession.sessionId).toBe("s0");

      // Read through the EXACT SAME channel-selection rule prompt.ts uses, so this pins the
      // real invariant — what the agent actually reads — not an approximation of it.
      const effectivePrompt = effectivePromptFor(h.startedTasks[1]);
      expect(effectivePrompt).toContain("original resume text");
      expect(effectivePrompt).toContain("Gate rejected the previous attempt");
      expect(effectivePrompt).toContain("TS1111");
    });
  });

  test("attempt 3 resumes attempt 2, not attempt 1", async () => {
    // The session id must advance every attempt. Resuming attempt 1 from attempt 3 would
    // replay a session that never saw attempt 2's own edits.
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT_1);
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT_2);
      h.gateRunner.queueRunPageResult(PASSING_PAGE_RESULT);
      const runPromise = wrap(runTurn(h.deps, baseRunTurnInput()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1)); // sessionId "s1"

      await waitForStartCount(h, 2);
      completeAttempt(h, 2, completedOutcome(2)); // sessionId "s2"

      await waitForStartCount(h, 3);
      completeAttempt(h, 3, completedOutcome(3));

      const result = await wrap(runPromise);
      if (result.kind !== "finalized")
        throw new Error(`expected finalized, got ${JSON.stringify(result)}`);

      expect(h.startedTasks.length).toBe(3);
      expect(h.startedTasks[0]?.session).toEqual({ kind: "fresh", seed: [] });
      expect(resumeSession(h.startedTasks[1]).sessionId).toBe("s1");
      // The critical assertion: attempt 3 resumes attempt 2's session (the one that just ran
      // and was rejected) — never attempt 1's stale session.
      expect(resumeSession(h.startedTasks[2]).sessionId).toBe("s2");
    });
  });

  test("the fold is never accumulated across two retries (prompt.ts's freshness barrier, unchanged)", async () => {
    // attempt 3's delta carries attempt 2's diagnostics only — never attempt 1's, folded in on
    // top.
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT_1);
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT_2);
      h.gateRunner.queueRunPageResult(PASSING_PAGE_RESULT);
      const runPromise = wrap(runTurn(h.deps, baseRunTurnInput()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1));

      await waitForStartCount(h, 2);
      completeAttempt(h, 2, completedOutcome(2));

      await waitForStartCount(h, 3);
      completeAttempt(h, 3, completedOutcome(3));

      const result = await wrap(runPromise);
      if (result.kind !== "finalized")
        throw new Error(`expected finalized, got ${JSON.stringify(result)}`);

      const secondDelta = resumeSession(h.startedTasks[1]).promptDelta ?? "";
      expect(secondDelta).toContain("TS1111");
      expect(secondDelta).not.toContain("TS2222");

      const thirdDelta = resumeSession(h.startedTasks[2]).promptDelta ?? "";
      expect(thirdDelta).toContain("TS2222");
      expect(thirdDelta).not.toContain("TS1111");
    });
  });
});

describe("runTurn — the optional onAttemptStarted hook (kernel-assembly Task 9, Step C3)", () => {
  // Closes the turn family's own remaining "Gap 2 producer side" gap
  // (`.superpowers/sdd/task-9-report.md`, "Step C2 turn"): `turn.start`'s own `launchOperation`
  // closure needs a way to register the LIVE attempt's cancel handle on
  // `context.turnRunner.setActiveAttempt` and clear it once that attempt settles — `runTurn`
  // never returned one before this hook (`RunTurnResultV1`'s three members carry no handle).
  // ADDITIVE ONLY: `onAttemptStarted` is optional, so every OTHER test in this file (built
  // against `RunTurnDeps` objects that never set it) stays green unmodified — verified by the
  // full suite run this file's own report cites, not merely asserted here.

  test("fires with a live handle when an attempt starts, then with null once that attempt's outcome settles", async () => {
    await context.start(async () => {
      const h = harness();
      const seen: (string | null)[] = [];
      const deps: RunTurnDeps = {
        ...h.deps,
        onAttemptStarted: (handle) => seen.push(handle === null ? null : "handle"),
      };
      const runPromise = wrap(runTurn(deps, baseRunTurnInput()));

      await waitForStartCount(h, 1);
      expect(seen).toEqual(["handle"]);

      completeAttempt(h, 1, completedOutcome(1));
      const result = await wrap(runPromise);

      if (result.kind !== "finalized") throw new Error(`expected finalized, got ${result.kind}`);
      expect(seen).toEqual(["handle", null]);
    });
  });

  test("fires once per attempt across a Gate retry (start/clear, start/clear — never overlapping)", async () => {
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT);
      h.gateRunner.queueRunPageResult(PASSING_PAGE_RESULT);
      const seen: (string | null)[] = [];
      const deps: RunTurnDeps = {
        ...h.deps,
        onAttemptStarted: (handle) => seen.push(handle === null ? null : "handle"),
      };
      const runPromise = wrap(runTurn(deps, baseRunTurnInput()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1));
      await waitForStartCount(h, 2);
      completeAttempt(h, 2, completedOutcome(2));

      const result = await wrap(runPromise);
      if (result.kind !== "finalized") throw new Error(`expected finalized, got ${result.kind}`);
      expect(seen).toEqual(["handle", null, "handle", null]);
    });
  });

  test("the handle passed genuinely drives the real cancel path — requestCancel reaches AgentBackend.cancel for the exact leased run", async () => {
    await context.start(async () => {
      const h = harness();
      let liveHandle: { requestCancel: () => Promise<void> } | null = null;
      const deps: RunTurnDeps = {
        ...h.deps,
        onAttemptStarted: (handle) => {
          if (handle !== null) liveHandle = handle;
        },
      };
      const runPromise = wrap(runTurn(deps, baseRunTurnInput()));

      await waitForStartCount(h, 1);
      if (liveHandle === null) throw new Error("expected a live handle to have been registered");

      const cancelPromise = wrap(
        (liveHandle as { requestCancel: () => Promise<void> }).requestCancel(),
      );
      completeAttempt(h, 1, { kind: "cancelled", exitConfirmed: true });
      await cancelPromise;

      const result = await wrap(runPromise);
      if (result.kind !== "terminalized")
        throw new Error(`expected terminalized, got ${JSON.stringify(result)}`);
      expect(h.agentBackend.calls.some((c) => c.method === "cancel")).toBe(true);
    });
  });

  test("never called when admission itself is rejected (no attempt ever starts)", async () => {
    await context.start(async () => {
      const h = harness();
      h.turnTransactions.failNext("admit", {
        code: "PERSISTENCE_FAILED",
        retryable: false,
        safeMessage: "admit failed",
        details: {},
      });
      const seen: (string | null)[] = [];
      const deps: RunTurnDeps = {
        ...h.deps,
        onAttemptStarted: (handle) => seen.push(handle === null ? null : "handle"),
      };

      const result = await wrap(runTurn(deps, baseRunTurnInput()));

      expect(result.kind).toBe("admission-rejected");
      expect(seen).toEqual([]);
    });
  });
});

describe("runTurn — the optional onCommitIntentRecorded hook (fixlane-K1-turn-spine.json's kernel finding)", () => {
  // Closes the durable commit-intent bit's own remaining producer-side gap: no production
  // handler ever called `HandlerContext.setCommitIntentRecorded`, so `kernel.ts`'s
  // `commitIntentRecordedAtom` was permanently `false` in a real Kernel — this hook is what
  // `handlers/turn.ts` now wires onto it. ADDITIVE ONLY: optional, so every other test in
  // this file (built against `RunTurnDeps` objects that never set it) stays green unmodified.

  test("fires true once finalizeTurn reports a genuine committed result", async () => {
    await context.start(async () => {
      const h = harness();
      const seen: boolean[] = [];
      const deps: RunTurnDeps = { ...h.deps, onCommitIntentRecorded: (r) => seen.push(r) };
      const runPromise = wrap(runTurn(deps, baseRunTurnInput()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1));

      const result = await wrap(runPromise);
      if (result.kind !== "finalized") throw new Error(`expected finalized, got ${result.kind}`);
      expect(result.result.kind).toBe("committed");
      expect(seen).toEqual([true]);
    });
  });

  test("fires true even when a raced cancel makes markCommitted illegal — the underlying write still durably committed (pairs with test (k) above)", async () => {
    await context.start(async () => {
      const h = harness();
      const originalFinalize = h.turnTransactions.finalize.bind(h.turnTransactions);
      h.turnTransactions.finalize = async (input) => {
        const result = await wrap(originalFinalize(input));
        h.deps.machine.apply("requestCancel");
        return result;
      };
      const seen: boolean[] = [];
      const deps: RunTurnDeps = { ...h.deps, onCommitIntentRecorded: (r) => seen.push(r) };
      const runPromise = wrap(runTurn(deps, baseRunTurnInput()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1));

      const result = await wrap(runPromise);
      if (result.kind !== "terminalized")
        throw new Error(`expected terminalized, got ${JSON.stringify(result)}`);
      expect(seen).toEqual([true]);
    });
  });

  test("never fires for a failed finalize (e.g. a stale read-set) — no durable write ever landed", async () => {
    await context.start(async () => {
      const h = harness();
      h.turnTransactions.failNext("finalize", {
        code: "APPLY_STALE",
        retryable: true,
        safeMessage: "chat append base advanced since this turn's read-set was captured",
        details: { part: "chat" },
      });
      const seen: boolean[] = [];
      const deps: RunTurnDeps = { ...h.deps, onCommitIntentRecorded: (r) => seen.push(r) };
      const runPromise = wrap(runTurn(deps, baseRunTurnInput()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1));

      const result = await wrap(runPromise);
      if (result.kind !== "terminalized")
        throw new Error(`expected terminalized, got ${JSON.stringify(result)}`);
      expect(seen).toEqual([]);
    });
  });

  test("never fires when the turn terminalizes without ever reaching finalize (Gate-retry exhaustion)", async () => {
    await context.start(async () => {
      const h = harness();
      for (let i = 0; i < 4; i++) h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT);
      const seen: boolean[] = [];
      const deps: RunTurnDeps = { ...h.deps, onCommitIntentRecorded: (r) => seen.push(r) };
      const runPromise = wrap(runTurn(deps, baseRunTurnInput()));

      for (let attempt = 1; attempt <= 4; attempt++) {
        await waitForStartCount(h, attempt);
        completeAttempt(h, attempt, completedOutcome(attempt));
      }

      const result = await wrap(runPromise);
      if (result.kind !== "terminalized")
        throw new Error(`expected terminalized, got ${JSON.stringify(result)}`);
      expect(seen).toEqual([]);
    });
  });
});

describe("runTurn — candidate retirement is wired through the COMPOSED driver, not only the leaf units (review findings #4/#5)", () => {
  // Retirement was previously covered only by `finalize.test.ts`/`terminalize.test.ts` unit
  // tests that build their own deps by hand — deleting the wiring from `run-turn.ts` itself
  // would have left both of those suites, and every other test in THIS file, green. These two
  // tests exercise retirement through `runTurn`'s own composed loop and `harness()`.

  test("a committed turn retires the frozen candidate exactly once, at its own root", async () => {
    await context.start(async () => {
      const h = harness();
      let capturedCandidateRoot: string | null = null;
      const base = baseRunTurnInput();
      const runInput: RunTurnInputV1 = {
        ...base,
        buildFinalizeInput: (args) => {
          capturedCandidateRoot = args.candidate.root;
          return base.buildFinalizeInput(args);
        },
      };
      const runPromise = wrap(runTurn(h.deps, runInput));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1));

      const result = await wrap(runPromise);
      if (result.kind !== "finalized") throw new Error(`expected finalized, got ${result.kind}`);
      expect(result.result.kind).toBe("committed");

      const retireCalls = h.staging.calls.filter((c) => c.method === "retireCandidate");
      expect(retireCalls.length).toBe(1);
      const retireCall = retireCalls[0];
      if (retireCall?.method !== "retireCandidate")
        throw new Error("expected a retireCandidate call");
      if (capturedCandidateRoot === null)
        throw new Error("expected buildFinalizeInput to have captured a candidate root");
      expect(retireCall.root).toBe(capturedCandidateRoot);
    });
  });

  test("a gate-retry-then-cancel turn retires the candidate frozen by the earlier, since-abandoned attempt (finding #4's own regression — this test was RED before that fix, see this file's own report)", async () => {
    // Attempt 1 completes, freezes a candidate, and gets Gate-rejected -> the loop retries
    // into attempt 2. Attempt 2 is then cancelled BEFORE it ever reaches its own freeze — so
    // the ONLY candidate this turn ever froze is the one attempt 1 produced. Before finding
    // #4's fix, `run-turn.ts`'s `outcome.kind === "cancelled"` branch called `terminalize()`
    // with no `candidateRoot` at all (the branch fires before THIS iteration's own freeze),
    // silently abandoning attempt 1's already-frozen candidate forever.
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT);
      let capturedCandidateRoot: string | null = null;
      const base = baseRunTurnInput();
      const runInput: RunTurnInputV1 = {
        ...base,
        buildValidationInput: (candidate) => {
          capturedCandidateRoot = candidate.root;
          return base.buildValidationInput(candidate);
        },
      };
      const runPromise = wrap(runTurn(h.deps, runInput));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1));

      await waitForStartCount(h, 2);
      completeAttempt(h, 2, { kind: "cancelled", exitConfirmed: true });

      const result = await wrap(runPromise);
      if (result.kind !== "terminalized")
        throw new Error(`expected terminalized, got ${JSON.stringify(result)}`);
      expect(result.result.kind).toBe("recorded");

      // Only attempt 1 ever froze a candidate — attempt 2 was cancelled before its own freeze
      // ran, so there is exactly one `snapshotToCandidate`/`readCandidateFile` pair for the
      // whole turn.
      expect(h.staging.calls.map((c) => c.method)).toEqual([
        "createTurnWorkspace",
        "snapshotToCandidate",
        "readCandidateFile",
        "retireCandidate",
      ]);
      const retireCalls = h.staging.calls.filter((c) => c.method === "retireCandidate");
      expect(retireCalls.length).toBe(1);
      const retireCall = retireCalls[0];
      if (retireCall?.method !== "retireCandidate")
        throw new Error("expected a retireCandidate call");
      if (capturedCandidateRoot === null)
        throw new Error("expected buildValidationInput to have captured a candidate root");
      expect(retireCall.root).toBe(capturedCandidateRoot);
    });
  });
});

describe("runTurn — session fallback on a rejected resume (design-agent-feedback-loop repair, Task 9)", () => {
  // Measured: turn 2 terminalized `BACKEND_FAILED: No conversation found with session ID:
  // 28b861a5`; the user abandoned the chat and retyped the message into a new one within 20
  // seconds. `fallbackToFreshSession` (`./session-plan.ts`) already existed, tested, with no
  // production caller (`docs/mvp-remaining-work.md`'s own row, closed by this task) — these
  // tests pin the wiring that finally calls it.
  //
  // `outcome.cause === "resume-rejected"` is driven directly on the fake `AgentRunOutcome`
  // below, exactly like every other outcome-branch test in this file (test (f) above, the
  // Gate-retry describe block) — `run-turn.ts` never re-derives the classification itself, it
  // only reacts to it, so these tests do not need a real Claude SDK shape to drive from. The
  // classifier's OWN conjunction (spike 12's four structural conditions) is covered end to end
  // in `agent/claude/run/model/classify-backend-error.test.ts` and
  // `agent/claude/run/model/drive-stream.test.ts`.

  const RESUME_REJECTED_OUTCOME: AgentRunOutcome = {
    kind: "backend-error",
    message: "No conversation found with session ID: prior-s",
    sessionId: null,
    cause: "resume-rejected",
  };

  /** attempt 1's own plan: a resume of a prior turn's session — the only shape a real backend can reject as "resume-rejected" (the classifier's own guard 1). */
  function inputWithResumePlan(): RunTurnInputV1 {
    const base = baseRunTurnInput();
    return {
      ...base,
      baseTask: {
        ...base.baseTask,
        session: { kind: "resume", sessionId: "prior-s", promptDelta: null },
      },
    };
  }

  test("a rejected resume produces a completed turn on a fresh session", async () => {
    await context.start(async () => {
      const seeds = new Map([["chat-1", [{ role: "agent" as const, text: "prior reply" }]]]);
      const h = harness(manualClock(T0), undefined, createFakeSessionCheckpointService({ seeds }));
      const runPromise = wrap(runTurn(h.deps, inputWithResumePlan()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, RESUME_REJECTED_OUTCOME);

      await waitForStartCount(h, 2);
      completeAttempt(h, 2, completedOutcome(2));

      const result = await wrap(runPromise);
      // Today this terminalizes as BACKEND_FAILED (the defect this task fixes) — a fresh
      // second attempt actually running and finalizing is the behavior under test.
      if (result.kind !== "finalized")
        throw new Error(`expected finalized, got ${JSON.stringify(result)}`);
      expect(result.result.kind).toBe("committed");

      expect(h.startedTasks.length).toBe(2);
      expect(h.startedTasks[0]?.session).toEqual({
        kind: "resume",
        sessionId: "prior-s",
        promptDelta: null,
      });
      const secondSession = h.startedTasks[1]?.session;
      if (secondSession?.kind !== "fresh") throw new Error("expected a fresh session plan");
      expect(secondSession.seed).toEqual([{ role: "agent", text: "prior reply" }]);
      // The turn's own original message is sent again, as a fresh first message — never a
      // resume prompt delta, since the second attempt is not a resume.
      expect(h.startedTasks[1]?.userMessage).toBe(inputWithResumePlan().baseTask.userMessage);
    });
  });

  test("the fallback happens ONCE; a second rejection terminalizes", async () => {
    await context.start(async () => {
      const h = harness();
      const runPromise = wrap(runTurn(h.deps, inputWithResumePlan()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, RESUME_REJECTED_OUTCOME);

      await waitForStartCount(h, 2);
      // The fallback's own fresh-session re-run is ALSO reported "resume-rejected" here —
      // unrealistic for a real backend (a fresh-session run cannot be classified that way, per
      // the classifier's own guard 1), but this test drives it directly to pin the DRIVER's
      // own loop guard (`sessionFallbackUsed`), independent of that classifier guarantee.
      completeAttempt(h, 2, RESUME_REJECTED_OUTCOME);

      const result = await wrap(runPromise);
      if (result.kind !== "terminalized")
        throw new Error(`expected terminalized, got ${JSON.stringify(result)}`);
      expect(result.result.kind).toBe("recorded");
      // No third attempt: the second rejection terminalized instead of falling back again.
      expect(h.startedTasks.length).toBe(2);
    });
  });

  test("the fallback does not consume a Gate retry's attempt budget", async () => {
    await context.start(async () => {
      const h = harness();
      // The fallback's own fresh-session re-run (attempt 2 of the fence, but see below) gets
      // Gate-rejected once, then passes.
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT);
      h.gateRunner.queueRunPageResult(PASSING_PAGE_RESULT);
      const runPromise = wrap(runTurn(h.deps, inputWithResumePlan()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, RESUME_REJECTED_OUTCOME); // the rejected resume

      await waitForStartCount(h, 2);
      completeAttempt(h, 2, completedOutcome(2)); // the fallback's own fresh-session re-run

      await waitForStartCount(h, 3);
      completeAttempt(h, 3, completedOutcome(3)); // the Gate-triggered retry of attempt 2

      const result = await wrap(runPromise);
      if (result.kind !== "finalized")
        throw new Error(`expected finalized, got ${JSON.stringify(result)}`);
      expect(result.result.kind).toBe("committed");

      // The Gate-retry fold's own `rejectedAttempt`/`nextAttempt` labels are driven by this
      // driver's LOCAL `attempt` counter, deliberately left unchanged by the session fallback
      // (run-turn.ts's own comment at the fallback call site) — so the fallback's re-run is
      // labelled attempt "1" again, not "2", and its own Gate rejection produces nextAttempt
      // "2", not "3". A Gate rejection AFTER the fallback still has the full 3-retry budget the
      // author would have had if the resume had never been rejected at all.
      expect(h.foldCalls.length).toBe(1);
      expect(h.foldCalls[0]?.rejectedAttempt).toBe(1);
      expect(h.foldCalls[0]?.nextAttempt).toBe(2);
    });
  });

  test("the fallback notes itself on the deadlines and does not reset the absolute bound", async () => {
    await context.start(async () => {
      const clock = manualClock(T0);
      // Wraps the REAL `createTurnDeadlines` (not a no-op fake) so `noteSessionFallback()`
      // actually runs its production body (`deadlines.ts`'s `markActivity`) — proving this
      // driver's wiring reaches the real port, not merely that some closure was called.
      let noteSessionFallbackCalls = 0;
      const real = createTurnDeadlines({ clock });
      const deadlines: TurnDeadlines = {
        ...real,
        noteSessionFallback: () => {
          noteSessionFallbackCalls += 1;
          real.noteSessionFallback();
        },
      };
      const absoluteBefore = deadlines.absoluteDeadlineAt();

      const h = harness(clock, deadlines);
      const runPromise = wrap(runTurn(h.deps, inputWithResumePlan()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, RESUME_REJECTED_OUTCOME);

      await waitForStartCount(h, 2);
      completeAttempt(h, 2, completedOutcome(2));

      const result = await wrap(runPromise);
      if (result.kind !== "finalized")
        throw new Error(`expected finalized, got ${JSON.stringify(result)}`);

      expect(noteSessionFallbackCalls).toBe(1);
      // Non-resettable (`deadlines.ts`'s own header: "the absolute bound... is the ONLY thing
      // standing between that and a runaway turn"): a session fallback is turn activity, but it
      // must never buy the turn extra absolute lifetime.
      expect(deadlines.absoluteDeadlineAt()).toBe(absoluteBefore);
    });
  });

  test("a fallback that cannot select a seed terminalizes on that failure, not the original resume rejection", async () => {
    await context.start(async () => {
      const h = harness();
      const SEED_FAILURE: FailureDtoV1 = {
        code: "PERSISTENCE_FAILED",
        retryable: false,
        safeMessage: "could not read the chat's history for a fresh seed",
        details: {},
      };
      h.sessionCheckpoint.failNext("selectSeed", SEED_FAILURE);
      const runPromise = wrap(runTurn(h.deps, inputWithResumePlan()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, RESUME_REJECTED_OUTCOME);

      const result = await wrap(runPromise);
      if (result.kind !== "terminalized")
        throw new Error(`expected terminalized, got ${JSON.stringify(result)}`);
      if (result.result.kind !== "recorded") throw new Error("expected recorded");
      // The fallback's OWN failure reason, not the original "resume-rejected" message — that
      // resume rejection is not why this turn ultimately failed.
      expect(result.result.reason).toBe("PERSISTENCE_FAILED");
      expect(h.startedTasks.length).toBe(1); // the fallback never reached a second attempt
    });
  });

  // --- Review round 1 regressions -------------------------------------------------------------

  test("the fallback preserves accumulated Gate diagnostics when it fires after a Gate-retry's OWN resume is rejected (review round 1, finding 1)", async () => {
    // `classifyBackendErrorCause`'s guard 1 is `SessionPlan.kind === "resume"` — it does not
    // distinguish a cross-turn resume (this describe block's other tests) from an INTRA-turn
    // resume Task 8's own Gate-retry branch builds (`session = {kind:"resume", sessionId,
    // promptDelta: folded}`, a few lines below in run-turn.ts). If the backend rejects THAT
    // resume too, the folded Gate diagnostics living in its `promptDelta` must not be silently
    // discarded when the fallback replaces `session` with a fresh plan.
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT); // attempt 1 (fresh) gets Gate-rejected
      const input = baseRunTurnInput();
      const runPromise = wrap(runTurn(h.deps, input));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1)); // sessionId "s1"

      // Task 8's own Gate-retry branch resumes attempt 1's session, carrying the fold in
      // `promptDelta` — confirmed here before the backend rejects THAT resume.
      await waitForStartCount(h, 2);
      const secondSession = h.startedTasks[1]?.session;
      if (secondSession?.kind !== "resume") throw new Error("expected a resume session plan");
      if (secondSession.promptDelta === null) throw new Error("expected a non-null promptDelta");
      const foldedDiagnostics = secondSession.promptDelta;
      expect(foldedDiagnostics).toContain("TS2322");

      // The backend rejects this INTRA-turn resume too — the fallback fires.
      completeAttempt(h, 2, {
        kind: "backend-error",
        message: "No conversation found with session ID: s1",
        sessionId: null,
        cause: "resume-rejected",
      });

      await waitForStartCount(h, 3);
      completeAttempt(h, 3, completedOutcome(3)); // the fallback's own fresh attempt, passes Gate

      const result = await wrap(runPromise);
      if (result.kind !== "finalized")
        throw new Error(`expected finalized, got ${JSON.stringify(result)}`);
      expect(result.result.kind).toBe("committed");

      // The fresh attempt's own session carries no `promptDelta` channel, so the diagnostics
      // that used to ride the now-discarded resume's `promptDelta` must reach the agent folded
      // onto `userMessage` instead — never silently lost.
      const thirdSession = h.startedTasks[2]?.session;
      if (thirdSession?.kind !== "fresh") throw new Error("expected a fresh session plan");
      expect(h.startedTasks[2]?.userMessage).toContain("TS2322");
      // Exact reconstruction, matching `appendPromptFold`'s own `${base}\n\n${fold}` shape.
      expect(h.startedTasks[2]?.userMessage).toBe(
        `${input.baseTask.userMessage}\n\n${foldedDiagnostics}`,
      );
    });
  });

  test("a fence exhaustion after a session fallback terminalizes GATE_RETRY_EXHAUSTED, not the generic PERSISTENCE_FAILED (review round 1, finding 2)", async () => {
    // `fence.ts`'s own attempt counter increments on EVERY `startTurnAttempt` call, independent
    // of this driver's local `attempt` bookkeeping — and the fallback deliberately leaves that
    // local counter unchanged so it never spends a Gate-retry slot. That means the fence's
    // independent hard `MAX_TURN_ATTEMPTS` (4) ceiling can run out ONE ATTEMPT BEFORE the local
    // counter's own `canRetryAfterGate` check expects it to. Reproduced here exactly: one
    // rejected resume (fence use #1) → the fallback's own fresh attempt (fence use #2) → three
    // Gate rejections in a row (fence uses #3 and #4, plus the local counter reaching 4) → a 5th
    // `startTurnAttempt` call the fence itself refuses.
    await context.start(async () => {
      const h = harness();
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT); // attempt 2 (the fallback's fresh attempt)
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT); // attempt 3
      h.gateRunner.queueRunPageResult(FAILING_PAGE_RESULT); // attempt 4
      const runPromise = wrap(runTurn(h.deps, inputWithResumePlan()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, RESUME_REJECTED_OUTCOME); // rejected resume -> fallback fires

      await waitForStartCount(h, 2);
      completeAttempt(h, 2, completedOutcome(2)); // fresh, Gate rejects it

      await waitForStartCount(h, 3);
      completeAttempt(h, 3, completedOutcome(3)); // resume, Gate rejects it

      await waitForStartCount(h, 4);
      completeAttempt(h, 4, completedOutcome(4)); // resume, Gate rejects it -- fence exhausted next

      const result = await wrap(runPromise);
      if (result.kind !== "terminalized")
        throw new Error(`expected terminalized, got ${JSON.stringify(result)}`);
      if (result.result.kind !== "recorded") throw new Error("expected recorded");
      // The honest code — not the generic `PERSISTENCE_FAILED` a raw, non-`OperationalFailureCode`
      // fence message ("attempt 5 exceeds the 4-attempt budget") would otherwise fall back to.
      expect(result.result.reason).toBe("GATE_RETRY_EXHAUSTED");
      // Never a 5th attempt: the fence refused it before `agentBackend.startTurn` was ever called.
      expect(h.startedTasks.length).toBe(4);
    });
  });
});
