import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as errore from "errore";

import { createProductionAgentRegistry } from "agent";
import { type KernelDeps, createKernel } from "core";
import type { Kernel } from "core/kernel";
import type { PreviewFrameV1, PreviewSession } from "core/ports";
import { createGateRunnerAdapter } from "gate";
import {
  createExportRenderAdapter,
  createHostSupervisorAdapter,
  createSmokeRendererAdapter,
} from "host";
import { EMBEDDED_RUNTIME_DECLARATION } from "host/protocol";
import {
  createBunSpawn,
  createSystemClock as createHostClock,
  createHostSpawnCommand,
} from "host/supervisor";
import type { SpawnFn } from "host/supervisor";
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
import type { OpenProject, Store, StoreAdapterDeps } from "store";
import type { KernelPort, PreviewSessionHandle, UiEnv, UiPreviewFrame } from "ui";
import { TEST_SHA, createFakeKernel, createFakePreviewSession } from "ui/testing";

import type { AppShell, EntrypointMode } from "../types";

/**
 * Builds the Kernel boundary one run drives.
 *
 * `demo` always runs the in-memory `ui`-owned kernel (`ui/testing`'s fakes) — it needs no
 * credentials, spawns no design host, and never reads or writes a project on disk. `interactive`
 * composes the REAL graph: `createStore(nodeStoreDeps(...))` opens (or creates) the caller's
 * project, the `store`/`gate`/`host`/`agent` adapters wrap it and the injected host-spawn
 * seam, `createKernel(deps)` assembles the seven machines over those adapters, and
 * {@link toKernelPort} adapts the composed `Kernel` (`dispatch`/`events`/`currentPreview`) to
 * the narrower `KernelPort` (`dispatch`/`subscribe`/`preview`) `ui` depends on. The `ui/testing`
 * import below serves ONLY the demo path from here on.
 */
export async function createShell(
  mode: EntrypointMode,
  env: UiEnv,
  deps: ShellDeps = {},
): Promise<ShellCompositionError | AppShell> {
  return mode === "demo" ? demoShell(env) : interactiveShell(env, deps);
}

/**
 * Overrides for the seams `interactiveShell` otherwise computes from the real process —
 * injected only by tests (mirrors `RunAppOptions.adapters`'s own injection-for-tests shape).
 */
export interface ShellDeps {
  /** Defaults to `%LOCALAPPDATA%/termcraft` (see {@link resolveDefaultUserStateRoot}). */
  readonly userStateRoot?: string;
  readonly execPath?: string;
  readonly isCompiled?: boolean;
  readonly srcRoot?: string;
  readonly spawn?: SpawnFn;
}

/** A project at `env.root` could neither be opened nor created — the composition root has no
 *  real graph to build a Kernel around. */
export class ShellCompositionError extends errore.createTaggedError({
  name: "ShellCompositionError",
  message: "could not prepare a project at $root: $reason",
}) {}

