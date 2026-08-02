import { describe, expect, spyOn, test } from "bun:test";

import { context } from "@reatom/core";

import {
  reatomCommitStateMachine,
  reatomExportStateMachine,
  reatomMigrationStateMachine,
  reatomPreviewStateMachine,
  reatomProjectStateMachine,
  reatomRestoreStateMachine,
  reatomTurnStateMachine,
} from "core/machines";
import {
  createFakeAgentBackend,
  createFakeAgentPromptSource,
  createFakeAgentRegistry,
  createFakeChatStore,
  createFakeDesignStoreForPages,
  createFakeDiagnosticsCache,
  createFakeExportPublish,
  createFakeExportRenderPort,
  createFakeGateRunner,
  createFakeHostSupervisorPort,
  createFakePageMetaCache,
  createFakePinStore,
  createFakeProjectStore,
  createFakeProjectWriteCoordinator,
  createFakeRecoveryService,
  createFakeRenderCache,
  createFakeSessionCheckpointService,
  createFakeStagingService,
  createFakeTrustGate,
  createFakeTurnTransactionService,
} from "core/ports/fakes";
import {
  createFrameBroker,
  createFrameTokenLedger,
  createGeometryTokenLedger,
  createPreviewBackpressure,
  createPreviewSessionCommands,
} from "core/preview";
import { createPageRemovePlanLedger } from "core/project/model/page-remove-plan";
import {
  COMMAND_KINDS_V1,
  type CommandEnvelopeV1,
  type CommandKindV1,
  type CommandPayloadByKindV1,
  type UUIDv7,
} from "core/protocol";
import { parsePageSlug } from "entities/page";
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

import type { KernelDeps } from "../../types";
import { DEFERRED_HANDLER_KINDS, deferredHandlers } from "./deferred";
import { createHandlerRegistry, totalHandlers } from "./index";
import {
  type FamilyHandlerMap,
  type HandlerContext,
  type PreviewSourceKindV1,
  type ProjectTrustV1,
  noOpOutcome,
} from "./types";

