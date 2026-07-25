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
import type { FakeAgentBackend } from "core/ports/fakes";
import { createGateRunnerAdapter } from "gate";
import type { SmokeRenderer, SmokeRequest, SmokeResult } from "gate";
import { systemClock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";
import {
  createChatStoreAdapter,
  createExportPublishAdapter,
  createPageStoreAdapter,
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
 *    This test's own body still drives every §10 step past LINK 1 by dispatching directly
 *    at the `KernelPort`, not through the rendered App — that remains a valid, independent
 *    choice (exercising the real Kernel/store/gate chain without needing the App's own
 *    screen-routing components mounted), not a workaround for this now-fixed gap.
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

const PROTOCOL_VERSION = 1;

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
 *  not a stub. */
function toRealPreviewSessionHandle(
  kernel: ReturnType<typeof createKernel>,
  session: PreviewSession,
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
    previewSessionId: session.identity.sessionId,
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
        cachedSession = session;
        cachedHandle = toRealPreviewSessionHandle(kernel, session);
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
  const pageStore = createPageStoreAdapter(storeAdapterDeps);
  const pinStore = createPinStoreAdapter(storeAdapterDeps);

  const innerAgentBackend = createFakeAgentBackend({ capabilities: BACKEND_CAPABILITIES });
  const agentBackend = createStagingAwareAgentBackend(innerAgentBackend);
  const hostSupervisor = createFakeHostSupervisorPort();
  const exportRender = createFakeExportRenderPort();

  const kernelDeps: KernelDeps = {
    projectStore,
    chatReader: chatStore,
    chatMutations: chatStore,
    pageReader: pageStore,
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
      // ---- LINK 1: "open project" — driven through the rendered App's own Home prompt,
      // the one interaction that does not depend on the Home -> Workspace transition this
      // file's header documents as unreachable through the real Kernel today. ------------
      const env: UiEnv = { root, workspaceIdentity: root };
      const deps = createUiDeps(port, { w: 120, h: 36 }, env, () =>
        Promise.resolve({
          present: true,
          agent: "claude",
          version: "smoke-test",
          detail: "agent ready",
        }),
      );
      const appElement = createElement(App, { deps }) as Parameters<
        typeof createReactTestRenderer
      >[0];
      renderer = await createReactTestRenderer(appElement, { width: 120, height: 36 });

      await renderer.waitForFrame((frame) => frame.includes("termcraft"));

      const projectReady = waitForEvent(
        kernel,
        (envelope) =>
          envelope.kind === "kernel.stateChanged" &&
          (envelope.payload as EventPayloadByKindV1["kernel.stateChanged"]).action ===
            "kernel.project.finishOpen",
      );
      await renderer.act(() => renderer?.mockInput.typeText("build the home page"));
      await renderer.act(() => renderer?.mockInput.pressEnter());
      const readyEnvelope = await projectReady;

      // The real store genuinely created `.termcraft` on disk — proof "open project" ran
      // through the real store, not merely through an in-memory transition.
      expect(fs.existsSync(path.join(root, ".termcraft"))).toBe(true);

      await renderer.destroy();
      renderer = null;

      // ---- LINK 2 setup: chat.create -> chat.switch, the legitimate preparatory dispatch
      // establishing `activeChatId` (`turn.start`'s real handler requires one; the current
      // UI never issues these from the unreachable Workspace screen — see this file's
      // header) — dispatched directly at the KernelPort, exactly as the task brief
      // sanctions for a §10-named kernel step the UI cannot reach today. -------------------
      const chatCreated = waitForEvent(kernel, (envelope) => envelope.kind === "chat.changed");
      const createResult = await port.dispatch({
        protocolVersion: PROTOCOL_VERSION,
        commandId: uuidv7(),
        expectedRevision: readyEnvelope.stateRevision,
        kind: "chat.create",
        payload: {},
      });
      if (createResult instanceof Error) throw createResult;
      expect(createResult.status).toBe("accepted");
      const createdEnvelope = await chatCreated;
      const createdChatId = (createdEnvelope.payload as EventPayloadByKindV1["chat.changed"])
        .activeChatId;

      const chatSwitched = waitForEvent(
        kernel,
        (envelope) =>
          envelope.kind === "chat.changed" &&
          (envelope.payload as EventPayloadByKindV1["chat.changed"]).added.length === 0,
      );
      const switchResult = await port.dispatch({
        protocolVersion: PROTOCOL_VERSION,
        commandId: uuidv7(),
        expectedRevision: createdEnvelope.stateRevision,
        kind: "chat.switch",
        payload: { chatId: createdChatId },
      });
      if (switchResult instanceof Error) throw switchResult;
      expect(switchResult.status).toBe("accepted");
      const switchedEnvelope = await chatSwitched;

      // ---- LINK 2: "prompt" -> "fake agent edits staging" -> "gate" -----------------------
      const firstAttemptStarted = waitForEvent(
        kernel,
        (envelope) => envelope.kind === "turn.attemptStarted",
      );
      const turnStartResult = await port.dispatch({
        protocolVersion: PROTOCOL_VERSION,
        commandId: uuidv7(),
        expectedRevision: switchedEnvelope.stateRevision,
        kind: "turn.start",
        payload: { text: "build the home page" },
      });
      if (turnStartResult instanceof Error) throw turnStartResult;
      expect(turnStartResult.status).toBe("accepted");
      await firstAttemptStarted;

      const startCall = agentBackend.calls.find((call) => call.method === "startTurn");
      if (startCall?.method !== "startTurn") throw new Error("expected a startTurn call");
      const workspacePath = agentBackend.lastWorkspacePath();
      if (workspacePath === null) throw new Error("fixture bug: no workspace path captured");

      // phase-8 WP-3 acceptance: the runtime docs the agent-prompt library returns are
      // PHYSICALLY staged into the real turn workspace by the time the first attempt starts
      // — proven here against the REAL `store` staging adapter and the REAL
      // `createProductionAgentPromptSource()`, not a fake.
      expect(fs.existsSync(path.join(workspacePath, "RUNTIME.md"))).toBe(true);
      expect(fs.existsSync(path.join(workspacePath, "runtime.d.ts"))).toBe(true);

      // "the fake agent edits staging": a REAL page file plus a REAL manifest-slice update
      // are written into the REAL turn workspace the staging adapter minted on disk —
      // exactly the bytes the real Gate/candidate-freeze pipeline reads back.
      fs.mkdirSync(path.join(workspacePath, "pages"), { recursive: true });
      fs.writeFileSync(path.join(workspacePath, "pages", "home.tsx"), HOME_PAGE_SOURCE, "utf8");
      fs.writeFileSync(
        path.join(workspacePath, "pages.json"),
        JSON.stringify({ pages: ["home"], active: "home" }),
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
      const canonicalHomePath = path.join(root, ".termcraft", "pages", "home", "page.tsx");
      expect(fs.existsSync(canonicalHomePath)).toBe(true);
      expect(fs.readFileSync(canonicalHomePath, "utf8")).toBe(HOME_PAGE_SOURCE);

      // The turn workspace's own staged copy is still there too (never retired on a
      // successful path until the candidate itself is superseded) — real edits, real disk,
      // start to finish.
      expect(fs.existsSync(path.join(workspacePath, "pages", "home.tsx"))).toBe(true);
      expect(fs.readFileSync(path.join(workspacePath, "pages", "home.tsx"), "utf8")).toBe(
        HOME_PAGE_SOURCE,
      );

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
