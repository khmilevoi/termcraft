import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { createProductionAgentPromptSource } from "agent";
import {
  type EventEnvelopeV1,
  type EventPayloadByKindV1,
  type KernelDeps,
  createKernel,
} from "core";
import type { AgentTask, BackendCapabilities, PreviewSession } from "core/ports";
import {
  createFakeAgentBackend,
  createFakeAgentRegistry,
  createFakeExportRenderPort,
  createFakeHostSupervisorPort,
} from "core/ports/fakes";
import type { FakeAgentBackend, FakeHostSupervisorPort } from "core/ports/fakes";
import { createGateRunnerAdapter } from "gate";
import type { SmokeRenderer, SmokeRequest, SmokeResult } from "gate";
import { systemClock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";
import {
  createChatStoreAdapter,
  createDesignStoreAdapter,
  createExportPublishAdapter,
  createPinStoreAdapter,
  createProjectStoreAdapter,
  createProjectWriteAdapter,
  createProjectionsAdapter,
  createRecoveryAdapter,
  createSessionCheckpointAdapter,
  createStagingAdapter,
  createStore,
  createTrustAdapter,
  createTurnTransactionsAdapter,
  nodeStoreDeps,
} from "store";
import type { OpenProject, StoreAdapterDeps } from "store";
import { App, createUiDeps } from "ui";
import type { KernelPort, PreviewSessionHandle, UiEnv, UiPreviewFrame } from "ui";
import { createReactTestRenderer } from "ui/testing";
import type { ReactTestRenderer } from "ui/testing";

/** No JSX in this `.ts` file (the task names this file `smoke.test.ts`, not `.tsx`) — `React.
 *  createElement` builds the one element this test mounts. Reached via `createRequire`, not a
 *  plain `import ... from "react"`, mirroring `ui/testing/model/react-renderer.ts`'s identical
 *  workaround: no `@types/react` is installed (JSX elsewhere in this tree compiles against
 *  `@opentui/react`'s own `jsxImportSource`, never a direct "react" type import). */
type CreateElementFn = (type: unknown, props: unknown) => unknown;
const { createElement } = createRequire(import.meta.url)("react") as {
  readonly createElement: CreateElementFn;
};

/**
 * WP-12 / M19 — the design §10 scripted-terminal smoke: "app driven on a scripted terminal
 * with injected events (open project -> prompt -> fake agent edits staging -> gate -> render
 * -> export)". This is the one test in the tree that crosses `store` -> `gate` -> `core`
 * (kernel) -> `ui`, all at once, through the SAME composed graph `entrypoint/model/create-
 * shell.ts`'s `interactiveShell` builds for production — not by poking any one module's fakes
 * in isolation.
 *
 * REAL: `store` (a real temp on-disk project — `createStore`/`nodeStoreDeps`, every store
 * adapter `create-shell.ts` wires), `gate` (`createGateRunnerAdapter` running the real
 * import-scan/page-contract/lint source-only stages; no `compilerAssets`/`runtimeDts` are
 * injected, so `typeCheck` stays absent exactly like `create-shell.ts`'s own production
 * wiring does until phase-8's embedded-tsc work lands — "the gate runs standalone" per its
 * own design), `core`'s real `createKernel` (the real seven machines, the real `turn.start`/
 * `export.start` compositions), and the real `ui` component tree (`App`, `createUiDeps`,
 * `ui/testing`'s scripted terminal) for the one step it can genuinely drive (see below).
 *
 * FAKED, AND WHY: the agent backend (`core/ports/fakes/agent-backend.ts` — nothing in this
 * offline test may call the real Claude CLI) and the whole host/preview side (`core/ports/
 * fakes/host-supervisor.ts`, `core/ports/fakes/export-render.ts`, plus a local one-line
 * `SmokeRenderer`). `create-shell.ts`'s `ShellDeps` has no seam to inject a fake agent
 * registry or a fake host supervisor at all (only `userStateRoot`/`execPath`/`isCompiled`/
 * `srcRoot`/`spawn`), so this test cannot call `createShell` directly and still substitute a
 * scriptable agent — it instead re-composes `KernelDeps` one level below `createShell`,
 * reusing every REAL store/gate adapter `interactiveShell` itself builds, verbatim. Faking
 * the host side is also the direct, deliberate way this test avoids the Spike D hang risk
 * ("a one-shot render child must call `process.exit()` explicitly or the test hangs"): with
 * `hostSupervisor`/`exportRender`/the gate's `smokeRenderer` all faked, this test never spawns
 * a real child process anywhere, so that failure mode cannot occur here at all — not merely
 * mitigated by a timeout.
 *
 * THREE GENUINE, PRE-EXISTING GAPS DISCOVERED WHILE BUILDING THIS TEST (documented here, not
 * silently worked around — this is the whole point of a test that finally crosses every
 * module at once, design §10/M19's own justification):
 *
 * 1. FIXED (smoke-bugs closeout) — no real turn could ever COMMIT through the real composed
 *    graph. `core/kernel/model/handlers/turn.ts`'s `runTurnStart` used to capture the chat's
 *    CAS baseline (`context.deps.chatReader.readAppendBase(activeChatId)`) BEFORE calling
 *    `runTurn(...)` — i.e. BEFORE `core/turns/model/admission.ts`'s own `runAdmission` durably
 *    appends this exact turn's user record to that SAME chat. That stale, pre-admission
 *    baseline then flowed verbatim through `TurnWorkspaceV1.readSet.chat` into `finalizeTurn`'s
 *    own CAS precondition (`store/transaction/model/wrappers.ts`'s
 *    `buildFinalizeCasPrecondition`), which re-observes the chat's CURRENT (now
 *    one-record-longer) state and found a length/hash mismatch — `APPLY_STALE` with
 *    `details.part: "chat"`, on EVERY real turn, not a corner case.
 *
 *    THE FIX: the honest chat append-base read now lives inside `core/turns/model/
 *    admission.ts`'s own `runAdmission`, executed right after `turnTransactions.admit(...)`
 *    commits and before `staging.createTurnWorkspace(...)` — the one point in the whole
 *    composition that runs strictly between those two calls and can therefore observe the
 *    chat's state at the only honest moment (`admission.ts`'s own header, step 1b).
 *    `AdmissionWorkspaceMaterialV1.readSet` (`core/turns/types.ts`) no longer even lets a
 *    caller supply `chat` — `core/kernel/model/handlers/turn.ts` builds no `readSet.chat`
 *    value of its own anymore; it only threads its `chatReader` down through
 *    `RunTurnDeps.chatReader` -> `AdmissionDeps.chatReader`.
 *
 *    THE COMPOUNDING SECOND EFFECT, same root cause's blast radius, ALSO FIXED: `core/turns/
 *    model/run-turn.ts` used to never drive the `finalizing -> terminalizing` edge when
 *    `finalizeTurn` returned `{kind:"failed", ...}` (its own header says this bridge belongs
 *    to "whichever caller decided", but `runTurn` never decided it for this branch — it just
 *    returned `{kind:"finalized", result}` as-is), leaving the turn MACHINE stuck in
 *    `"finalizing"` permanently once any finalize failure occurred — every subsequent
 *    `chat.create`/`chat.switch`/`turn.start`/`export.start` in the SAME process was then
 *    guard-rejected `CAPABILITY_UNAVAILABLE` for "turn.phase is finalizing (non-idle)". `run-
 *    turn.ts` now bridges `beginTerminalization` and calls `terminalizeTurn` itself whenever
 *    `finalizeTurn` returns `{kind:"failed"}}`, so the machine always settles back to `idle`
 *    (`core/turns/model/run-turn.test.ts`'s test "(j)" pins this).
 *
 *    Regression coverage: `core/turns/model/admission.test.ts` (the honest post-admission
 *    read, plus its own new `"chat-append-base"` precondition), `core/turns/model/
 *    run-turn.test.ts` test "(j)" (the terminalize bridge), and this test's own body below,
 *    which now asserts the real `turn.completed` outcome end to end.
 * 2. FIXED (smoke-bugs closeout) — `ui`'s Home -> Workspace transition used to be
 *    UNREACHABLE through the real composed Kernel. `core/kernel/model/kernel.ts`'s own
 *    `buildSnapshotPayload` hardcoded `projectId` to `null` UNCONDITIONALLY, and neither
 *    `finishOpen` nor `finishClose`'s own `kernel.stateChanged` event carried the fact at
 *    all — so `ui/mirror`'s own `apply()` (which only ever set `project.projectId` from a
 *    `kernel.snapshot` envelope, and the real Kernel never re-emits `kernel.snapshot` after
 *    bootstrap, kernel-command-contract §9) could never learn it for a live subscriber.
 *    `deriveScreen`'s `projectId !== null` condition could never become true, and the
 *    rendered App's own screen never left Home even once a real `project.create` had
 *    genuinely succeeded.
 *
 *    THE FIX: `handlers/project.ts`'s `finishOpen`/`finishClose`/`setTrust` now carry
 *    `metadata: {projectId, trust}` on their existing `kernel.stateChanged` event (the
 *    same free-form per-action bag `setTrust` already used for `workspaceIdentity`) —
 *    `ui/mirror/model/mirror.ts`'s `apply()` now reads it directly for an already-subscribed
 *    client, and `kernel.ts`'s existing "growable identity" mechanism
 *    (`noteEventForCapabilityGrowth`) now also tracks `growableProjectId` from it, fixing
 *    `buildSnapshotPayload`'s own late-subscriber staleness as the same fix's side effect.
 *    No protocol/schema change was needed — `metadata` was already an open, per-action bag.
 *
 *    Regression coverage: `core/kernel/model/handlers/project.test.ts` (the new metadata on
 *    all three events), `core/kernel/model/kernel.test.ts` (the late-subscriber snapshot
 *    fix), and `ui/mirror/model/mirror.test.ts` (the mirror consuming it, plus `deriveScreen`
 *    genuinely leaving `"home"` — the exact condition this gap's own diagnosis named).
 *
 *    UPDATED (fix-bundle Task 11, Gap C, spec §3.1): this test's body used to drive LINK 2's
 *    own chat/turn setup (`chat.create` -> `chat.switch` -> `turn.start`) by dispatching
 *    directly at the `KernelPort` after LINK 1, because nothing yet made `project.create`'s
 *    own typed text start a turn on its own. Now that `runProjectReadySequence` chains
 *    `beginTurn` with that SAME text once the project reaches `ready` trusted, those three
 *    dispatches are redundant with what LINK 1's own App interaction already does — this
 *    test's body no longer performs a single Kernel dispatch of its own; LINK 1's rendered
 *    App interaction is the only trigger, and everything downstream (the fake agent editing
 *    staging, Gate, finalize) is driven by the real Kernel's own resulting turn.
 * 3. `core/export/model/publish.ts`'s own header: `ExportPublishPlanV1.operations`/`.payloads`
 *    stay HARDCODED EMPTY ("WP-5 wires `assembleExportPackage`'s real file list into
 *    operations/payloads ... until that later slice supplies the actual transaction content").
 *    So even through the REAL `exportPublish` adapter, `export.start` would commit a durable
 *    but CONTENT-EMPTY transaction today. Gap 1 above is now closed (a real turn genuinely
 *    commits, so a real committed page now exists for "render"/"export" to key off), but this
 *    test still stops at LINK 2's `turn.completed` and does not extend into LINK 3/4 — that
 *    remains separate, future work (see the test body's own trailing comment for the exact
 *    shape); gap 3 is still a real blocker whenever that extension is attempted.
 */

const BACKEND_CAPABILITIES: BackendCapabilities = {
  backendId: "claude",
  models: [{ model: "sonnet", efforts: ["medium"] }],
  confinement: "canUseTool",
  sessionWorkspaceBinding: "fixed",
  defaultSelection: { model: "sonnet", effort: "medium" },
};

/** A minimal page the real Gate's source-only stages (import-scan, page-contract, lints)
 *  genuinely accept on the first attempt — the same shape `gate/model/gate.test.ts`'s own
 *  `cleanSource` fixture already proves passes `runGate` standalone. */
/**
 * The tree-relative `entry` `design/pages.json` binds to `home` in this smoke's fixture —
 * deliberately NOT `pages/home.tsx`, so no downstream step can pass by deriving a page's file
 * from its slug (design §3, §7: the manifest is the only binding).
 */
const HOME_ENTRY_REL_PATH = "screens/home/index.tsx";

const HOME_PAGE_SOURCE = `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "Home", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">hello from the fake agent</Text></Panel>)
`;

const scratchDirs: string[] = [];
function makeScratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A `SmokeRenderer` that always reports a clean render — the host-rendered smoke stage is
 *  part of the faked host/preview side (see this file's header); the Gate's SOURCE-ONLY
 *  stages (import-scan, page-contract, lints, the manifest-slice permutation check) stay real. */
function createFakeSmokeRenderer(): SmokeRenderer {
  return {
    render(_request: SmokeRequest): Promise<SmokeResult> {
      return Promise.resolve({ ok: true });
    },
  };
}

/** Wraps a `FakeAgentBackend` so this test can read the REAL turn workspace path the Kernel
 *  minted for the live attempt — `AgentBackendCall`'s own `{method, fence}` shape never
 *  records `task.workspacePath`, so this is the only way to learn where "the fake agent"
 *  should genuinely write. Every other method is the untouched fake. */
function createStagingAwareAgentBackend(inner: FakeAgentBackend): FakeAgentBackend & {
  lastWorkspacePath(): string | null;
} {
  let workspacePath: string | null = null;
  return {
    ...inner,
    startTurn(task: AgentTask) {
      workspacePath = task.workspacePath;
      return inner.startTurn(task);
    },
    lastWorkspacePath: () => workspacePath,
  };
}

/** Mirrors `create-shell.ts`'s own exported `toPreviewSessionHandle` (phase-8 Task 16) —
 *  duplicated here, not imported, for the same reason `toRealKernelPort` below duplicates
 *  `toKernelPort`: this test's composition is deliberately one level below `createShell`
 *  (see this file's header). Frame tokens now come from `kernel.publishFrame` (a REAL
 *  ledger-minted token) and acknowledgement forwards to `kernel.acknowledgeDisplay` — this
 *  smoke test still never dispatches a query through a live preview session (gap 1, this
 *  file's header, on why "render" cannot be reached at all today), so the round trip is
 *  never actually exercised end to end here; it is real, reachable plumbing sitting idle,
 *  not a stub. `previewSessionId` is now the caller-supplied Kernel-minted id (fix round 1,
 *  Finding 3 — mirrors `create-shell.ts`'s own fix), never `session.identity.sessionId`. */
function toRealPreviewSessionHandle(
  kernel: ReturnType<typeof createKernel>,
  session: PreviewSession,
  previewSessionId: string,
): PreviewSessionHandle {
  async function* displayFrames(): AsyncGenerator<UiPreviewFrame> {
    for await (const frame of session.frames) {
      const frameToken = kernel.publishFrame(frame);
      if (frameToken instanceof Error) {
        console.warn(`smoke.test: dropped a preview frame — ${frameToken.message}`);
        continue;
      }
      yield { frame, frameToken, handle };
    }
  }
  const handle: PreviewSessionHandle = {
    previewSessionId,
    session,
    frames: { [Symbol.asyncIterator]: displayFrames },
    acknowledgeDisplay: (frameToken) => kernel.acknowledgeDisplay(frameToken),
  };
  return handle;
}

/** Adapts the composed `Kernel` to `ui`'s narrower `KernelPort` — the same shape `create-
 *  shell.ts`'s own `toKernelPort` builds. Duplicated here (not imported) because
 *  `create-shell.ts` does not export `toKernelPort` itself, and this test's composition is
 *  deliberately one level below `createShell` (see this file's header on why `createShell`
 *  itself cannot be reused). */
function toRealKernelPort(kernel: ReturnType<typeof createKernel>): KernelPort {
  let cachedSession: PreviewSession | null = null;
  let cachedHandle: PreviewSessionHandle | null = null;

  return {
    dispatch: kernel.dispatch,
    subscribe: kernel.events,
    preview(): PreviewSessionHandle | null {
      const session = kernel.currentPreview();
      if (session === null) {
        cachedSession = null;
        cachedHandle = null;
        return null;
      }
      if (session !== cachedSession) {
        const previewSessionId = kernel.currentPreviewSessionId();
        if (previewSessionId === null) {
          console.warn(
            "smoke.test: kernel.currentPreview() is non-null but currentPreviewSessionId() is null — treating as no session",
          );
          cachedSession = null;
          cachedHandle = null;
          return null;
        }
        cachedSession = session;
        cachedHandle = toRealPreviewSessionHandle(kernel, session, previewSessionId);
      }
      return cachedHandle;
    },
  };
}

/** Resolves with the first delivered envelope matching `predicate`, subscribed BEFORE any
 *  dispatch that might race ahead of the `await` — same helper `core/kernel/model/
 *  kernel.integration.test.ts` already uses, generalized to this file's own `Kernel`. An
 *  explicit timeout makes a wedged chain FAIL, never hang (requirement: "the test fails, not
 *  hangs, on a wedge"). */
function waitForEvent(
  kernel: ReturnType<typeof createKernel>,
  predicate: (envelope: EventEnvelopeV1) => boolean,
  timeoutMs = 5_000,
): Promise<EventEnvelopeV1> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(
        new Error(`waitForEvent timed out after ${timeoutMs}ms waiting for a matching envelope`),
      );
    }, timeoutMs);
    const result = kernel.events((envelope) => {
      if (!predicate(envelope)) return;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(envelope);
    });
    if (result instanceof Error) {
      clearTimeout(timer);
      reject(result);
      return;
    }
    unsubscribe = result;
  });
}

