import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import { reatomTurnStateMachine } from "core/machines";
import type { ChatReader, StagedTurnReadSetV1 } from "core/ports";
import {
  createFakePinStore,
  createFakeStagingService,
  createFakeTurnTransactionService,
} from "core/ports/fakes";
import type { FailureDtoV1 } from "core/protocol";
import { type PageSlug, parsePageSlug } from "entities/page";
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

import type { AdmissionInputV1 } from "../types";
import { type AdmissionDeps, runAdmission } from "./admission";
import { ReadSetTranslationError } from "./read-set";

/**
 * `runAdmission` end to end against 6D's fakes only — no real process, no real disk, no
 * real clock. ORDER IS THE CONTRACT: every precondition test asserts the run stops exactly
 * where it should and that a LATER port is never even attempted (matching
 * `open-sequence.test.ts`'s own style for the identical reason).
 *
 * Every test body lives inside ONE `context.start(async () => {...})` call, and
 * `runAdmission(...)`'s own call is `await wrap(...)`-ed — the same reatom binding-rule
 * reason `open-sequence.test.ts`'s header documents: a plain unwrapped `await` here would
 * resume outside the context that `reatomTurnStateMachine()`'s atoms were created in.
 */

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const PAGE_HOME = slug("home");
const PAGE_GONE = slug("gone");

const T0 = 1_700_000_000_000;

/**
 * Minted once per test run — `AdmissionInputV1.turnId` is now the CALLER's job (fix-bundle
 * spec §1.2, `../types.ts`'s own header), never `runAdmission`'s. Every test below plays the
 * caller's part itself: it applies `beginAdmission` on the harness's own machine BEFORE
 * calling `runAdmission`, exactly like `core/kernel/model/handlers/turn.ts`'s `beginTurn`
 * does in production.
 */
const TURN_ID = uuidv7();

function manualClock(startMs: number): Clock {
  return { now: () => new Date(startMs) };
}

const FAILURE: FailureDtoV1 = {
  code: "PERSISTENCE_FAILED",
  retryable: false,
  safeMessage: "boom",
  details: {},
};

/**
 * `chat` is deliberately absent — `AdmissionWorkspaceMaterialV1.readSet` (`../types.ts`'s
 * own header) excludes it: the honest chat append-base is read by `runAdmission` itself,
 * from its own `chatReader` dependency, right after `admit()` commits — never supplied by
 * the caller. `harness()`'s `chatReader` (below) is this suite's own source for it.
 */
function baseReadSet(): Omit<StagedTurnReadSetV1, "chat"> {
  return {
    manifest: { sha256: "a".repeat(64), size: 10 },
    // `relPath` deliberately unrelated to any page slug — `designFiles` is keyed by
    // TREE-relative path, not page identity.
    designFiles: [
      { relPath: "screens/landing.tsx", snapshot: { sha256: "b".repeat(64), size: 20 } },
    ],
    pins: [{ pageSlug: PAGE_HOME, base: { length: 5, prefixSha256: "d".repeat(64) } }],
  };
}

/** The honest post-admission chat append-base `harness()`'s default `chatReader` reports. */
const FRESH_CHAT_APPEND_BASE = { length: 42, prefixSha256: "f".repeat(64) };

/**
 * A minimal `Pick<ChatReader, "readAppendBase">` double — this suite only ever needs the
 * one method `AdmissionDeps.chatReader` declares, and only ever for `targetChatId`
 * `"chat-1"` (`baseInput()`'s own fixture), so a full `ChatReader`/`FakeChatStore` (whose
 * `create()` mints an unrelated id) would add fixture ceremony this suite does not need.
 * `calls` (chat ids, in call order) lets a test prove exactly WHEN this ran relative to
 * `turnTransactions.calls`/`staging.calls` — the whole point of the ordering this file's
 * header, step 1b, documents.
 */
function fakeChatAppendBaseReader(
  result: FailureDtoV1 | typeof FRESH_CHAT_APPEND_BASE = FRESH_CHAT_APPEND_BASE,
): Pick<ChatReader, "readAppendBase"> & { readonly calls: readonly string[] } {
  const calls: string[] = [];
  return {
    calls,
    readAppendBase: async (chatId: string) => {
      calls.push(chatId);
      return result;
    },
  };
}

