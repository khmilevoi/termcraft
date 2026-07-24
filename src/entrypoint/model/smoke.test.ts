import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

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
 * 1. BLOCKING — no real turn can ever COMMIT through the real composed graph today.
 *    `core/kernel/model/handlers/turn.ts`'s `runTurnStart` captures the chat's CAS baseline
 *    (`context.deps.chatReader.readAppendBase(activeChatId)`) BEFORE calling `runTurn(...)` —
 *    i.e. BEFORE `core/turns/model/admission.ts`'s own `runAdmission` durably appends this
 *    exact turn's user record to that SAME chat. That stale, pre-admission baseline then
 *    flows verbatim through `TurnWorkspaceV1.readSet.chat` into `finalizeTurn`'s own CAS
 *    precondition (`store/transaction/model/wrappers.ts`'s `buildFinalizeCasPrecondition`),
 *    which re-observes the chat's CURRENT (now one-record-longer) state and finds a length/
 *    hash mismatch — `APPLY_STALE` with `details.part: "chat"`, on EVERY real turn, not a
 *    corner case. Confirmed with a minimal, isolated repro against the real store (capture
 *    `readAppendBase` -> `admit()` -> `finalize()` with the pre-admission baseline): it always
 *    returns `{code: "APPLY_STALE", details: {part: "chat"}}`. The CORRECT contract —
 *    established by `store/adapters/turn-transactions.test.ts`'s own already-passing fixture
 *    ("finalize() commits an agent record when the read-set CAS matches current state") — is
 *    to capture the chat baseline AFTER `admit()`, immediately before `finalize()`; nothing in
 *    `core/turns`'s current `RunTurnDeps`/`AdmissionDeps` surface gives `handlers/turn.ts` a
 *    hook to do that (the staged read-set is captured once, pre-admission, and reused verbatim
 *    at finalize time). Fixing it needs a real port/contract change across `core/turns/model/
 *    {admission,run-turn,finalize}.ts` and `core/kernel/model/handlers/turn.ts` together — out
 *    of a test-writing task's scope, and exactly what "assert up to that link and flag the
 *    remainder" calls for. THIS IS WHY this test cannot assert a committed `turn.completed`,
 *    and consequently cannot exercise "render"/"export" against a genuinely-changed page
 *    through the real chain — see the test body's own trailing comment for the precise shape
 *    those two links would need once this is fixed.
 *    A COMPOUNDING SECOND EFFECT, same root cause's blast radius: `core/turns/model/
 *    run-turn.ts` never drives the `finalizing -> terminalizing` edge when `finalizeTurn`
 *    returns `{kind:"failed", ...}` (its own header says this bridge belongs to "whichever
 *    caller decided", but `runTurn` never decides it for this branch — it just returns
 *    `{kind:"finalized", result}` as-is). So the turn MACHINE is left stuck in `"finalizing"`
 *    permanently once any finalize failure occurs (this one included) — every subsequent
 *    `chat.create`/`chat.switch`/`turn.start`/`export.start` in the SAME process is then
 *    guard-rejected `CAPABILITY_UNAVAILABLE` for "turn.phase is finalizing (non-idle)" (visible
 *    directly in this test's own console output). Not asserted on directly here (this test's
 *    own chain never dispatches anything after the terminal event), but worth a maintainer's
 *    attention alongside gap 1 — the two are almost certainly fixed together.
 * 2. `ui`'s Home -> Workspace transition is UNREACHABLE through the real composed Kernel
 *    today. `core/kernel/model/kernel.ts`'s own `buildSnapshotPayload` hardcodes
 *    `projectId`/`activePageSlug`/`activeChatId`/`pageDescriptors` to `null`/`[]`
 *    UNCONDITIONALLY ("No project has ever been opened/created yet in a freshly-assembled
 *    Kernel ... Task 9's project.open/project.create handlers are what will ever populate
 *    these" — never actually wired since). `ui/mirror`'s own `apply()` only ever sets
 *    `project.projectId` from a `kernel.snapshot` envelope (never from `kernel.stateChanged`
 *    or `page.descriptorsChanged`), and the real Kernel never re-emits `kernel.snapshot` after
 *    bootstrap. So `deriveScreen`'s `projectId !== null` condition can never become true for a
 *    live subscriber, and the rendered App's own screen never leaves Home even once a real
 *    `project.create` has genuinely succeeded. This is why the rendered-App step below only
 *    drives the Home prompt/submit (the one interaction that does not depend on that
 *    transition) and every later §10 link is asserted by dispatching directly at the
 *    `KernelPort` — exactly the fallback the task brief names ("dispatched commands at the
 *    KernelPort where the §10 chain names kernel steps") for a link the composed seams cannot
 *    express through the UI today.
 * 3. `core/export/model/publish.ts`'s own header: `ExportPublishPlanV1.operations`/`.payloads`
 *    stay HARDCODED EMPTY ("WP-5 wires `assembleExportPackage`'s real file list into
 *    operations/payloads ... until that later slice supplies the actual transaction content").
 *    So even through the REAL `exportPublish` adapter, `export.start` would commit a durable
 *    but CONTENT-EMPTY transaction today (moot for this file until gap 1 above closes, since
 *    no real export can be reached without a committed page either).
 */

const PROTOCOL_VERSION = 1;

const BACKEND_CAPABILITIES: BackendCapabilities = {
  backendId: "claude",
  models: [{ model: "sonnet", efforts: ["medium"] }],
  confinement: "canUseTool",
  sessionWorkspaceBinding: "fixed",
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

/** Never wired in this fixture — this smoke test never dispatches a query through a live
 *  preview session (see this file's header, gap 1, on why "render" cannot be reached at all
 *  today), so no genuine `FrameIdentityV1` authority is needed here either. */
function toRealPreviewSessionHandle(session: PreviewSession): PreviewSessionHandle {
  async function* displayFrames(): AsyncGenerator<UiPreviewFrame> {
    for await (const frame of session.frames) {
      yield { frame, frameToken: uuidv7(), handle };
    }
  }
  const handle: PreviewSessionHandle = {
    previewSessionId: session.identity.sessionId,
    session,
    frames: { [Symbol.asyncIterator]: displayFrames },
    acknowledgeDisplay: () =>
      new Error("preview.acknowledgeDisplay is not wired in this smoke fixture"),
  };
  return handle;
}

/** Adapts the composed `Kernel` to `ui`'s narrower `KernelPort` — the same shape `create-
 *  shell.ts`'s own (unexported) `toKernelPort` builds. Duplicated here (not imported) because
 *  `create-shell.ts` does not export it, and this test's composition is deliberately one level
 *  below `createShell` (see this file's header on why `createShell` itself cannot be reused). */
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
        cachedHandle = toRealPreviewSessionHandle(session);
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

      // The turn's TERMINAL event, whichever kind it turns out to be — this file's header
      // (gap 1) documents why it is `turn.failed`, not `turn.completed`, today.
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
      // attempt. This holds regardless of gap 1's later, unrelated finalize-time failure:
      // Gate validation (`runTurnValidation`) always runs, and always runs BEFORE
      // `finalizeTurn` is ever reached (`core/turns/model/run-turn.ts`'s own sequencing) —
      // this turn only reached "finalizing" at all because Gate had already passed it.
      expect(envelopes.some((envelope) => envelope.kind === "turn.gateRejected")).toBe(false);

      // KNOWN BUG (this file's header, gap 1): the turn does NOT commit through the real
      // composed graph today. This assertion pins the EXACT current (broken) behavior —
      // `handlers/turn.ts`'s own generic `turn.failed` branch, citing the underlying
      // `finalized/failed` outcome — precisely so a future fix to gap 1 breaks this
      // assertion loudly, forcing this file to be updated to prove the real commit (and
      // then LINK 3 "render" and LINK 4 "export" below) rather than silently staying green
      // over a still-broken chain.
      expect(terminalEnvelope.kind).toBe("turn.failed");
      const failedPayload = terminalEnvelope.payload as EventPayloadByKindV1["turn.failed"];
      expect(failedPayload.failure?.safeMessage).toBe(
        "the turn ended without committing (finalized/failed)",
      );

      // The staged edit was real, even though it never reached the canonical store: the
      // fake agent's bytes exist in the (still-present, unretired-on-failure) turn workspace.
      expect(fs.existsSync(path.join(workspacePath, "pages", "home.tsx"))).toBe(true);
      expect(fs.readFileSync(path.join(workspacePath, "pages", "home.tsx"), "utf8")).toBe(
        HOME_PAGE_SOURCE,
      );

      // LINK 3 "render" and LINK 4 "export" are NOT asserted below — there is no genuinely
      // committed page for either to operate against while gap 1 stands (a real canonical
      // `pages/home/page.tsx` never lands on disk, and `pageMetaCache`/`preview.selectCurrent`/
      // `export.start` all key off that real, post-commit `sourceHash`). Faking a committed
      // sourceHash here to reach them anyway would be exactly the fabricated assertion this
      // task's own brief forbids. Once gap 1 closes, this test should:
      //   1. Read `changedPage.sourceHash` off a genuine `turn.completed` payload.
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