async function interactiveShell(
  env: UiEnv,
  deps: ShellDeps,
): Promise<ShellCompositionError | AppShell> {
  const userStateRoot = deps.userStateRoot ?? resolveDefaultUserStateRoot();
  const store = createStore(nodeStoreDeps({ userStateRoot }));

  const open = await openOrCreateProject(store, env.root);
  if (open instanceof Error) return open;

  const resolvedEnv = await resolveEnvWithProjectIdentity(env, open);

  const storeAdapterDeps: StoreAdapterDeps = { open, uuidv7, clock: systemClock };
  const projections = createProjectionsAdapter(storeAdapterDeps);
  const chatStore = createChatStoreAdapter(storeAdapterDeps);
  const pageStore = createPageStoreAdapter(storeAdapterDeps);
  const pinStore = createPinStoreAdapter(storeAdapterDeps);

  const execPath = deps.execPath ?? process.execPath;
  const isCompiled = deps.isCompiled ?? isCompiledBinary(execPath);
  const srcRoot = deps.srcRoot ?? Bun.main;
  const spawnCommand = createHostSpawnCommand({ execPath, isCompiled, srcRoot });
  const spawn = deps.spawn ?? createBunSpawn();
  const hostClock = createHostClock();

  const hostSupervisorAdapter = createHostSupervisorAdapter({
    clock: hostClock,
    runtimeDeclaration: EMBEDDED_RUNTIME_DECLARATION,
    // The spawn command is fixed for the life of this process (the execPath-vs-dev branch
    // Spike E fixes never changes mid-run), so every session spec spawns the identical
    // `_host --stdio` argv — `spec` itself carries no information the command needs.
    spawnFor: () => spawnCommand,
    spawn,
    mintSessionId: uuidv7,
  });
  const smokeRenderer = createSmokeRendererAdapter({
    spawnFor: () => spawnCommand,
    spawn,
    clock: hostClock,
    runtimeDeclaration: EMBEDDED_RUNTIME_DECLARATION,
  });

  const kernelDeps: KernelDeps = {
    projectStore: createProjectStoreAdapter(storeAdapterDeps),
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
    gateRunner: createGateRunnerAdapter({ smokeRenderer }),
    hostSupervisor: hostSupervisorAdapter,
    exportRender: createExportRenderAdapter({
      spawn,
      command: spawnCommand,
      clock: hostClock,
      runtimeDeclaration: EMBEDDED_RUNTIME_DECLARATION,
    }),
    exportPublish: createExportPublishAdapter(storeAdapterDeps),
    agentRegistry: createProductionAgentRegistry(),
    clock: systemClock,
  };

  const kernel = createKernel(kernelDeps);
  const port = toKernelPort(kernel);

  let closed = false;
  return {
    mode: "interactive",
    port,
    env: resolvedEnv,
    // Reverse acquisition order: the Kernel (and the host children its active preview may
    // hold) release first, then any other still-live host process, then the project lease
    // last — `open` was acquired first, so it is released last.
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await kernel.close();
      await hostSupervisorAdapter.stopAll();
      await open.close();
    },
  };
}

/**
 * Opens the caller's project, creating it first when `root` is not one yet. `project.create`'s
 * own Kernel handler cannot perform this itself (`core/kernel/model/handlers/project.ts`'s own
 * header: no `core/ports` primitive calls `store.createProject` — `KernelDeps` assumes an
 * already-open project), so the composition root does it here, eagerly, before the Kernel is
 * ever constructed — the only way the roadmap's own success criteria ("from an empty directory
 * ... a prompt creates the project") can hold for a genuinely fresh directory.
 */
async function openOrCreateProject(
  store: Store,
  root: string,
): Promise<ShellCompositionError | OpenProject> {
  // Both `Store.openProject` and `Store.createProject` run a pre-flight durability probe
  // that opens `root` itself with Win32 `OPEN_EXISTING` (`store/model/factory.ts`'s own
  // header: "the flush probe targets `root` ... which is guaranteed to exist here") — a
  // real-world gap the fakes never surface, since a genuinely fresh `bun start <newDir>`
  // names a directory that does not exist on disk yet. `createProject` only ever creates
  // `.termcraft` INSIDE `root`, never `root` itself, so the composition root creates it
  // first, exactly once, before either store call runs.
  const ensured = ensureRootDirectory(root);
  if (ensured instanceof Error) {
    return new ShellCompositionError({
      root,
      reason: `could not create the project root directory: ${ensured.message}`,
      cause: ensured,
    });
  }

  const opened = await store.openProject(root);
  if (!(opened instanceof Error)) return opened;

  const created = await store.createProject({
    root,
    name: deriveProjectName(root),
    // The only target stack this binary's own runtime facade (`@termcraft/runtime`,
    // `EMBEDDED_RUNTIME_DECLARATION.module`) and Gate actually validate/render pages for
    // today — a fact about this MVP's supported stack, not an invented design value.
    targetStack: "js-opentui",
  });
  if (created instanceof Error) {
    return new ShellCompositionError({
      root,
      reason: `open failed (${opened.message}); create failed (${created.message})`,
      cause: created,
    });
  }
  return created;
}

