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
  type FakeStagingService,
  type FakeTurnTransactionService,
  createFakeAgentBackend,
  createFakeGateRunner,
  createFakePinStore,
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
  readonly startedTasks: readonly (Omit<AgentTask, "fence"> & { readonly fence: unknown })[];
  readonly foldCalls: readonly TurnGateFoldInputV1[];
}

/**
 * Fresh fakes + a fresh turn machine per test — never shared across tests (matching every
 * sibling harness in this directory). `deadlines` defaults to the real `createTurnDeadlines`
 * bound to `clock`; the hardening tests below override it with `scriptedDeadlines` to drive
 * `check()` directly instead of through elapsed clock time.
 */
function harness(
  clock: Clock = manualClock(T0),
  deadlines: TurnDeadlines = createTurnDeadlines({ clock }),
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
    publish: (event) => published.push(event),
    foldGateDiagnosticsIntoPrompt: foldSpy,
  };

  return { deps, turnTransactions, staging, agentBackend, gateRunner, startedTasks, foldCalls };
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

      // The folded diagnostics actually reached the second attempt's own task.
      expect(h.startedTasks.length).toBe(2);
      expect(h.startedTasks[0]?.userMessage).toBe("please add a page");
      expect(h.startedTasks[1]?.userMessage).toContain("please add a page");
      expect(h.startedTasks[1]?.userMessage).toContain("Gate rejected the previous attempt");
      expect(h.startedTasks[1]?.userMessage).toContain("TS2322");

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
