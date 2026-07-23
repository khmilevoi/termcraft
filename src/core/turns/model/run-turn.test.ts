import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import { reatomTurnStateMachine } from "core/machines";
import type { AgentRunOutcome, AgentTask, GateRunResultV1, StagedTurnReadSetV1 } from "core/ports";
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
import { type PageSlug, parsePageSlug } from "entities/page";
import type { Clock } from "infrastructure/clock";

import type { AdmissionInputV1 } from "../types";
import { createTurnDeadlines } from "./deadlines";
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

function baseReadSet(): StagedTurnReadSetV1 {
  return {
    manifest: { sha256: "a".repeat(64), size: 10 },
    canonicalPages: [{ pageSlug: PAGE_HOME, snapshot: { sha256: "b".repeat(64), size: 20 } }],
    chat: { length: 100, prefixSha256: "c".repeat(64) },
    pins: [],
  };
}

function baseAdmission(): AdmissionInputV1 {
  return {
    targetChatId: "chat-1",
    text: "please add a page",
    candidatePins: [],
    workspace: {
      pages: [{ pageSlug: PAGE_HOME, sourcePath: "/fake/home.tsx" }],
      manifestSlice: new TextEncoder().encode("[]"),
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
    buildValidationInput: () => ({
      manifestText: "[]",
      pages: [{ pageSlug: PAGE_HOME, source: "export default function Home() {}" }],
    }),
    buildFinalizeInput: ({ turnId, attempt }) => ({
      changedPages: [{ pageSlug: PAGE_HOME, change: "replace" }],
      validatedPageSlugs: [PAGE_HOME],
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

/** Fresh fakes + a fresh turn machine per test — never shared across tests (matching every sibling harness in this directory). */
function harness(clock: Clock = manualClock(T0)): Harness {
  const machine = reatomTurnStateMachine();
  const pinReader = createFakePinStore();
  const turnTransactions = createFakeTurnTransactionService();
  const staging = createFakeStagingService();
  const agentBackend = createFakeAgentBackend();
  const gateRunner = createFakeGateRunner();
  const deadlines = createTurnDeadlines({ clock });
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
      const runPromise = wrap(runTurn(h.deps, baseRunTurnInput()));

      await waitForStartCount(h, 1);
      completeAttempt(h, 1, completedOutcome(1));

      const result = await wrap(runPromise);

      if (result.kind !== "finalized")
        throw new Error(`expected finalized, got ${JSON.stringify(result)}`);
      expect(result.result.kind).toBe("committed");
      expect(h.turnTransactions.calls.map((c) => c.method)).toEqual(["admit", "finalize"]);
      expect(h.staging.calls.map((c) => c.method)).toEqual([
        "createTurnWorkspace",
        "snapshotToCandidate",
      ]);
      expect(h.gateRunner.calls.map((c) => c.method)).toEqual(["runManifestSlice", "runPage"]);
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
        },
      ]);

      // The folded diagnostics actually reached the second attempt's own task.
      expect(h.startedTasks.length).toBe(2);
      expect(h.startedTasks[0]?.userMessage).toBe("please add a page");
      expect(h.startedTasks[1]?.userMessage).toContain("please add a page");
      expect(h.startedTasks[1]?.userMessage).toContain("Gate rejected the previous attempt");
      expect(h.startedTasks[1]?.userMessage).toContain("TS2322");

      // Two full validation passes: manifest-slice + one page, twice.
      expect(h.gateRunner.calls.map((c) => c.method)).toEqual([
        "runManifestSlice",
        "runPage",
        "runManifestSlice",
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
});