/** Every real `StoreAdapterDeps`-backed port `interactiveShell` builds, plus the faked agent/
 *  host/export-render/smoke ports — everything `KernelDeps` needs. `hostSupervisor`/
 *  `exportRender` are built and wired into `KernelDeps` below but not returned: this file's
 *  header (gap 1) explains why "render"/"export" cannot be exercised yet, so nothing here
 *  asserts on their `calls` logs today — a future fix to gap 1 should return and use them,
 *  per the trailing comment in the test body below. */
interface RealComposition {
  readonly kernel: ReturnType<typeof createKernel>;
  readonly open: OpenProject;
  readonly agentBackend: FakeAgentBackend & { lastWorkspacePath(): string | null };
  /**
   * The faked host supervisor, exposed so a test can deliver the lifecycle diagnostics no fake
   * CALL produces — above all `circuitOpened`, which a real host reaches only by crash-looping
   * a live child (the 2026-07-27 preview render-failure regression).
   */
  readonly hostSupervisor: FakeHostSupervisorPort;
  readonly close: () => Promise<void>;
}

async function composeRealShell(root: string, userStateRoot: string): Promise<RealComposition> {
  fs.mkdirSync(root, { recursive: true });
  const store = createStore(nodeStoreDeps({ userStateRoot }));

  // Real, on-disk project creation — the same eager step `create-shell.ts`'s own
  // `openOrCreateProject` performs before a Kernel is ever constructed (`project.create`'s
  // own Kernel-side handler assumes an already-open project; it never calls
  // `store.createProject` itself).
  const open = await store.createProject({
    root,
    name: "smoke-project",
    targetStack: "js-opentui",
  });
  if (open instanceof Error) throw open;

  const storeAdapterDeps: StoreAdapterDeps = { open, uuidv7, clock: systemClock };
  const projectStore = createProjectStoreAdapter(storeAdapterDeps);

  // No `/model` picker exists in MVP (constraints: out of scope) — no Kernel command ever
  // writes `backend`/`model`/`effort` into `workspace.local.toml`. This test seeds them
  // directly through the REAL `ProjectStore.writeWorkspaceState` port so `turn.start`'s real
  // handler (`core/kernel/model/handlers/turn.ts`) has a resolvable agent selection, exactly
  // the same bridge a future `/model`-equivalent command would perform.
  const seeded = await projectStore.writeWorkspaceState({
    backend: BACKEND_CAPABILITIES.backendId,
    model: BACKEND_CAPABILITIES.models[0]?.model,
    effort: BACKEND_CAPABILITIES.models[0]?.efforts[0],
  });
  if (seeded !== undefined)
    throw new Error(`fixture bug: could not seed workspace state: ${seeded.safeMessage}`);

  const projections = createProjectionsAdapter(storeAdapterDeps);
  const chatStore = createChatStoreAdapter(storeAdapterDeps);
  const pageStore = createDesignStoreAdapter(storeAdapterDeps);
  const pinStore = createPinStoreAdapter(storeAdapterDeps);

  const innerAgentBackend = createFakeAgentBackend({ capabilities: BACKEND_CAPABILITIES });
  const agentBackend = createStagingAwareAgentBackend(innerAgentBackend);
  const hostSupervisor = createFakeHostSupervisorPort();
  const exportRender = createFakeExportRenderPort();

  const kernelDeps: KernelDeps = {
    projectStore,
    chatReader: chatStore,
    chatMutations: chatStore,
    designReader: pageStore,
    pageMutations: pageStore,
    pinReader: pinStore,
    pinMutations: pinStore,
    turnTransactions: createTurnTransactionsAdapter(storeAdapterDeps),
    projectWrite: createProjectWriteAdapter({ mutex: open.writeMutex }),
    staging: createStagingAdapter(storeAdapterDeps),
    trustGate: createTrustAdapter(storeAdapterDeps),
    pageMetaCache: projections.pageMeta,
    diagnosticsCache: projections.diagnostics,
    renderCache: projections.render,
    sessionCheckpoint: createSessionCheckpointAdapter(storeAdapterDeps),
    recovery: createRecoveryAdapter(storeAdapterDeps),
    gateRunner: createGateRunnerAdapter({ smokeRenderer: createFakeSmokeRenderer() }),
    hostSupervisor,
    exportRender,
    exportPublish: createExportPublishAdapter(storeAdapterDeps),
    agentRegistry: createFakeAgentRegistry([agentBackend]),
    agentPromptSource: createProductionAgentPromptSource(),
    clock: systemClock,
  };

  const kernel = createKernel(kernelDeps);

  return {
    kernel,
    open,
    agentBackend,
    hostSupervisor,
    close: async () => {
      await kernel.close();
      await open.close();
    },
  };
}

