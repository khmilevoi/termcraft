import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import {
  reatomCommitStateMachine,
  reatomExportStateMachine,
  reatomMigrationStateMachine,
  reatomPreviewStateMachine,
  reatomProjectStateMachine,
  reatomRestoreStateMachine,
  reatomTurnStateMachine,
} from "core/machines";
import type { PublishableEventV1 } from "core/mailbox";
import type {
  DesignSystemSource,
  DesignSystemSummaryV1,
  LocalPackageV1,
  PackageFileV1,
} from "core/ports";
import {
  type FakeDesignStore,
  type FakeDesignSystemInstall,
  type FakeGateRunner,
  createFakeAgentBackend,
  createFakeAgentPromptSource,
  createFakeAgentRegistry,
  createFakeChatStore,
  createFakeDesignStoreForPages,
  createFakeDesignSystemInstall,
  createFakeDesignSystemSource,
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
import type { EventKindV1, EventPayloadByKindV1, Sha256Hex, UUIDv7 } from "core/protocol";
import { type DesignSystemRef, parseDesignSystemRef } from "entities/design-system-ref";
import { validManifestObject } from "entities/design-system/model/manifest.fixture";
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

import type { KernelDeps } from "../../types";
import { designSystemHandlers } from "./design-system";
import {
  type HandlerContext,
  type PreviewSourceKindV1,
  type ProjectTrustV1,
  createDesignSystemInstallLedger,
} from "./types";

/**
 * `design-system.ts`'s own test suite (project-design-systems Wave 3 / P10, task 9). The
 * harness is MODELLED ON `preview-export.test.ts`'s/`page-pin.test.ts`'s own `buildTestContext`
 * shape (a real `HandlerContext` over `core/ports/fakes`, `launchOperation` recording rather
 * than invoking so a test drives `run()` by hand) — the task-9 brief's own snippets reference a
 * SHARED `harness.handlerContext` fixture, but no family test file in this codebase exports one
 * to import; every family builds its own, and this file follows the identical established
 * pattern rather than inventing a second shared-harness mechanism.
 *
 * DIVERGENCES FROM THE BRIEF'S PSEUDOCODE (adapt-don't-assume): `harness.source.systems = [...]`
 * and `harness.installPort.provenance = {...}` are property-assignment pseudocode; the REAL
 * fakes (`core/ports/fakes/design-system-source.ts`, `.../design-system-install.ts`) are
 * scriptable through `seed(summary, files)` and `seedProvenance(record)` instead, which this
 * file calls. `harness.source.fetchCalls`/`.publishCalls`/`.lastPublished` are NOT real fake
 * fields either — the real `FakeDesignSystemSource` only exposes an undifferentiated `calls`
 * log — so `createTrackedSource` below wraps it with three getters/an intercepted `publish`
 * derived from that same log, never a second, disconnected counter. `harness.gateRunner
 * .onRunTree`/`harness.onPublish` (the D7 test) become a shared `order: string[]` probe array
 * threaded through `buildTestContext`'s own options instead, mirroring `preview-export.test.ts`'s
 * `createGateRunnerWithFixtureClosures` wrapper precedent for scripting a fake's method.
 */

const NOW = "2024-06-01T12:00:00.000Z";
const HASH: Sha256Hex = "a".repeat(64);

const MIDNIGHT_REF_TEXT = "local:midnight@1.2.0";
const MIDNIGHT_REF: DesignSystemRef = (() => {
  const ref = parseDesignSystemRef(MIDNIGHT_REF_TEXT);
  if (ref instanceof Error) throw ref;
  return ref;
})();

const MIDNIGHT_SUMMARY: DesignSystemSummaryV1 = {
  id: "midnight",
  name: "Midnight",
  version: "1.2.0",
  kitApiVersion: 1,
  defaultTheme: "dark",
  defaultThemeTokens: [{ name: "background", value: "#0b0f14" }],
  componentNames: ["Button", "PageShell"],
};

const AURORA_SUMMARY: DesignSystemSummaryV1 = {
  id: "aurora",
  name: "Aurora",
  version: "2.0.0",
  kitApiVersion: 1,
  defaultTheme: "light",
  defaultThemeTokens: [{ name: "background", value: "#ffffff" }],
  componentNames: ["Button"],
};

/** `entities/design-system`'s own shared valid-manifest fixture, encoded as the package's `design-system.json` bytes. */
const MANIFEST_JSON = JSON.stringify(validManifestObject());
const BUTTON_SOURCE = "export const Button = () => null;";

function packageFilesFor(manifestJson: string): readonly PackageFileV1[] {
  return [
    { relPath: "design-system.json", bytes: new TextEncoder().encode(manifestJson) },
    { relPath: "components/Button.tsx", bytes: new TextEncoder().encode(BUTTON_SOURCE) },
  ];
}

/**
 * Wraps `createFakeDesignSystemSource` with the three read-back facts the brief's tests need
 * that the real fake does not expose directly (see this file's own header) — derived from the
 * SAME `calls`/`publish` the real fake already tracks, never a second, independent counter.
 */
function createTrackedSource(options: {
  readonly id: string;
  readonly label: string;
  readonly canPublish: boolean;
}) {
  const fake = createFakeDesignSystemSource(options);
  let lastPublished: LocalPackageV1 | null = null;
  return {
    ...fake,
    async publish(pkg: LocalPackageV1) {
      lastPublished = pkg;
      return fake.publish(pkg);
    },
    get fetchCalls(): number {
      return fake.calls.filter((call) => call.method === "fetch").length;
    },
    get publishCalls(): number {
      return fake.calls.filter((call) => call.method === "publish").length;
    },
    get lastPublished(): LocalPackageV1 | null {
      return lastPublished;
    },
  };
}

interface LaunchedOperation {
  readonly label: string;
  readonly run: () => Promise<readonly PublishableEventV1[]>;
}

interface TestHarness {
  readonly handlerContext: HandlerContext;
  readonly source: ReturnType<typeof createTrackedSource>;
  readonly installPort: FakeDesignSystemInstall;
  readonly quarantinePort: FakeDesignSystemInstall;
  readonly designReader: FakeDesignStore;
  publishedKinds(): readonly string[];
  lastPayload<K extends EventKindV1>(kind: K): EventPayloadByKindV1[K];
  settleOperations(): Promise<void>;
}

function buildTestContext(options?: {
  readonly source?: ReturnType<typeof createTrackedSource>;
  readonly gateRunner?: FakeGateRunner;
  readonly designReader?: FakeDesignStore;
  readonly isGranted?: (source: DesignSystemSource) => Promise<boolean>;
  /** D7's ordering probe — `publishOperationEvent` and the (possibly wrapped) `gateRunner.runTree` both push here, in real call order. */
  readonly order?: string[];
}): TestHarness {
  return context.start(() => {
    const clock: Clock = { now: () => new Date(NOW) };
    const source =
      options?.source ??
      createTrackedSource({ id: "local", label: "Local library", canPublish: true });
    const installPort = createFakeDesignSystemInstall();
    const gateRunner = options?.gateRunner ?? createFakeGateRunner();
    const designReader = options?.designReader ?? createFakeDesignStoreForPages({ pages: [] });
    const chatStore = createFakeChatStore();
    const pinStore = createFakePinStore();
    const projectStore = createFakeProjectStore({ root: "/test-root" });

    const deps: KernelDeps = {
      projectStore,
      chatReader: chatStore,
      chatMutations: chatStore,
      designReader,
      pageMutations: designReader,
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
      gateRunner,
      hostSupervisor: createFakeHostSupervisorPort(),
      exportRender: createFakeExportRenderPort(),
      exportPublish: createFakeExportPublish(),
      agentRegistry: createFakeAgentRegistry([createFakeAgentBackend()]),
      agentPromptSource: createFakeAgentPromptSource(),
      designSystemSource: source,
      designSystemQuarantine: installPort,
      designSystemInstall: installPort,
      designSystemIsGranted: options?.isGranted ?? (() => Promise.resolve(true)),
      clock,
    };

    const machines = {
      project: reatomProjectStateMachine(),
      turn: reatomTurnStateMachine(),
      restore: reatomRestoreStateMachine(),
      commit: reatomCommitStateMachine(),
      export: reatomExportStateMachine(),
      preview: reatomPreviewStateMachine(),
      migration: reatomMigrationStateMachine(),
    };
    let trust: ProjectTrustV1 = null;
    let activeTurnId: UUIDv7 | null = null;
    let commitIntentRecorded = false;
    let previewSourceKind: PreviewSourceKindV1 = null;
    const launched: LaunchedOperation[] = [];
    const publishedEvents: PublishableEventV1[] = [];
    let settledCount = 0;

    const frameTokenLedger = createFrameTokenLedger();
    const geometryTokenLedger = createGeometryTokenLedger({ clock });

    const handlerContext: HandlerContext = {
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
      setActivePreviewSession: () => {},
      launchOperation: (label, run) => {
        launched.push({ label, run });
      },
      publishOperationEvent: (event) => {
        publishedEvents.push(event);
        options?.order?.push(event.kind);
      },
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
      designSystemLedger: createDesignSystemInstallLedger(deps.designSystemQuarantine),
    };

    async function settleOperations(): Promise<void> {
      while (settledCount < launched.length) {
        const entry = launched[settledCount]!;
        settledCount += 1;
        const events = await wrap(entry.run());
        for (const event of events) publishedEvents.push(event);
      }
    }

    function publishedKinds(): readonly string[] {
      return publishedEvents.map((event) => event.kind);
    }

    /** Finds the LAST published event of `kind`, narrowing `.payload` with no `as` cast — mirrors `project.test.ts`'s own `findEvent`. */
    function lastPayload<K extends EventKindV1>(kind: K): EventPayloadByKindV1[K] {
      const matches = publishedEvents.filter(
        (event): event is PublishableEventV1<K> => event.kind === kind,
      );
      const last = matches.at(-1);
      if (last === undefined) throw new Error(`no "${kind}" event was published`);
      return last.payload;
    }

    return {
      handlerContext,
      source,
      installPort,
      quarantinePort: installPort,
      designReader,
      publishedKinds,
      lastPayload,
      settleOperations,
    };
  });
}

/** A `designReader` whose canonical tree ALSO carries a real `system/**` (for `designSystem.publish`'s own tests). */
function designReaderWithOwnSystem(): FakeDesignStore {
  return createFakeDesignStoreForPages({
    pages: [],
    extraFiles: new Map([
      ["system/design-system.json", { bytes: new TextEncoder().encode(MANIFEST_JSON) }],
      ["system/components/Button.tsx", { bytes: new TextEncoder().encode(BUTTON_SOURCE) }],
    ]),
  });
}

describe("designSystem.list", () => {
  test("designSystem.list returns `started` and publishes `designSystem.listed`", async () => {
    const harness = buildTestContext();
    const outcome = designSystemHandlers["designSystem.list"]({}, harness.handlerContext);
    expect(outcome.disposition).toBe("started");
    await harness.settleOperations();
    expect(harness.publishedKinds()).toEqual(["designSystem.listed"]);
  });

  test("designSystem.listed carries the update offer when the source has a different version", async () => {
    const harness = buildTestContext();
    harness.installPort.seedProvenance({ ref: MIDNIGHT_REF, contentHash: HASH, installedAt: NOW });
    harness.source.seed({ ...MIDNIGHT_SUMMARY, version: "1.3.0" }, packageFilesFor(MANIFEST_JSON));

    designSystemHandlers["designSystem.list"]({}, harness.handlerContext);
    await harness.settleOperations();

    expect(harness.lastPayload("designSystem.listed").update).toMatchObject({
      installedRef: "local:midnight@1.2.0",
      availableRef: "local:midnight@1.3.0",
    });
  });
});

describe("designSystem.preview", () => {
  test("D7: `designSystem.previewStarted` is published BEFORE runTree is awaited", async () => {
    const order: string[] = [];
    const baseGateRunner = createFakeGateRunner();
    const gateRunner: FakeGateRunner = {
      ...baseGateRunner,
      async runTree(input) {
        order.push("runTree");
        return baseGateRunner.runTree(input);
      },
    };
    const harness = buildTestContext({ gateRunner, order });
    harness.source.seed(MIDNIGHT_SUMMARY, packageFilesFor(MANIFEST_JSON));

    designSystemHandlers["designSystem.preview"](
      { ref: MIDNIGHT_REF_TEXT },
      harness.handlerContext,
    );
    await harness.settleOperations();

    expect(order.indexOf("designSystem.previewStarted")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("runTree")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("designSystem.previewStarted")).toBeLessThan(order.indexOf("runTree"));
  });

  test("a malformed ref is rejected without ever reaching the source", async () => {
    const harness = buildTestContext();

    designSystemHandlers["designSystem.preview"]({ ref: "not a ref" }, harness.handlerContext);
    await harness.settleOperations();

    expect(harness.publishedKinds()).toEqual([
      "designSystem.previewStarted",
      "designSystem.previewFailed",
    ]);
    expect(harness.source.fetchCalls).toBe(0);
  });

  test("a successful preview publishes `designSystem.previewed` carrying the installId, summary and a clean preview", async () => {
    const harness = buildTestContext();
    harness.source.seed(MIDNIGHT_SUMMARY, packageFilesFor(MANIFEST_JSON));

    designSystemHandlers["designSystem.preview"](
      { ref: MIDNIGHT_REF_TEXT },
      harness.handlerContext,
    );
    await harness.settleOperations();

    const previewed = harness.lastPayload("designSystem.previewed");
    expect(previewed.ref).toBe(MIDNIGHT_REF_TEXT);
    expect(previewed.summary.id).toBe("midnight");
    expect(previewed.preview.verdict).toBe("clean");
    expect(typeof previewed.installId).toBe("string");
  });

  test("a second preparation evicts and DISCARDS the first — no quarantine is leaked", async () => {
    const harness = buildTestContext();
    harness.source.seed(MIDNIGHT_SUMMARY, packageFilesFor(MANIFEST_JSON));
    harness.source.seed(AURORA_SUMMARY, packageFilesFor(MANIFEST_JSON));

    designSystemHandlers["designSystem.preview"](
      { ref: MIDNIGHT_REF_TEXT },
      harness.handlerContext,
    );
    await harness.settleOperations();
    const first = harness.lastPayload("designSystem.previewed").installId;

    designSystemHandlers["designSystem.preview"](
      { ref: "local:aurora@2.0.0" },
      harness.handlerContext,
    );
    await harness.settleOperations();

    expect(harness.quarantinePort.discarded).toContain(first);
  });
});

describe("designSystem.install", () => {
  test("designSystem.install commits the prepared installId and publishes `designSystem.installed`", async () => {
    const harness = buildTestContext();
    harness.source.seed(MIDNIGHT_SUMMARY, packageFilesFor(MANIFEST_JSON));

    designSystemHandlers["designSystem.preview"](
      { ref: MIDNIGHT_REF_TEXT },
      harness.handlerContext,
    );
    await harness.settleOperations();
    const installId = harness.lastPayload("designSystem.previewed").installId;

    designSystemHandlers["designSystem.install"]({ installId }, harness.handlerContext);
    await harness.settleOperations();

    expect(harness.publishedKinds()).toContain("designSystem.installed");
  });

  test("designSystem.install with an unknown installId FAILS rather than silently re-preparing", async () => {
    const harness = buildTestContext();

    designSystemHandlers["designSystem.install"]({ installId: uuidv7() }, harness.handlerContext);
    await harness.settleOperations();

    expect(harness.publishedKinds()).toEqual(["designSystem.installFailed"]);
    expect(harness.source.fetchCalls).toBe(0);
  });
});

describe("designSystem.publish", () => {
  test("designSystem.publish is refused when the source declares canPublish false", async () => {
    const harness = buildTestContext({
      source: createTrackedSource({ id: "local", label: "Local library", canPublish: false }),
      designReader: designReaderWithOwnSystem(),
    });

    designSystemHandlers["designSystem.publish"]({ sourceId: "local" }, harness.handlerContext);
    await harness.settleOperations();

    expect(harness.publishedKinds()).toEqual(["designSystem.publishFailed"]);
    expect(harness.source.publishCalls).toBe(0);
  });

  test("designSystem.publish sends the project's OWN system/**, package-relative", async () => {
    const harness = buildTestContext({ designReader: designReaderWithOwnSystem() });

    designSystemHandlers["designSystem.publish"]({ sourceId: "local" }, harness.handlerContext);
    await harness.settleOperations();

    expect(harness.source.lastPublished?.files.map((file) => file.relPath).sort()).toEqual([
      "components/Button.tsx",
      "design-system.json",
    ]);
  });

  test("a project with no design system cannot publish", async () => {
    // The default harness's `designReader` (`createFakeDesignStoreForPages({ pages: [] })`)
    // carries only `design/pages.json` — no `system/**` at all.
    const harness = buildTestContext();

    designSystemHandlers["designSystem.publish"]({ sourceId: "local" }, harness.handlerContext);
    await harness.settleOperations();

    expect(harness.publishedKinds()).toEqual(["designSystem.publishFailed"]);
    expect(harness.source.publishCalls).toBe(0);
  });
});