function baseInput(overrides: Partial<AdmissionInputV1> = {}): AdmissionInputV1 {
  return {
    turnId: TURN_ID,
    targetChatId: "chat-1",
    text: "hello",
    candidatePins: [],
    workspace: {
      treeFiles: [{ relPath: "screens/landing.tsx", sourcePath: "/fake/landing.tsx" }],
      runtimeDocs: [],
      readSet: baseReadSet(),
    },
    ...overrides,
  };
}

/** Fresh fakes + a fresh turn machine per test — never shared across tests. */
function harness(
  clock: Clock = manualClock(T0),
  chatReader: Pick<ChatReader, "readAppendBase"> = fakeChatAppendBaseReader(),
) {
  const machine = reatomTurnStateMachine();
  const pinReader = createFakePinStore();
  const turnTransactions = createFakeTurnTransactionService();
  const staging = createFakeStagingService();
  const deps: AdmissionDeps = { machine, clock, pinReader, turnTransactions, staging, chatReader };
  return { deps, machine, pinReader, turnTransactions, staging, chatReader };
}

describe("runAdmission — idle -> admitting -> workspace-ready", () => {
  test("is entered already admitting — the caller owns the transition (spec §1.2)", async () => {
    await context.start(async () => {
      const h = harness();
      h.machine.apply("beginAdmission"); // the caller's own beginTurn already applied this

      const outcome = await wrap(runAdmission(h.deps, baseInput()));

      expect(outcome.kind).toBe("workspace-ready");
      if (outcome.kind !== "workspace-ready") return;
      expect(outcome.context.turnId).toBe(TURN_ID);
      expect(h.machine.phase()).toBe("workspace-ready");
    });
  });

  test("captures chat/selection, commits BEFORE creating the workspace, and reaches workspace-ready using the CALLER-supplied turnId — it is no longer minted here (spec §1.2)", async () => {
    await context.start(async () => {
      const chatReader = fakeChatAppendBaseReader();
      const h = harness(manualClock(T0), chatReader);
      h.machine.apply("beginAdmission");
      const selection = { pageSlug: PAGE_HOME, element: "btn-1" };

      const input = baseInput({ selection });
      const outcome = await wrap(runAdmission(h.deps, input));
      if (outcome.kind !== "workspace-ready")
        throw new Error(`expected workspace-ready, got ${outcome.kind}`);

      expect(outcome.context.turnId).toBe(TURN_ID);
      expect(outcome.context.targetChatId).toBe("chat-1");
      expect(outcome.context.userRecord.turnId).toBe(outcome.context.turnId);
      expect(outcome.context.userRecord.selection).toEqual(selection);
      expect(outcome.context.userRecord.text).toBe("hello");

      // Order: admit committed BEFORE the workspace was created.
      expect(h.turnTransactions.calls.length).toBe(1);
      expect(h.turnTransactions.calls[0]).toMatchObject({
        method: "admit",
        input: { turnId: outcome.context.turnId, targetChatId: "chat-1" },
      });
      // The record the PORT received, not merely the in-memory echo the caller got back.
      // Asserting only outcome.context.userRecord leaves the durable side unprotected:
      // stripping text/selection/pins from the record handed to admit passes otherwise, and
      // TD §7.2 step 3 is explicit that this record must "commit it fully".
      const admitCall = h.turnTransactions.calls[0];
      if (admitCall?.method !== "admit") throw new Error("expected an admit call");
      expect(admitCall.input.userRecord).toEqual(outcome.context.userRecord);

      expect(h.staging.calls.length).toBe(1);
      const stagingCall = h.staging.calls[0];
      if (stagingCall?.method !== "createTurnWorkspace")
        throw new Error("expected createTurnWorkspace");
      // Every staged design-tree file (`design/pages.json` included — it is a real staged
      // file now, not a synthesized slice), RUNTIME.md, and runtime type declarations —
      // asserting only the method name would let admission stage an entirely empty
      // workspace and launch the agent against no design sources.
      expect(stagingCall.input.treeFiles).toEqual(input.workspace.treeFiles);
      expect(stagingCall.input.runtimeDocs).toEqual(input.workspace.runtimeDocs);

      // The CAS basis carried forward is a faithful translation of the staged read set —
      // a dropped entry here silently weakens the pre-intent comparison (read-set.ts's header).
      // `chat` comes from `h.chatReader` — read HONESTLY, AFTER `admit()` (this file's header,
      // step 1b) — never from the caller's own (chat-less) `input.workspace.readSet`.
      expect(outcome.context.readSet.chat).toEqual(FRESH_CHAT_APPEND_BASE);
      expect(outcome.context.readSet.pins.get(PAGE_HOME)).toEqual(baseReadSet().pins[0]?.base);
      // The read happened for the right chat, exactly once, and the workspace was staged
      // with that SAME fresh value — not the caller's own stale-by-construction guess.
      expect(chatReader.calls).toEqual(["chat-1"]);
      expect(stagingCall.input.readSet.chat).toEqual(FRESH_CHAT_APPEND_BASE);

      expect(h.machine.phase()).toBe("workspace-ready");
      // The fence is minted, but attempt 1 is never begun here.
      expect(outcome.context.fence.currentLease()).toBeNull();
      expect(typeof outcome.context.admissionCommit.transactionId).toBe("string");
    });
  });

  test("a cancel that races admission: retires the staged workspace and reports the user record as already committed", async () => {
    await context.start(async () => {
      const h = harness();
      h.machine.apply("beginAdmission");

      // The race: `requestCancel` is legal from `admitting` (`turn-machine.ts`), and admission's
      // own work is a long chain of awaits, so a user pressing Esc lands here routinely. Driven
      // from inside `createTurnWorkspace` so the cancel falls in the real window — after the user
      // record has durably committed, before `finishAdmission`.
      const originalCreate = h.staging.createTurnWorkspace.bind(h.staging);
      const cancelKinds: string[] = [];
      h.staging.createTurnWorkspace = (input) => {
        // Applied SYNCHRONOUSLY, before delegating: a `machine.apply` after an `await` would
        // resume outside this test's own `context.start(...)` frame and land on a different atom
        // instance (this file's own header states the rule). The window is the same either way —
        // `admit()` has already committed, `finishAdmission` has not run yet.
        cancelKinds.push(h.machine.apply("requestCancel").kind);
        return originalCreate(input);
      };

      const outcome = await wrap(runAdmission(h.deps, baseInput()));

      expect(cancelKinds).toEqual(["changed"]); // the fixture really did cancel mid-admission
      if (outcome.kind !== "illegal") throw new Error(`expected illegal, got ${outcome.kind}`);
      // The user's message IS on disk — `admit` ran long before this. Saying otherwise put a
      // "could not be admitted" record in the chat directly under the admitted message.
      expect(outcome.userRecordCommitted).toBe(true);
      expect(h.turnTransactions.calls.some((call) => call.method === "admit")).toBe(true);

      // And the workspace this admission created is retired rather than leaked — before the fix
      // nothing in production ever called `retireWorkspace`.
      expect(h.staging.calls.map((call) => call.method)).toEqual([
        "createTurnWorkspace",
        "retireWorkspace",
      ]);
    });
  });

  test("createdAt/ts come from the injected clock, never wall time", async () => {
    await context.start(async () => {
      const h = harness(manualClock(T0));
      h.machine.apply("beginAdmission");
      const outcome = await wrap(runAdmission(h.deps, baseInput()));
      if (outcome.kind !== "workspace-ready")
        throw new Error(`expected workspace-ready, got ${outcome.kind}`);

      const expectedTs = new Date(T0).toISOString();
      expect(outcome.context.userRecord.ts).toBe(expectedTs);
      expect(h.turnTransactions.calls[0]).toMatchObject({ input: { createdAt: expectedTs } });
    });
  });

  test("no selection and no captured pins: both optional fields are OMITTED, not present as empty/null", async () => {
    await context.start(async () => {
      const h = harness();
      h.machine.apply("beginAdmission");
      const outcome = await wrap(runAdmission(h.deps, baseInput()));
      if (outcome.kind !== "workspace-ready")
        throw new Error(`expected workspace-ready, got ${outcome.kind}`);

      expect(outcome.context.userRecord.selection).toBeUndefined();
      expect(outcome.context.userRecord.pins).toBeUndefined();
    });
  });

  test("committed user-record precondition: admit failure blocks phase 'admit'; workspace is NEVER attempted; machine stays admitting", async () => {
    await context.start(async () => {
      const h = harness();
      h.machine.apply("beginAdmission");
      h.turnTransactions.failNext("admit", FAILURE);

      const outcome = await wrap(runAdmission(h.deps, baseInput()));

      expect(outcome).toEqual({ kind: "blocked", phase: "admit", failure: FAILURE });
      expect(h.staging.calls).toEqual([]);
      // The exit from `admitting` belongs to the caller now (spec §1.3) — asserted end to end in
      // `core/kernel/model/handlers/turn.test.ts`'s "a rejected admission" describe block.
      expect(h.machine.phase()).toBe("admitting");
    });
  });

  test("honest chat-append-base precondition: a chatReader failure blocks phase 'chat-append-base' AFTER admission already committed and BEFORE the workspace is ever attempted; machine stays admitting", async () => {
    // This is the exact fix for the production bug the §10 smoke closeout found: an
    // earlier version of this composition read the chat append base BEFORE `admit()` (one
    // level up, in `core/kernel/model/handlers/turn.ts`), which is stale by construction on
    // every real turn. This test pins the CORRECT ordering: read AFTER admit, BEFORE
    // staging — and proves a failure here is a distinct, honestly-reported precondition,
    // never silently folded into `"admit"` or `"workspace"`.
    await context.start(async () => {
      const chatFailure: FailureDtoV1 = {
        code: "PERSISTENCE_FAILED",
        retryable: false,
        safeMessage: "chat append base unreadable",
        details: {},
      };
      const h = harness(manualClock(T0), fakeChatAppendBaseReader(chatFailure));
      h.machine.apply("beginAdmission");

      const outcome = await wrap(runAdmission(h.deps, baseInput()));

      expect(outcome).toEqual({ kind: "blocked", phase: "chat-append-base", failure: chatFailure });
      // Admission already committed — the workspace is what never gets attempted.
      expect(h.turnTransactions.calls.length).toBe(1);
      expect(h.turnTransactions.calls[0]?.method).toBe("admit");
      expect(h.staging.calls).toEqual([]);
      // The exit from `admitting` belongs to the caller now (spec §1.3) — asserted end to end in
      // `core/kernel/model/handlers/turn.test.ts`'s "a rejected admission" describe block.
      expect(h.machine.phase()).toBe("admitting");
    });
  });

  test("verified-workspace precondition: workspace failure blocks phase 'workspace' AFTER admission already committed; machine stays admitting", async () => {
    await context.start(async () => {
      const h = harness();
      h.machine.apply("beginAdmission");
      h.staging.failNext("createTurnWorkspace", FAILURE);

      const outcome = await wrap(runAdmission(h.deps, baseInput()));

      expect(outcome).toEqual({ kind: "blocked", phase: "workspace", failure: FAILURE });
      expect(h.turnTransactions.calls.length).toBe(1);
      expect(h.turnTransactions.calls[0]?.method).toBe("admit");
      // The exit from `admitting` belongs to the caller now (spec §1.3) — asserted end to end in
      // `core/kernel/model/handlers/turn.test.ts`'s "a rejected admission" describe block.
      expect(h.machine.phase()).toBe("admitting");
    });
  });

  test("complete-read-set-hashes precondition: a duplicate design file path blocks phase 'read-set' AFTER both admit and workspace succeeded; machine stays admitting", async () => {
    await context.start(async () => {
      const h = harness();
      h.machine.apply("beginAdmission");
      const duplicatedReadSet: Omit<StagedTurnReadSetV1, "chat"> = {
        ...baseReadSet(),
        designFiles: [
          { relPath: "screens/landing.tsx", snapshot: { sha256: "b".repeat(64), size: 20 } },
          { relPath: "screens/landing.tsx", snapshot: { sha256: "e".repeat(64), size: 30 } },
        ],
      };
      const input = baseInput({
        workspace: { ...baseInput().workspace, readSet: duplicatedReadSet },
      });

      const outcome = await wrap(runAdmission(h.deps, input));

      if (outcome.kind !== "blocked" || outcome.phase !== "read-set") {
        throw new Error(`expected blocked/read-set, got ${JSON.stringify(outcome)}`);
      }
      expect(outcome.error).toBeInstanceOf(ReadSetTranslationError);
      expect(h.turnTransactions.calls.length).toBe(1);
      expect(h.staging.calls.length).toBe(1);
      // The exit from `admitting` belongs to the caller now (spec §1.3) — asserted end to end in
      // `core/kernel/model/handlers/turn.test.ts`'s "a rejected admission" describe block.
      expect(h.machine.phase()).toBe("admitting");
    });
  });

  test("an unresolvable candidate pin is simply absent from the captured set — never written, never fatal", async () => {
    await context.start(async () => {
      const h = harness();
      h.machine.apply("beginAdmission");
      // Seed page "home" with one open pin and one already-resolved pin. `await wrap(...)` —
      // not a plain `await` — on every one of these: a plain unwrapped await here resumes
      // outside this test's own `context.start(...)` frame, so the LATER `wrap(runAdmission(...))`
      // call below would apply `finishAdmission` against a drifted context that never saw the
      // `beginAdmission` applied just above (this file's own header states the identical rule
      // for `admission.ts` itself).
      await wrap(
        h.pinReader.appendStandaloneEvent(PAGE_HOME, {
          kind: "pin:created",
          recordId: "rec-1",
          pinId: "pin-open",
          element: "el-1",
          fx: 0.1,
          fy: 0.2,
          text: "note",
          ts: new Date(T0).toISOString(),
        }),
      );
      await wrap(
        h.pinReader.appendStandaloneEvent(PAGE_HOME, {
          kind: "pin:created",
          recordId: "rec-2",
          pinId: "pin-resolved",
          element: "el-2",
          fx: 0.3,
          fy: 0.4,
          text: "note",
          ts: new Date(T0).toISOString(),
        }),
      );
      await wrap(
        h.pinReader.appendStandaloneEvent(PAGE_HOME, {
          kind: "pin:status",
          recordId: "rec-3",
          pinId: "pin-resolved",
          status: "resolved",
          turnId: "some-other-turn",
          ts: new Date(T0).toISOString(),
        }),
      );
      // Page "gone" will have its fold FAIL entirely — its candidate must still be dropped,
      // never propagated as an admission failure.
      h.pinReader.failNext("fold", FAILURE);

      const input = baseInput({
        candidatePins: [
          // "gone" listed FIRST so it is the first distinct page folded, consuming the
          // injected failure — "home"'s fold below runs the real, successful fold.
          { pageSlug: PAGE_GONE, pinId: "pin-x" },
          { pageSlug: PAGE_HOME, pinId: "pin-open" },
          { pageSlug: PAGE_HOME, pinId: "pin-resolved" },
          { pageSlug: PAGE_HOME, pinId: "pin-missing" },
        ],
      });

      const outcome = await wrap(runAdmission(h.deps, input));
      if (outcome.kind !== "workspace-ready")
        throw new Error(`expected workspace-ready, got ${JSON.stringify(outcome)}`);

      // Only the legitimately open pin survives. Nothing about the other three candidates
      // was captured or written anywhere.
      expect(outcome.context.userRecord.pins).toEqual(["pin-open"]);
      // Exactly one fold call per DISTINCT page, regardless of how many candidates named it.
      expect(h.pinReader.calls.filter((call) => call.method === "fold").length).toBe(2);
    });
  });
});