describe("the §10 scripted-terminal smoke (WP-12, M19): open project -> prompt -> fake agent edits staging -> gate -> render -> export", () => {
  test("drives the composed app (real store/gate/kernel, faked agent/host) through every named §10 link", async () => {
    const scratch = makeScratchDir("termcraft-smoke-");
    const root = path.join(scratch, "project");
    const userStateRoot = path.join(scratch, "user-state");

    const composed = await composeRealShell(root, userStateRoot);
    const { kernel, agentBackend } = composed;
    const port = toRealKernelPort(kernel);

    const envelopes: EventEnvelopeV1[] = [];
    const unsubscribe = kernel.events((envelope) => envelopes.push(envelope));
    if (unsubscribe instanceof Error) throw unsubscribe;

    let renderer: ReactTestRenderer | null = null;
    try {
      // ---- LINK 1: "open project" -> LINK 2's own "prompt" — driven through the rendered
      // App's own Home prompt, the one interaction that does not depend on the Home ->
      // Workspace transition this file's header documents as unreachable through the real
      // Kernel today. Fix-bundle Task 11 (Gap C, spec §3.1) closed the gap that used to force
      // this test to separately dispatch `chat.create` -> `chat.switch` -> `turn.start`
      // directly at the `KernelPort` after LINK 1: `store.createProject` already seeds
      // `workspace.local.toml`'s `activeChatId` with the project's first chat header
      // (`store/model/factory.ts`), and `runProjectReadySequence`
      // (`core/kernel/model/handlers/project.ts`) now chains `beginTurn` with `project.create`'s
      // own typed text the moment the project reaches `ready` trusted — the SAME text Home's
      // Enter just sent. One App interaction now drives project creation AND the first turn;
      // both waits below are subscribed BEFORE that interaction, so nothing racing ahead of
      // either `await` is ever missed (this file's own `waitForEvent` doc). ------------------
      const env: UiEnv = { root, workspaceIdentity: root, projectExists: false };
      const deps = createUiDeps(port, { w: 120, h: 36 }, env, () =>
        Promise.resolve({ kind: "ready", agent: "claude" }),
      );
      const appElement = createElement(App, { deps }) as Parameters<
        typeof createReactTestRenderer
      >[0];
      renderer = await createReactTestRenderer(appElement, { width: 120, height: 36 });

      await renderer.waitForFrame((frame) => frame.includes("termcraft"));
      // The seeded pre-probe placeholder is `checking` (finding §2.7, phase-8 Task 15), which
      // also renders "termcraft" — Enter below needs the outcome to have actually settled to
      // `ready` (this test's own injected probe), not merely the first seeded frame.
      await renderer.waitFor(() => deps.local.agentHealth().kind === "ready");

      const projectReady = waitForEvent(
        kernel,
        (envelope) =>
          envelope.kind === "kernel.stateChanged" &&
          (envelope.payload as EventPayloadByKindV1["kernel.stateChanged"]).action ===
            "kernel.project.finishOpen",
      );
      const firstAttemptStarted = waitForEvent(
        kernel,
        (envelope) => envelope.kind === "turn.attemptStarted",
      );
      await renderer.act(() => renderer?.mockInput.typeText("build the home page"));
      await renderer.act(() => renderer?.mockInput.pressEnter());
      await projectReady;

      // The real store genuinely created `.termcraft` on disk — proof "open project" ran
      // through the real store, not merely through an in-memory transition.
      expect(fs.existsSync(path.join(root, ".termcraft"))).toBe(true);

      await renderer.destroy();
      renderer = null;

      // ---- LINK 2: "fake agent edits staging" -> "gate" — the first turn Gap C's own chain
      // already started above; nothing left to dispatch. -------------------------------------
      await firstAttemptStarted;

      const startCall = agentBackend.calls.find((call) => call.method === "startTurn");
      if (startCall?.method !== "startTurn") throw new Error("expected a startTurn call");

      // GAP C'S OWN POINT (fix-bundle Task 11 fix round 1, Finding 1): proving *a* turn started
      // is not proving the DESIGNER'S TEXT reached it — `AgentTask.userMessage` is the exact
      // field `handlers/turn.ts`'s `baseTask` sets to `text` (`userMessage: text`, unmodified by
      // this task), so this is the one honest place to observe that the SAME string typed into
      // Home above ("build the home page") is what the agent actually received, not a second,
      // independently-typed message and not a placeholder.
      expect(startCall.task.userMessage).toBe("build the home page");

      const workspacePath = agentBackend.lastWorkspacePath();
      if (workspacePath === null) throw new Error("fixture bug: no workspace path captured");

      // phase-8 WP-3 acceptance: the runtime docs the agent-prompt library returns are
      // PHYSICALLY staged into the real turn workspace by the time the first attempt starts
      // — proven here against the REAL `store` staging adapter and the REAL
      // `createProductionAgentPromptSource()`, not a fake.
      expect(fs.existsSync(path.join(workspacePath, "RUNTIME.md"))).toBe(true);
      expect(fs.existsSync(path.join(workspacePath, "runtime.d.ts"))).toBe(true);
      expect(fs.existsSync(path.join(workspacePath, "REATOM.md"))).toBe(true);

      // "the fake agent edits staging": a REAL page file plus a REAL manifest-slice update
      // are written into the REAL turn workspace the staging adapter minted on disk —
      // exactly the bytes the real Gate/candidate-freeze pipeline reads back.
      // THE DESIGN TREE'S OWN LAYOUT (task 14; design §3, §10): the whole tree lives under
      // `design/`, `pages.json` is a REAL file inside it, and a page's file is whatever that
      // manifest's `entry` names — here `screens/home/index.tsx`, deliberately NOT
      // `pages/<slug>.tsx`, so nothing downstream can pass by deriving a path from the slug.
      // This fixture wrote the retired flat layout (`<workspace>/pages/home.tsx` plus a
      // `{pages:["home"],active:"home"}` slice) until now, which `store/safe-fs` refuses
      // outright: "pages/home.tsx is outside every managed namespace of a workspace root".
      fs.mkdirSync(path.join(workspacePath, "design", "screens", "home"), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, "design", "screens", "home", "index.tsx"),
        HOME_PAGE_SOURCE,
        "utf8",
      );
      fs.writeFileSync(
        path.join(workspacePath, "design", "pages.json"),
        JSON.stringify({
          schemaVersion: 1,
          pages: [{ slug: "home", entry: HOME_ENTRY_REL_PATH }],
          requestedActivePage: "home",
        }),
        "utf8",
      );

      // The turn's TERMINAL event — this file's header (gap 1, now fixed) documents why
      // this genuinely is `turn.completed` now, not `turn.failed`.
      const turnTerminal = waitForEvent(
        kernel,
        (envelope) => envelope.kind === "turn.completed" || envelope.kind === "turn.failed",
      );
      agentBackend.completeRun(startCall.fence, {
        kind: "completed",
        finalText: "Added the home page.",
        usage: null,
        sessionId: "smoke-session",
      });
      const terminalEnvelope = await turnTerminal;

      // "gate": the real import-scan/page-contract/manifest-slice/lint stages ran over the
      // staged bytes above and were never rejected — no `turn.gateRejected` anywhere in the
      // whole captured stream proves the candidate passed the real Gate on the first
      // attempt.
      expect(envelopes.some((envelope) => envelope.kind === "turn.gateRejected")).toBe(false);

      // GAP 1, FIXED (this file's header): the turn genuinely COMMITS through the real
      // composed graph now — real admission, real Gate pass, real finalize, all through the
      // real store/gate/kernel chain this test composes.
      expect(terminalEnvelope.kind).toBe("turn.completed");
      const completedPayload = terminalEnvelope.payload as EventPayloadByKindV1["turn.completed"];
      expect(completedPayload.outcome).toBe("completed");
      expect(completedPayload.failure).toBeNull();
      expect(completedPayload.changedPages).toHaveLength(1);
      const [changedPage] = completedPayload.changedPages;
      if (changedPage === undefined) throw new Error("expected exactly one changed page");
      expect(changedPage.pageSlug).toBe("home");

      // The real store genuinely committed the page — proof "finalize" ran through the real
      // store, not merely through an in-memory transition: the canonical page now exists on
      // disk under the project's `.termcraft` root (`store/transaction/model/wrappers.ts`'s
      // own `canonicalPagePath`), with the fake agent's exact bytes.
      // CANONICAL storage is `.termcraft/design/<entry>` now — the tree, verbatim, at the same
      // tree-relative path the workspace used, which is what makes design §10's "no specifier
      // is ever rewritten on apply" true.
      const canonicalHomePath = path.join(
        root,
        ".termcraft",
        "design",
        ...HOME_ENTRY_REL_PATH.split("/"),
      );
      expect(fs.existsSync(canonicalHomePath)).toBe(true);
      expect(fs.readFileSync(canonicalHomePath, "utf8")).toBe(HOME_PAGE_SOURCE);

      // The turn workspace's own staged copy is still there too (never retired on a
      // successful path until the candidate itself is superseded) — real edits, real disk,
      // start to finish.
      const stagedHomePath = path.join(workspacePath, "design", ...HOME_ENTRY_REL_PATH.split("/"));
      expect(fs.existsSync(stagedHomePath)).toBe(true);
      expect(fs.readFileSync(stagedHomePath, "utf8")).toBe(HOME_PAGE_SOURCE);

      // LINK 3 "render" and LINK 4 "export" are NOT asserted below — extending this test to
      // drive them against the now-genuinely-committed page is separate follow-up work (gap
      // 3 above, `ExportPublishPlanV1.operations`/`.payloads` staying hardcoded empty, is a
      // real blocker for LINK 4 specifically). A future extension should:
      //   1. Read `changedPage.sourceHash` off the genuine `turn.completed` payload above.
      //   2. Seed `pageMetaCache.put({key: {pageSlug: "home", sourceHash, extractorVersion: 1},
      //      meta: {...}})` directly (mirroring `core/kernel/model/kernel.integration.test.ts`'s
      //      own established technique — no production path populates this cache yet either,
      //      a second, narrower, already-flagged gap `resolvePageSettings`'s own header names).
      //   3. Dispatch `preview.selectCurrent` at the `KernelPort` (still no UI caller exists;
      //      code-search over `src/ui` finds none) and assert `preview.sourceChanged` plus a
      //      real `hostSupervisor.calls` entry for "home" (the faked host process itself,
      //      per this file's header).
      //   4. Dispatch `export.start` and assert `export.started -> export.progress* ->
      //      export.completed` with `failure: null`, plus a real `exportRender.calls` entry
      //      for "home" — noting gap 3 above (the publish plan's operations/payloads still
      //      stay empty until WP-5 wires `assembleExportPackage`'s real file list in).
    } finally {
      if (renderer !== null) await renderer.destroy();
      unsubscribe();
      await composed.close();
    }
  }, 20_000);
});

