import { describe, expect, test } from "bun:test";

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
  createFakeAgentRegistry,
  createFakeChatStore,
  createFakeDiagnosticsCache,
  createFakeExportPublish,
  createFakeExportRenderPort,
  createFakeGateRunner,
  createFakeHostSupervisorPort,
  createFakePageMetaCache,
  createFakePageStore,
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
import { DEFERRED_HANDLER_KINDS } from "./deferred";
import { createHandlerRegistry, totalHandlers } from "./index";
import type { HandlerContext, PreviewSourceKindV1, ProjectTrustV1 } from "./types";

function slug(value: string) {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

/** Matches `deferred.test.ts`'s own helper — see that file's comment. */
function buildDeps(): KernelDeps {
  const chatStore = createFakeChatStore();
  const pageStore = createFakePageStore({ order: [] });
  const pinStore = createFakePinStore();
  const clock: Clock = { now: () => new Date(1_700_000_000_000) };

  return {
    projectStore: createFakeProjectStore({ root: "/test-root" }),
    chatReader: chatStore,
    chatMutations: chatStore,
    pageReader: pageStore,
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

    return {
      deps: buildDeps(),
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

    for (const kind of COMMAND_KINDS_V1) {
      const outcome = registry(envelopeFor(kind, payloads[kind]));
      expect(outcome).toEqual({ disposition: "no-op", events: [] });
    }
  });

  test("the deferred kinds route through deferredHandlers, not the not-yet-implemented stand-in", () => {
    const registry = createHandlerRegistry(buildTestContext(), totalHandlers);
    const payloads = samplePayloads();

    for (const kind of DEFERRED_HANDLER_KINDS) {
      const outcome = registry(envelopeFor(kind, payloads[kind]));
      expect(outcome).toEqual({ disposition: "no-op", events: [] });
    }
  });

  test("migration.* — flagged as not-yet-implemented, not Tier-C deferred — still resolves to a well-formed no-op", () => {
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