function slug(value: string) {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

/** Matches `deferred.test.ts`'s own helper — see that file's comment. */
function buildDeps(): KernelDeps {
  const chatStore = createFakeChatStore();
  const pageStore = createFakeDesignStoreForPages({ pages: [] });
  const pinStore = createFakePinStore();
  const clock: Clock = { now: () => new Date(1_700_000_000_000) };

  return {
    projectStore: createFakeProjectStore({ root: "/test-root" }),
    chatReader: chatStore,
    chatMutations: chatStore,
    designReader: pageStore,
    pageMutations: pageStore,
    pinReader: pinStore,
    pinMutations: pinStore,
    turnTransactions: createFakeTurnTransactionService(),
    projectWrite: createFakeProjectWriteCoordinator(),
    staging: createFakeStagingService(),
    trustGate: createFakeTrustGate(),
    pageMetaCache: createFakePageMetaCache(),
    diagnosticsCache: createFakeDiagnosticsCache(),
    renderCache: createFakeRenderCache(),
    sessionCheckpoint: createFakeSessionCheckpointService(),
    recovery: createFakeRecoveryService(),
    gateRunner: createFakeGateRunner(),
    hostSupervisor: createFakeHostSupervisorPort(),
    exportRender: createFakeExportRenderPort(),
    exportPublish: createFakeExportPublish(),
    agentRegistry: createFakeAgentRegistry([createFakeAgentBackend()]),
    agentPromptSource: createFakeAgentPromptSource(),
    clock,
  };
}

function buildTestContext(): HandlerContext {
  return context.start(() => {
    let trust: ProjectTrustV1 = null;
    let activeTurnId: UUIDv7 | null = null;
    let commitIntentRecorded = false;
    let previewSourceKind: PreviewSourceKindV1 = null;

    const machines = {
      project: reatomProjectStateMachine(),
      turn: reatomTurnStateMachine(),
      restore: reatomRestoreStateMachine(),
      commit: reatomCommitStateMachine(),
      export: reatomExportStateMachine(),
      preview: reatomPreviewStateMachine(),
      migration: reatomMigrationStateMachine(),
    };
    const deps = buildDeps();
    const frameTokenLedger = createFrameTokenLedger();
    const geometryTokenLedger = createGeometryTokenLedger({ clock: deps.clock });

    return {
      deps,
      machines,
      readKernelState: () => ({
        project: { phase: machines.project.phase(), trust },
        turn: { phase: machines.turn.phase(), activeTurnId, commitIntentRecorded },
        restore: { phase: machines.restore.phase() },
        commit: { phase: machines.commit.phase() },
        export: { phase: machines.export.phase() },
        preview: { phase: machines.preview.phase(), sourceKind: previewSourceKind },
        migration: { phase: machines.migration.phase() },
      }),
      setProjectTrust: (next) => {
        trust = next;
      },
      setActiveTurnId: (next) => {
        activeTurnId = next;
      },
      setCommitIntentRecorded: (next) => {
        commitIntentRecorded = next;
      },
      setPreviewSourceKind: (next) => {
        previewSourceKind = next;
      },
      // Step A/B placeholder — no handler under test here calls either yet (both are
      // `notYetImplementedHandler`/`deferredHandlers` today); a real fake that runs `run()`
      // and captures a session is Step C's/the preview family's own test concern.
      setActivePreviewSession: () => {},
      launchOperation: () => {},
      publishOperationEvent: () => {},
      turnRunner: {
        machine: machines.turn,
        setActiveAttempt: () => {},
        activeAttempt: () => null,
      },
      exportRunner: { machine: machines.export },
      setSelection: () => {},
      selection: () => null,
      currentPreviewSession: () => null,
      currentPageDescriptors: () => [],
      previewSessionCommands: createPreviewSessionCommands({
        machine: machines.preview,
        hostSupervisor: deps.hostSupervisor,
        frameBroker: createFrameBroker(),
        frameTokenLedger,
        geometryTokenLedger,
        backpressure: createPreviewBackpressure(),
      }),
      frameTokenLedger,
      geometryTokenLedger,
      pageRemovePlanLedger: createPageRemovePlanLedger(),
    };
  });
}

/** One valid payload per `CommandKindV1`, matching `command-payload.ts`'s own schemas exactly. */
function samplePayloads(): { readonly [K in CommandKindV1]: CommandPayloadByKindV1[K] } {
  const home = slug("home");
  return {
    "project.create": {
      root: "/root",
      creationDefaults: { trust: "trusted", workspaceIdentity: "ws-1" },
      text: "hello",
    },
    "project.open": { root: "/root" },
    "project.retryOpen": { recovery: { kind: "restore", restoreActionId: uuidv7() } },
    "project.close": {},
    "project.setTrust": { trust: "trusted", workspaceIdentity: "ws-1" },
    "turn.start": { text: "hello" },
    "turn.cancel": { turnId: uuidv7() },
    "chat.create": {},
    "chat.switch": { chatId: uuidv7() },
    "model.select": { backend: "backend-1", model: "model-1", effort: "default" },
    "page.renameTitle": { pageSlug: home, title: "Home" },
    "page.removePlan": { pageSlug: home },
    "page.removeConfirm": { pageRemovePlanId: uuidv7() },
    "page.removeDiscardPlan": { pageRemovePlanId: uuidv7() },
    "page.reorder": { pageSlugs: [home] },
    "history.open": { pageSlug: home },
    "preview.selectPage": { pageSlug: home },
    "preview.selectHistorical": { pageSlug: home, sourceCommit: "a".repeat(40) },
    "preview.selectCurrent": { pageSlug: home },
    "preview.resize": { previewSessionId: uuidv7(), width: 80, height: 24 },
    "preview.setThemeCapabilities": {
      previewSessionId: uuidv7(),
      themeId: "default",
      terminalCapabilities: { colorDepth: 1 },
    },
    "preview.setMode": { previewSessionId: uuidv7(), mode: "static" },
    "preview.forwardInput": { previewSessionId: uuidv7(), input: { kind: "key", key: "a" } },
    "preview.setTweak": {
      previewSessionId: uuidv7(),
      tweakId: "tweak-1",
      value: { kind: "boolean", value: true },
    },
    "preview.queryGeometry": { frameToken: uuidv7(), query: { kind: "layout" } },
    "preview.retry": { previewSessionId: uuidv7() },
    "preview.close": { previewSessionId: uuidv7() },
    "selection.set": { pageSlug: home, elementId: "element-1" },
    "selection.clear": {},
    "pin.create": { geometryToken: uuidv7(), text: "note" },
    "pin.setStatus": { pinId: uuidv7(), status: "open" },
    "restore.plan": { pageSlug: home, sourceCommit: "a".repeat(40) },
    "restore.confirm": { restorePlanId: uuidv7(), overwriteAcknowledged: true },
    "restore.discardPlan": { restorePlanId: uuidv7() },
    "restore.retryRecord": { restoreActionId: uuidv7() },
    "commit.plan": { scope: "current-page" },
    "commit.confirm": { commitPlanId: uuidv7(), message: "message", warningAcknowledged: true },
    "commit.discardPlan": { commitPlanId: uuidv7() },
    "export.start": {},
    "migration.plan": {},
    "migration.confirm": { migrationPlanId: uuidv7(), acknowledged: true },
    "migration.discardPlan": { migrationPlanId: uuidv7() },
    "migration.retryRecovery": { migrationActionId: uuidv7() },
  };
}

function envelopeFor<K extends CommandKindV1>(
  kind: K,
  payload: CommandPayloadByKindV1[K],
): CommandEnvelopeV1<K> {
  return { protocolVersion: 1, commandId: uuidv7(), expectedRevision: "0", kind, payload };
}

describe("createHandlerRegistry", () => {
  test("assembles every one of the 43 CommandKindV1 members without throwing", () => {
    const registry = createHandlerRegistry(buildTestContext(), totalHandlers);
    const payloads = samplePayloads();

    expect(COMMAND_KINDS_V1.length).toBe(43);

    // Step C1 wired four real family maps (`chat`, `selection`+`model`, `project`,
    // `preview`+`export`) into `totalHandlers` — `project.create`/`project.open`, in
    // particular, legally admit from this fixture's fresh `closed` project phase and
    // return a REAL `"started"` outcome with its own admission event, not the uniform
    // no-op every kind returned before Step C1. This test's own job is still only "resolves
    // every kind without throwing" (never a claim about WHICH disposition each kind
    // returns — that is each family's own test file's job); asserting only shape here, not
    // a blanket `{disposition: "no-op", events: []}` equality, is what keeps this test
    // honest about that scope.
    //
    // A real dispatch pipeline never calls two handlers whose own preconditions conflict
    // back to back (the capability guard already enforces phase legality before `handle` is
    // ever reached) — but THIS test drives all 43 kinds in `COMMAND_KINDS_V1`'s own fixed
    // order against ONE shared, evolving `HandlerContext`, with no guard between them, purely
    // to prove every kind resolves. `project.create`'s own admission legitimately moves the
    // project machine out of the exact phase a LATER kind in this same fixed order expects
    // (`project.open`'s own `beginOpen`, `project.retryOpen`'s admission pair, `project.close`'s
    // `beginClose`) — each family's own defensive "illegal despite the guard confirming
    // legality" warning is expected, real project code, not a bug this loop should hide by
    // silently swallowing; `console.warn` is spied and suppressed only for this one test's own
    // duration, matching `kernel.test.ts`'s own "no stderr noise" precedent, and restored
    // immediately after.
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    for (const kind of COMMAND_KINDS_V1) {
      const outcome = registry(envelopeFor(kind, payloads[kind]));
      expect(["no-op", "completed", "started"]).toContain(outcome.disposition);
      expect(Array.isArray(outcome.events)).toBe(true);
    }
    warnSpy.mockRestore();
  });

  test("the 10 deferred kinds resolve to deferredHandlers' own function in totalHandlers — not merely an equal-looking stand-in", () => {
    // Output equality alone (`registry(...)` returning `{disposition: "no-op", events: []}`)
    // cannot prove ROUTING: `migrationPostMvpHandler` (`./index.ts`'s deliberately-post-MVP
    // refusal for the four `migration.*` kinds — see that file's own header) returns the
    // exact same well-formed no-op via the same `noOpOutcome()` call, so a test asserting
    // only the OUTCOME would pass identically whether `totalHandlers` wired a deferred kind
    // to `deferredHandlers` or accidentally left it on the migration stand-in. Function-
    // reference identity is differential: it fails the moment `./index.ts`'s `totalHandlers =
    // {...deferredHandlers, ...migrationPostMvpHandlers}` spread ever stops giving a deferred
    // kind `deferredHandlers`'s own handler.
    for (const kind of DEFERRED_HANDLER_KINDS) {
      expect(totalHandlers[kind]).toBe(deferredHandlers[kind]);
    }
  });

  test("migration.* — flagged deliberately post-MVP (task 18), not Tier-C deferred and not merely not-yet-built — still resolves to a well-formed no-op", () => {
    // MVP ships exactly one storage format version, so there is nothing to migrate FROM and
    // no second version to exercise a migration step against in a test (`./index.ts`'s own
    // header, and `docs/architecture/flows/migration.md`). `migrationPostMvpHandlers`
    // (`./index.ts`) still returns `noOpOutcome()` — the only typed refusal a handler's own
    // vocabulary has, since `HandlerOutcome` has no rejected disposition and the typed
    // `UnavailableReason` codes (`core/protocol/model/unavailable-reason.ts`) are a
    // guard/projector-only concern, never something a handler constructs.
    const registry = createHandlerRegistry(buildTestContext(), totalHandlers);
    const payloads = samplePayloads();

    const outcome = registry(envelopeFor("migration.plan", payloads["migration.plan"]));

    expect(outcome).toEqual({ disposition: "no-op", events: [] });
  });
});

describe("KernelMachines closed surface", () => {
  test("a handler cannot reach a machine's phaseAtom — only phase/apply/canApply are typed", () => {
    // This function is deliberately never called: the assertion under test is that the line
    // below FAILS TO COMPILE, not anything it returns at runtime. `KernelMachines` (`./types`)
    // types every machine as `HandlerMachine<Phase, Action>` (a `Pick` of `phase`/`apply`/
    // `canApply`), never the full `StateMachine`, so `phaseAtom` — the directly settable atom
    // `state-machine.ts` uses internally — is not a member a handler can even name. Before
    // that narrowing existed, `KernelMachines` typed every machine as the full `StateMachine`,
    // this line compiled cleanly, and the `@ts-expect-error` directive below was itself a
    // compile error ("Unused '@ts-expect-error' directive", TS2578) — proving red before green.
    const reachPhaseAtom = (context: HandlerContext) => {
      // @ts-expect-error — `phaseAtom` is not part of `KernelMachines`'s per-machine type; a
      // handler bypassing `apply()`'s transition-table legality check this way must not
      // type-check.
      return context.machines.project.phaseAtom;
    };
    expect(typeof reachPhaseAtom).toBe("function");
  });
});

describe("FamilyHandlerMap excludes Tier-C deferred kinds (fix round 2)", () => {
  /** Zero-arg stand-in, assignable to any `CommandHandler<K>` for any `K` — same shape as `./index.ts`'s own `migrationPostMvpHandler`. */
  const stubHandler = (): ReturnType<typeof noOpOutcome> => noOpOutcome();

  test('the 9 non-deferred preview kinds alone satisfy FamilyHandlerMap<"preview">', () => {
    // `CommandKindOfFamily<"preview">` has 11 members; 2 of them (`preview.forwardInput`,
    // `preview.setTweak`) are Tier-C deferred (`deferredHandlers` owns them). This literal
    // supplies exactly the OTHER 9 and type-checks as `FamilyHandlerMap<"preview">` with no
    // gaps and no excess keys — proving the type is precisely the 9-kind Step-B contract,
    // not all 11.
    const previewFamily: FamilyHandlerMap<"preview"> = {
      "preview.selectPage": stubHandler,
      "preview.selectHistorical": stubHandler,
      "preview.selectCurrent": stubHandler,
      "preview.resize": stubHandler,
      "preview.setThemeCapabilities": stubHandler,
      "preview.setMode": stubHandler,
      "preview.queryGeometry": stubHandler,
      "preview.retry": stubHandler,
      "preview.close": stubHandler,
    };

    expect(Object.keys(previewFamily)).toHaveLength(9);
  });

  test('a FamilyHandlerMap<"preview"> literal cannot name a Tier-C deferred preview kind', () => {
    // This function is deliberately never called — the assertion under test is that the
    // extra `preview.forwardInput` key below FAILS TO COMPILE, not anything returned at
    // runtime. Before fix round 2, `FamilyHandlerMap<F>` was `CommandHandlerMap<
    // CommandKindOfFamily<F>>` with no `Exclude`, so `FamilyHandlerMap<"preview">` had all
    // 11 preview kinds as known keys, this object literal type-checked cleanly, and the
    // `@ts-expect-error` directive below was itself a compile error ("Unused
    // '@ts-expect-error' directive", TS2578) — proving red before green.
    const buildOverreachingPreviewFamily = (): FamilyHandlerMap<"preview"> => {
      return {
        "preview.selectPage": stubHandler,
        "preview.selectHistorical": stubHandler,
        "preview.selectCurrent": stubHandler,
        "preview.resize": stubHandler,
        "preview.setThemeCapabilities": stubHandler,
        "preview.setMode": stubHandler,
        "preview.queryGeometry": stubHandler,
        "preview.retry": stubHandler,
        "preview.close": stubHandler,
        // @ts-expect-error — `preview.forwardInput` is Tier-C deferred; `FamilyHandlerMap<
        // "preview">` must not admit it as a known key, so a Step-B preview module cannot
        // un-defer it through its own object literal.
        "preview.forwardInput": stubHandler,
      };
    };

    expect(typeof buildOverreachingPreviewFamily).toBe("function");
  });
});