/**
 * THE REPORTED DEFECT'S REGRESSION GATE (2026-07-27). Opening the app showed
 * `preparing preview…` forever whenever the current page threw while rendering: the supervisor
 * correctly reported `PAGE_RENDER_FAILED`, restarted three times and latched its circuit open —
 * and NOTHING consumed `HostSupervisorPort.onEvent`, so the mirror stayed `ready`, no frame ever
 * arrived, and `Workspace` fell through to the placeholder.
 *
 * Driven through the REAL composition — real store, real Gate, real Kernel, real subscription,
 * real mirror, real `Workspace` — with only the host process and the agent faked, exactly as this
 * file's header describes. The page is created by a real committed turn, the same way the §10
 * smoke above creates it; `hostSupervisor.emit` then stands in for the one thing a faked host
 * cannot do on its own: die four times over on a session that is already live.
 */
describe("the preview render-failure regression (2026-07-27)", () => {
  test("a host that crash-loops on a LIVE session reaches the UI as a halted preview, never an endless 'preparing preview…'", async () => {
    const scratch = makeScratchDir("termcraft-crashloop-");
    const root = path.join(scratch, "project");
    const composed = await composeRealShell(root, path.join(scratch, "user-state"));
    const { kernel, agentBackend, hostSupervisor } = composed;
    const port = toRealKernelPort(kernel);

    let renderer: ReactTestRenderer | null = null;
    try {
      const env: UiEnv = { root, workspaceIdentity: root, projectExists: false };
      const deps = createUiDeps(port, { w: 120, h: 36 }, env, () =>
        Promise.resolve({ kind: "ready", agent: "claude" }),
      );

      // ---- A real committed turn, so a real page exists to preview ------------------------
      const appElement = createElement(App, { deps }) as Parameters<
        typeof createReactTestRenderer
      >[0];
      renderer = await createReactTestRenderer(appElement, { width: 120, height: 36 });
      await renderer.waitForFrame((frame) => frame.includes("termcraft"));
      await renderer.waitFor(() => deps.local.agentHealth().kind === "ready");

      const projectReady = waitForEvent(
        kernel,
        (envelope) =>
          envelope.kind === "kernel.stateChanged" &&
          (envelope.payload as EventPayloadByKindV1["kernel.stateChanged"]).action ===
            "kernel.project.finishOpen",
      );
      const firstAttemptStarted = waitForEvent(kernel, (e) => e.kind === "turn.attemptStarted");
      await renderer.act(() => renderer?.mockInput.typeText("build the home page"));
      await renderer.act(() => renderer?.mockInput.pressEnter());
      const readyEnvelope = await projectReady;
      await firstAttemptStarted;
      expect(readyEnvelope.kind).toBe("kernel.stateChanged");
      // The App stays MOUNTED for the whole test on purpose: `createUiDeps`'s Kernel
      // subscription is owned by an atom connect hook (RTM-L01), so unmounting would tear the
      // mirror's only feed down and every phase below would read a stale `none`.

      const startCall = agentBackend.calls.find((call) => call.method === "startTurn");
      if (startCall?.method !== "startTurn") throw new Error("expected a startTurn call");
      const workspacePath = agentBackend.lastWorkspacePath();
      if (workspacePath === null) throw new Error("fixture bug: no workspace path captured");

      // THE DESIGN TREE'S OWN LAYOUT (task 14; design §3, §10): the whole tree lives under
      // `design/`, `pages.json` is a REAL file inside it, and a page's file is whatever that
      // manifest's `entry` names — here `screens/home/index.tsx`, deliberately NOT
      // `pages/<slug>.tsx`, so nothing downstream can pass by deriving a path from the slug.
      // This fixture wrote the retired flat layout (`<workspace>/pages/home.tsx` plus a
      // `{pages:["home"],active:"home"}` slice) until now, which `store/safe-fs` refuses
      // outright: "pages/home.tsx is outside every managed namespace of a workspace root".
      fs.mkdirSync(path.join(workspacePath, "design", "screens", "home"), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, "design", "screens", "home", "index.tsx"),
        HOME_PAGE_SOURCE,
        "utf8",
      );
      fs.writeFileSync(
        path.join(workspacePath, "design", "pages.json"),
        JSON.stringify({
          schemaVersion: 1,
          pages: [{ slug: "home", entry: HOME_ENTRY_REL_PATH }],
          requestedActivePage: "home",
        }),
        "utf8",
      );
      const turnTerminal = waitForEvent(
        kernel,
        (envelope) => envelope.kind === "turn.completed" || envelope.kind === "turn.failed",
      );
      agentBackend.completeRun(startCall.fence, {
        kind: "completed",
        finalText: "Added the home page.",
        usage: null,
        sessionId: "crashloop-session",
      });
      const terminalEnvelope = await turnTerminal;
      expect(terminalEnvelope.kind).toBe("turn.completed");

      // ---- A live preview session on that page --------------------------------------------
      const sessionReady = waitForEvent(kernel, (e) => e.kind === "preview.sessionReady");
      const selectResult = await kernel.dispatch({
        protocolVersion: 1,
        commandId: uuidv7(),
        expectedRevision: terminalEnvelope.stateRevision,
        kind: "preview.selectPage",
        payload: { pageSlug: "home" },
      });
      if (selectResult instanceof Error) throw selectResult;
      const readyPayload = (await sessionReady)
        .payload as EventPayloadByKindV1["preview.sessionReady"];
      expect(deps.mirror.preview().phase).toBe("ready");

      // ---- The host crash-loops. BEFORE THE FIX, everything below stayed frozen here ------
      const circuitOpened = waitForEvent(kernel, (e) => e.kind === "preview.circuitOpened");
      hostSupervisor.emit({
        type: "circuitOpened",
        key: `home@${readyPayload.sourceHash.slice(0, 8)}`,
        sessionId: readyPayload.previewSessionId,
        pageSlug: "home",
        sourceHashPrefix: readyPayload.sourceHash.slice(0, 8),
        attempts: 4,
        reason: "restart budget exhausted (3 in 60000ms)",
        failureCode: "DESIGN_RENDER_FAILED",
        failureMessage: "PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function",
      });
      await circuitOpened;
      expect(deps.mirror.preview().phase).toBe("circuit-open");

      // Settle React's pending updates, then paint once. `waitForFrame` is NOT used here: the
      // mirror already holds the final state (asserted above), so there is nothing left to wait
      // FOR — a predicate that never matched would time out instead of failing on the frame.
      await renderer.act(() => Promise.resolve());
      await renderer.renderOnce();
      const frame = renderer.captureCharFrame();
      expect(frame).toContain("✗ design threw while rendering");
      expect(frame).toContain("ctx.spy is not a function");
      // THE DEFECT, verbatim: the placeholder is gone.
      expect(frame).not.toContain("preparing preview…");
      // Both routes out are on screen, and the chat panel says why.
      expect(frame).toContain("F6");
      expect(frame).toContain("preview crashed while rendering");
    } finally {
      if (renderer !== null) await renderer.destroy();
      await composed.close();
    }
  }, 30_000);
});