/** A thrown `mkdirSync` rejection, converted to a value at this sync-boundary (errore's
 *  `.try` rule) — `root` pre-existing is the common case and never reaches this branch. */
class RootDirectoryError extends errore.createTaggedError({
  name: "RootDirectoryError",
  message: "could not create $root",
}) {}

function ensureRootDirectory(root: string): RootDirectoryError | undefined {
  return errore.try({
    try: () => {
      fs.mkdirSync(root, { recursive: true });
      return undefined;
    },
    catch: (cause) => new RootDirectoryError({ root, cause }),
  });
}

function deriveProjectName(root: string): string {
  const base = path.basename(root);
  return base.length > 0 ? base : "termcraft-project";
}

/**
 * A durable `projectId` is a far more stable "workspace identity" than the raw filesystem path
 * (a rename/move would otherwise silently change it) — `agent/session/model/session-scope.ts`'s
 * `deriveSessionScope` folds `workspaceIdentity` into the SDK session-resume key precisely
 * because it is meant to name the SAME workspace across relaunches. A manifest read failing
 * immediately after a successful open/create would be a genuine bug elsewhere, not something to
 * paper over: this keeps the caller-supplied path-based value rather than inventing a projectId.
 */
async function resolveEnvWithProjectIdentity(env: UiEnv, open: OpenProject): Promise<UiEnv> {
  const manifest = await open.manifest.read();
  if (manifest instanceof Error) return env;
  return { ...env, workspaceIdentity: manifest.projectId };
}

/**
 * `%LOCALAPPDATA%/termcraft`, matching `gate/model/tsc-extract.ts`'s own established per-user
 * cache convention (roadmap phase 8) — the same physical root, a different subdirectory
 * (`trust/`, `sandboxes/`, `backups/` per storage-identity, vs. that module's `tsc-<version>/`).
 * Falls back to `<tmpdir>/termcraft`, not the bare OS temp dir: unlike a tsc extraction cache,
 * this root also holds the trust ledger, so it stays namespaced even on that path.
 */
function resolveDefaultUserStateRoot(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData !== undefined && localAppData.length > 0) {
    return path.join(localAppData, "termcraft");
  }
  return path.join(os.tmpdir(), "termcraft");
}

/**
 * The installed `bun-types@1.3.14` does not yet declare `Bun.isStandaloneExecutable` (a newer
 * Bun API), and `Bun.embeddedFiles` stays empty either way until WP-11/B7 embeds real file
 * assets — neither is a reliable "am I compiled" signal for this build today. Spike E
 * (`docs/spikes/05-host-respawn/FINDINGS.md`) confirms `process.execPath` inside a compiled
 * binary resolves to the exe's own real on-disk path, while under `bun run` it resolves to the
 * Bun CLI binary itself — so comparing its basename against the Bun runtime's own executable
 * names is the honest interim detection this composition root can perform without a cast.
 * Revisit once `bun-types` declares `Bun.isStandaloneExecutable`.
 */
function isCompiledBinary(execPath: string): boolean {
  const name = path.basename(execPath).toLowerCase();
  return name !== "bun" && name !== "bun.exe";
}

/**
 * Adapts the composed `Kernel` (`dispatch`/`events`/`currentPreview`) to the `KernelPort`
 * (`dispatch`/`subscribe`/`preview`) `ui` depends on. `dispatch`/`subscribe` are passed through
 * directly — `Kernel`'s own `CommandDecodeError | CanonicalHashError`/`EventBusPayloadError`
 * return types are already narrower than the port's widened `Error`, so no wrapping is needed.
 * `preview` caches the adapted `PreviewSessionHandle` by the underlying `PreviewSession`
 * reference: `ui`'s own frame-consuming loop (`ui/app/model/deps.ts`) calls `port.preview()`
 * repeatedly while the SAME session stays current, and a fresh wrapper on every call would
 * restart `frames`'s async generator each time — mirroring `FakeKernel.preview()`'s own
 * "return the same stored handle" behavior.
 */