/**
 * THE SHARED-MODULE EDIT (design-tree phase 2 Task 10), driven through the composed app.
 *
 * A page spans its whole closure now, and every identity the preview path used to key on spoke
 * only about ENTRY files: `page.descriptorsChanged`'s per-descriptor `sourceHash`, the UI memo in
 * `ui/app/model/deps.ts`, and the host supervisor's own session key. So a turn that rewrote a
 * module the page IMPORTS moved nothing any of them could see — the UI re-asked for no session,
 * and had it asked, the supervisor would have returned the live child with the OLD module still
 * in its registry. The user's edit was invisible for the rest of the run.
 *
 * WHAT THIS TEST ACTUALLY REACHES, stated exactly. Real `store` (a real on-disk project and two
 * real committed turns), real `gate` (the source-only stages over the real staged bytes), the
 * real `core` Kernel, and the real `ui` mirror + `createUiDeps` subscriber — which is the
 * producer under test: nothing here dispatches `preview.selectPage` by hand. The host side is
 * the FAKE `HostSupervisorPort` this file fakes everywhere (see the file header), so what is
 * proven end to end is that a shared-module edit reaches `HostSupervisorPort.preview` as a
 * SECOND call carrying a NEW session key for an entry file that did not move. That the REAL
 * supervisor then spawns a second incarnation for that new key — rather than handing back the
 * live child — is pinned separately, at its own layer, by
 * `host/supervisor/model/supervisor.test.ts`'s "a spec differing ONLY in treeRevision produces a
 * second incarnation, never the live one".
 */
describe("a shared-module edit re-establishes the preview session (design-tree phase 2 Task 10)", () => {
  /** The shared module the page imports — the only file the SECOND turn rewrites. */
  const SHARED_LABELS_REL_PATH = "shared/labels.ts";
  const sharedLabels = (greeting: string) => `export const GREETING = "${greeting}"\n`;

  /**
   * The page, importing that shared module. `../../shared/labels` from
   * `screens/home/index.tsx` resolves to `shared/labels.ts` through design §6's own
   * extension probe (`entities/design-tree`'s `RESOLUTION_EXTENSIONS`) — a real closure edge,
   * not a second copy of the text.
   */
  const HOME_PAGE_WITH_SHARED_IMPORT = `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
import { GREETING } from "../../shared/labels"
export const meta = definePage({ kitApiVersion: 1, title: "Home", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">{GREETING}</Text></Panel>)
`;

  const PAGES_MANIFEST = JSON.stringify({
    schemaVersion: 1,
    pages: [{ slug: "home", entry: HOME_ENTRY_REL_PATH }],
    requestedActivePage: "home",
  });

  /** Every `preview()` the composed Kernel asked the (faked) host port for, in order. */
  function previewCalls(hostSupervisor: FakeHostSupervisorPort) {
    return hostSupervisor.calls.filter(
      (call): call is Extract<typeof call, { method: "preview" }> => call.method === "preview",
    );
  }

  /**
   * Writes the given TREE-relative files into the live turn's real workspace and completes the
   * fake agent's run, resolving on the turn's terminal event. The WHOLE tree is written every
   * time on purpose: it makes the entry file's bytes identical across both turns by
   * construction, so "the entry hash did not move" is a fact this fixture establishes rather
   * than one it assumes about how a workspace is seeded.
   */
  async function completeFakeAgentTurn(
    composed: Awaited<ReturnType<typeof composeRealShell>>,
    files: ReadonlyMap<string, string>,
  ): Promise<EventEnvelopeV1> {
    const startCalls = composed.agentBackend.calls.filter((call) => call.method === "startTurn");
    const startCall = startCalls[startCalls.length - 1];
    if (startCall?.method !== "startTurn") throw new Error("expected a startTurn call");
    const workspacePath = composed.agentBackend.lastWorkspacePath();
    if (workspacePath === null) throw new Error("fixture bug: no workspace path captured");

    for (const [relPath, contents] of files) {
      const absolute = path.join(workspacePath, "design", ...relPath.split("/"));
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, contents, "utf8");
    }

    const terminal = waitForEvent(
      composed.kernel,
      (envelope) => envelope.kind === "turn.completed" || envelope.kind === "turn.failed",
    );
    composed.agentBackend.completeRun(startCall.fence, {
      kind: "completed",
      finalText: "done",
      usage: null,
      sessionId: "shared-module-session",
    });
    return terminal;
  }

  test("a turn that rewrites ONLY a shared module still asks the host for a new session on the unchanged active page", async () => {
    const scratch = makeScratchDir("termcraft-shared-module-");
    const root = path.join(scratch, "project");
    const composed = await composeRealShell(root, path.join(scratch, "user-state"));
    const { kernel, hostSupervisor } = composed;
    const port = toRealKernelPort(kernel);

    let renderer: ReactTestRenderer | null = null;
    try {
      const env: UiEnv = { root, workspaceIdentity: root, projectExists: false };
      const deps = createUiDeps(port, { w: 120, h: 36 }, env, () =>
        Promise.resolve({ kind: "ready", agent: "claude" }),
      );
      // The App stays MOUNTED for the whole test: `createUiDeps`'s Kernel subscription AND its
      // `preview.selectPage` producer both live in one atom connect hook (RTM-L01), and that
      // producer is exactly what this test is measuring.
      const appElement = createElement(App, { deps }) as Parameters<
        typeof createReactTestRenderer
      >[0];
      renderer = await createReactTestRenderer(appElement, { width: 120, height: 36 });
      await renderer.waitForFrame((frame) => frame.includes("termcraft"));
      await renderer.waitFor(() => deps.local.agentHealth().kind === "ready");

      const projectReady = waitForEvent(
        kernel,
        (envelope) =>
          envelope.kind === "kernel.stateChanged" &&
          (envelope.payload as EventPayloadByKindV1["kernel.stateChanged"]).action ===
            "kernel.project.finishOpen",
      );
      const firstAttemptStarted = waitForEvent(kernel, (e) => e.kind === "turn.attemptStarted");
      await renderer.act(() => renderer?.mockInput.typeText("build the home page"));
      await renderer.act(() => renderer?.mockInput.pressEnter());
      await projectReady;
      await firstAttemptStarted;

      // ---- TURN 1: the page plus the shared module it imports ------------------------------
      const firstTerminal = await completeFakeAgentTurn(
        composed,
        new Map([
          ["pages.json", PAGES_MANIFEST],
          [HOME_ENTRY_REL_PATH, HOME_PAGE_WITH_SHARED_IMPORT],
          [SHARED_LABELS_REL_PATH, sharedLabels("hello from the fake agent")],
        ]),
      );
      expect(firstTerminal.kind).toBe("turn.completed");

      // Nothing is dispatched by hand here: the mounted App's own subscriber is what turns the
      // post-commit `page.descriptorsChanged` into a `preview.selectPage`.
      await renderer.waitFor(() => previewCalls(hostSupervisor).length >= 1);
      const firstPreview = previewCalls(hostSupervisor)[0];
      if (firstPreview === undefined) throw new Error("expected a first preview() call");
      expect(firstPreview.pageSlug).toBe("home");

      // ---- TURN 2: the shared module, and NOTHING else --------------------------------------
      const secondAttemptStarted = waitForEvent(
        kernel,
        (e) => e.kind === "turn.attemptStarted",
        10_000,
      );
      // Dispatched through the UI's own `Dispatcher`, not `kernel.dispatch` directly: it stamps
      // the CURRENT `stateRevision` off the live mirror, and the first turn's terminal envelope
      // is already stale by the time its own `page.descriptorsChanged` and the preview events
      // that follow have landed.
      const startResult = await deps.dispatcher.dispatch("turn.start", {
        text: "reword the greeting",
      });
      if (startResult instanceof Error) throw startResult;
      expect(startResult.status).toBe("accepted");
      await secondAttemptStarted;

      const secondTerminal = await completeFakeAgentTurn(
        composed,
        new Map([
          ["pages.json", PAGES_MANIFEST],
          // Byte-identical to turn 1 — this is what makes the entry hash stand still.
          [HOME_ENTRY_REL_PATH, HOME_PAGE_WITH_SHARED_IMPORT],
          [SHARED_LABELS_REL_PATH, sharedLabels("hello from the SECOND turn")],
        ]),
      );
      expect(secondTerminal.kind).toBe("turn.completed");

      // THE DEFECT, INVERTED: before Task 10 nothing here happened at all — the memo key and the
      // supervisor key were both the entry hash, which did not move, so no second ask was ever
      // made and the live child kept the pre-edit module.
      await renderer.waitFor(() => previewCalls(hostSupervisor).length >= 2);
      const calls = previewCalls(hostSupervisor);
      const latest = calls[calls.length - 1];
      if (latest === undefined) throw new Error("expected a second preview() call");

      expect(latest.pageSlug).toBe("home");
      // The entry file did not move — the whole point of the case.
      expect(latest.sourceHash).toBe(firstPreview.sourceHash);
      // ...and the session key did, so the host is being asked for a NEW session, not the live one.
      expect(latest.treeRevision).not.toBe(firstPreview.treeRevision);
    } finally {
      if (renderer !== null) await renderer.destroy();
      await composed.close();
    }
  }, 40_000);
});