function toKernelPort(kernel: Kernel): KernelPort {
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
        cachedHandle = toPreviewSessionHandle(session);
      }
      return cachedHandle;
    },
  };
}

/**
 * `preview.acknowledgeDisplay` is NOT wired to a real frame-token authority. `Kernel`'s public
 * surface (`core/kernel/types.ts`) exposes only `currentPreview(): PreviewSession | null` —
 * never the `frameTokenLedger`/`previewSessionCommands` `core/preview` builds internally — and
 * even reaching those, `FrameIdentityV1.nonce` (kernel-command-contract §4/§12.5) has no source
 * at this boundary: `PreviewIdentityV1` is documented as "the incarnation identity minus the
 * volatile nonce" (`core/ports/preview-session.ts`). This mirrors `host/adapters/
 * host-supervisor.ts`'s own already-documented `query`/`setTheme` "NOT WIRED" precedent
 * (blocker B1): hover/click-to-pin geometry queries are unusable either way until that gap
 * closes, so this degrades the SAME already-unwired feature, not a new one — the preview still
 * streams and renders, only the geometry-authorizing handshake no-ops.
 */
export class FrameAcknowledgeNotWiredError extends errore.createTaggedError({
  name: "FrameAcknowledgeNotWiredError",
  message:
    "preview.acknowledgeDisplay is not wired: the Kernel exposes no frame-token ledger at this boundary, and PreviewIdentityV1 carries no nonce to build a genuine FrameIdentityV1 from (blocker B1)",
}) {}

function toPreviewSessionHandle(session: PreviewSession): PreviewSessionHandle {
  async function* displayFrames(): AsyncGenerator<UiPreviewFrame> {
    for await (const frame of session.frames) {
      yield { frame, frameToken: uuidv7(), handle };
    }
  }

  const handle: PreviewSessionHandle = {
    previewSessionId: session.identity.sessionId,
    session,
    frames: { [Symbol.asyncIterator]: displayFrames },
    acknowledgeDisplay: () => new FrameAcknowledgeNotWiredError(),
  };
  return handle;
}

function demoShell(env: UiEnv): AppShell {
  const preview = createFakePreviewSession({ pageSlug: DEMO_PAGE_SLUG });
  const port = createFakeKernel({
    snapshot: {
      projectId: uuidv7(),
      activePageSlug: DEMO_PAGE_SLUG,
      activeChatId: uuidv7(),
      trust: "trusted",
      capabilities: [
        { id: "chat.create", target: null, state: { available: true } },
        { id: "turn.start", target: null, state: { available: true } },
        { id: "export.start", target: null, state: { available: true } },
      ],
      pageDescriptors: [
        {
          status: "ready",
          pageSlug: DEMO_PAGE_SLUG,
          sourceHash: TEST_SHA,
          title: "Main",
          minSize: { w: 80, h: 24 },
          theme: "dark-default",
          kitApiVersion: 1,
        },
      ],
    },
  });
  port.setPreview(preview.handle);
  preview.pushFrame(demoFrame(preview.handle.previewSessionId));

  let closed = false;
  return {
    mode: "demo",
    port,
    env,
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      preview.end();
      return Promise.resolve();
    },
  };
}

const DEMO_PAGE_SLUG = "main";

/**
 * One static frame standing in for a host-rendered page. Every run is `"default"`/`"default"`:
 * frame colors belong to the design pages the host renders, and this module has no design
 * source to take them from — inventing hex values here would put unapproved color in the
 * preview region.
 */
function demoFrame(sessionId: string): PreviewFrameV1 {
  const lines = [
    "termcraft demo preview",
    "",
    "This frame is served by the in-memory kernel.",
    "The design host is not spawned in demo mode.",
  ];
  return {
    sessionId,
    sourceHash: TEST_SHA,
    frameSeq: "1",
    width: Math.max(...lines.map((line) => line.length)),
    height: lines.length,
    rows: lines.map((text) => [{ text, fg: "default", bg: "default", attrs: 0 } as const]),
  };
}
