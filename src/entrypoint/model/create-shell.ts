import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as errore from "errore";

import { createProductionAgentPromptSource, createProductionAgentRegistry } from "agent";
import { type KernelDeps, createKernel } from "core";
import type { Kernel } from "core/kernel";
import type { GateRunner, PreviewFrameV1, PreviewSession } from "core/ports";
import type { UUIDv7 } from "core/protocol";
import { createGateRunnerAdapter, resolveCompilerPath } from "gate";
import type { SmokeRenderer } from "gate";
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
  sweepStaleScratchDirs,
} from "host/supervisor";
import type { SpawnFn } from "host/supervisor";
import { systemClock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";
import { RUNTIME_DTS } from "runtime/generated/runtime-dts";
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

import type { EntrypointMode, ShellLaunchV1, ShellWithAgentRegistry } from "../types";

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
): Promise<ShellCompositionError | ShellWithAgentRegistry> {
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
): Promise<ShellCompositionError | ShellWithAgentRegistry> {
  // The Gate's `typeCheck` stage needs a spawnable `tsc` resolved from the INSTALLED
  // `typescript` package (Task 4's `resolveCompilerPath()`, `gate/model/tsc-extract.ts`) —
  // resolved here, first, before any project I/O runs. A failed resolution surfaces as a
  // `ShellCompositionError` and aborts the WHOLE shell construction; it is never swallowed
  // into a degraded `GateRunner` with `typeCheck` silently omitted, which would let the Gate
  // pass a candidate page it never actually type-checked. This is a DELIBERATE reversal of
  // this file's own pre-Task-7 behavior: the old `resolveShellCompilerAssets()` helper caught
  // exactly this failure with `console.warn(...)` and returned `undefined`, letting
  // `createGateRunnerAdapter` build a shell whose Gate quietly never type-checked anything for
  // the rest of the run. phase-8 design §WP-2's acceptance gate ("the Gate catches a
  // deliberate type error ... in the shipped configuration") requires the opposite: a run
  // with no working type checker must not start at all.
  const compilerPath = resolveCompilerPath();
  if (compilerPath instanceof Error) {
    return new ShellCompositionError({
      root: env.root,
      reason: `could not resolve the TypeScript compiler for the Gate's type-check stage: ${compilerPath.message}`,
      cause: compilerPath,
    });
  }

  const userStateRoot = deps.userStateRoot ?? resolveDefaultUserStateRoot();
  const store = createStore(nodeStoreDeps({ userStateRoot }));

  const prepared = await openOrCreateProject(store, env.root);
  if (prepared instanceof Error) return prepared;
  const { open, existing } = prepared;

  const resolvedEnv = await resolveEnvWithProjectIdentity(env, open, existing);

  // Evaluated BEFORE the Kernel is constructed — it must precede the startup dispatch
  // (`run-app.ts`'s Gap D dispatch), because `deriveScreen` keys on `projectId`, which
  // `finishOpen` sets: by the time the command has gone, the screen is already decided (spec
  // §3.2). The probe is skipped entirely for a freshly created project — a real I/O round trip
  // would only ever confirm what `existing` already says, since a fresh directory never held
  // anything before `openOrCreateProject` just created it — so `contentProbe` stays the
  // definite `"no-content"` without touching disk again.
  const contentProbe: ProjectContentProbeV1 = existing
    ? await probeProjectContent(open)
    : "no-content";
  const launch = resolveShellLaunch(existing, contentProbe);

  const storeAdapterDeps: StoreAdapterDeps = { open, uuidv7, clock: systemClock };
  const projections = createProjectionsAdapter(storeAdapterDeps);
  const chatStore = createChatStoreAdapter(storeAdapterDeps);
  const pageStore = createPageStoreAdapter(storeAdapterDeps);
  const pinStore = createPinStoreAdapter(storeAdapterDeps);

  const execPath = deps.execPath ?? process.execPath;
  const srcRoot = deps.srcRoot ?? Bun.main;
  const spawnCommand = createHostSpawnCommand({ execPath, srcRoot });
  const spawn = deps.spawn ?? createBunSpawn();
  // Once per process, and ONLY on the production spawn path: a test that injects its own `spawn`
  // has no host children and must never reach into the real %TEMP%. Removes directories left by
  // runs that died without reaping (HANDOFF Finding 5).
  if (deps.spawn === undefined) sweepStaleScratchDirs();
  const hostClock = createHostClock();

  const hostSupervisorAdapter = createHostSupervisorAdapter({
    clock: hostClock,
    runtimeDeclaration: EMBEDDED_RUNTIME_DECLARATION,
    // The spawn command is fixed for the life of this process (there is exactly one spawn
    // shape now — phase-8 design §2 — so `execPath`/`srcRoot` never change mid-run), so
    // every session spec spawns the identical `_host --stdio` argv — `spec` itself carries
    // no information the command needs.
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

  // Captured once so the SAME registry both feeds the Kernel's own `agentRegistry` port AND is
  // exposed on the returned shell (`ShellWithAgentRegistry.agentRegistry`) for `run-app.ts`'s
  // Task 9 Home health probe — never two independently constructed registries drifting apart.
  const agentRegistry = createProductionAgentRegistry();

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
    gateRunner: buildGateRunner(compilerPath, smokeRenderer),
    hostSupervisor: hostSupervisorAdapter,
    exportRender: createExportRenderAdapter({
      spawn,
      command: spawnCommand,
      clock: hostClock,
      runtimeDeclaration: EMBEDDED_RUNTIME_DECLARATION,
    }),
    exportPublish: createExportPublishAdapter(storeAdapterDeps),
    agentRegistry,
    agentPromptSource: createProductionAgentPromptSource(),
    clock: systemClock,
  };

  const kernel = createKernel(kernelDeps);
  const port = toKernelPort(kernel);

  let closed = false;
  return {
    mode: "interactive",
    port,
    env: resolvedEnv,
    agentRegistry,
    launch,
    // Reverse acquisition order: the Kernel (and the host children its active preview may
    // hold) release first, then any other still-live host process, then the project lease
    // last — `open` was acquired first, so it is released last. Each step is guarded (see
    // `closeShellResources`) so an early rejection can never skip a later one — most
    // importantly `open.close()`, which releases the project LEASE.
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await closeShellResources([
        { name: "kernel.close", run: () => kernel.close() },
        { name: "hostSupervisor.stopAll", run: () => hostSupervisorAdapter.stopAll() },
        { name: "open.close", run: () => open.close() },
      ]);
    },
  };
}

/**
 * Builds the production `GateRunner` — the exact composition `interactiveShell` wires into
 * `KernelDeps.gateRunner` above (phase-8 Task 7). Pairs the caller-resolved compiler executable
 * with `RUNTIME_DTS`, the generated ambient `@termcraft/runtime` declaration (Task 6,
 * `runtime/generated/runtime-dts.ts`). Importing `runtime/generated/runtime-dts` here is
 * correct even though `runtime` is a leaf: leafness constrains `runtime`'s own OUTGOING imports
 * only (docs/architecture/code-structure.md item 10), and item 11's forbidden-shapes table
 * carries no "X importing `runtime`" row — nothing bars this composition root, or any other
 * module, from importing `runtime`'s generated declaration text.
 *
 * `tscExePath` is taken as an already-resolved value, not re-resolved here, so
 * `interactiveShell`'s own `resolveCompilerPath()` call (at the top of that function, before any
 * project I/O) stays the ONE place a resolution failure is turned into a `ShellCompositionError`
 * — this function itself cannot fail.
 *
 * Exported (not an inline expression in `kernelDeps`) so `create-shell.test.ts` can exercise
 * this exact composition's real type-check behavior directly, with a fake `smokeRenderer` to
 * avoid spawning a real host process — `AppShell`/`KernelPort` expose no seam to reach a running
 * shell's internal `gateRunner` (only a live `turn.start` reaches it, which needs a real or fake
 * agent that `ShellDeps` has no seam to inject either; see that test file's own header comment).
 */
export function buildGateRunner(tscExePath: string, smokeRenderer: SmokeRenderer): GateRunner {
  return createGateRunnerAdapter({ smokeRenderer, tscExePath, runtimeDts: RUNTIME_DTS });
}

/** One teardown resource `AppShell.close()` releases, run in reverse-acquisition order. */
export interface ShellTeardownStep {
  readonly name: string;
  run(): Promise<void>;
}

/** A teardown step (`kernel.close`, `hostSupervisor.stopAll`, or `open.close`) rejected while
 *  closing the shell. Thrown once every step has run — `AppShell.close(): Promise<void>` has no
 *  return-value channel of its own, so a rejection is the only way to reach `runApp`'s existing
 *  `closeShell`, which already `.catch()`es exactly this shape and reports it via
 *  `boundary.reportFatal` — the same path a single ungoverned failure already took before this
 *  isolation existed. */
export class ShellTeardownError extends errore.createTaggedError({
  name: "ShellTeardownError",
  message: "$step failed while closing the shell",
}) {}

/**
 * Runs every step regardless of an earlier one's rejection — the same "settle everything, don't
 * short-circuit" semantics as `Promise.allSettled`, without its per-entry `{status, value}`
 * union. This matters because the steps are NOT independent in importance: the LAST step,
 * `open.close()`, releases the project LEASE, and must run even when the FIRST step
 * (`kernel.close()`) rejects — a plain sequential `await` chain would abandon the lease on
 * exactly that failure. Each step's rejection is `.catch()`-converted to a `ShellTeardownError`
 * right here, at this exact boundary with the uncontrolled step (errore's own "only `.catch()` at
 * the edge" rule) — never allowed to propagate and skip the steps after it. Once every step has
 * settled, the FIRST failure — in the caller's own reverse-acquisition order — is surfaced by
 * throwing it (see {@link ShellTeardownError}'s own doc comment for why a throw, not a return
 * value, is correct here).
 */
export async function closeShellResources(steps: readonly ShellTeardownStep[]): Promise<void> {
  const failures: ShellTeardownError[] = [];
  for (const step of steps) {
    const result = await step.run().then(
      () => undefined,
      (cause: unknown) => new ShellTeardownError({ step: step.name, cause }),
    );
    if (result instanceof Error) failures.push(result);
  }
  const [firstFailure] = failures;
  if (firstFailure !== undefined) throw firstFailure;
}

/** `openOrCreateProject`'s own result, pairing the `OpenProject` handle with whether it came
 *  from `Store.openProject` succeeding (an EXISTING project) or the `Store.createProject`
 *  fallback (a fresh directory) — the discriminator Gap D needs and the pre-fix code threw away
 *  (see {@link ShellLaunchV1}'s own doc comment, `../types.ts`). */
interface OpenedProjectV1 {
  readonly open: OpenProject;
  readonly existing: boolean;
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
): Promise<ShellCompositionError | OpenedProjectV1> {
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
  if (!(opened instanceof Error)) return { open: opened, existing: true };

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
  return { open: created, existing: false };
}

/**
 * The three outcomes reading a project's pages and chats can produce (fix round 1, Finding 1).
 * `"no-content"` is a DEFINITE fact — reserved for the one case both reads actually succeeded
 * and both came back empty. A read that fails establishes nothing about the disk at all, so it
 * is never folded into that negative: the Global Constraints govern here over the brief's own
 * `return false` snippet — "Never fabricate a fact. A port that cannot answer honestly refuses
 * (logged) rather than substituting a placeholder" — and `false`/"no content" is exactly such a
 * placeholder for an unread disk.
 */
export type ProjectContentProbeV1 = "has-content" | "no-content" | "unknown";

/**
 * "At least one page, or at least one chat" (fix-bundle spec §2.4). Both signals are already
 * available at open with no extra I/O beyond one manifest read and one chat listing:
 * `project.toml` carries the `pages` list the open sequence reads anyway, and chat presence
 * comes free with Gap E's listing (`ChatStore.list()`, `store/model/chat-listing.ts`).
 *
 * A read failure resolves `"unknown"`, never `"no-content"` (fix round 1, Finding 1) — logged
 * either way (errore rule 21). `"unknown"` is folded into a dispatch-anyway decision by
 * {@link resolveShellLaunch}, not into a silent Home: the Kernel's own open sequence
 * (`core/kernel/model/handlers/project.ts`'s `runProjectReadySequence`) re-reads the same two
 * facts and is the one place a genuine failure can reach the event stream a real client
 * observes — this composition-root probe's own `console.warn` fires during shell composition,
 * before `createUiRoot` has even taken the terminal, so it is not user-visible on its own.
 *
 * Exported — narrowed to `Pick<OpenProject, "manifest" | "chats">` — so `create-shell.test.ts`
 * can drive both failure branches directly against a narrow fake: a TRANSIENT failure on either
 * read, occurring AFTER `store.openProject` already succeeded, has no seam the real `Store`
 * exposes to inject honestly (a corrupt manifest, for one, would already have failed
 * `store.openProject` itself, before this function is ever called).
 */
export async function probeProjectContent(
  open: Pick<OpenProject, "chats" | "manifest">,
): Promise<ProjectContentProbeV1> {
  const manifest = await open.manifest.read();
  if (manifest instanceof Error) {
    console.warn(
      `termcraft: could not read the manifest to route the launch (${manifest.message}) — routing as unknown, not "no content"`,
    );
    return "unknown";
  }
  if (manifest.pages.length > 0) return "has-content";

  const chats = await open.chats.list();
  if (chats instanceof Error) {
    console.warn(
      `termcraft: could not list chats to route the launch (${chats.message}) — routing as unknown, not "no content"`,
    );
    return "unknown";
  }
  return chats.length > 0 ? "has-content" : "no-content";
}

/**
 * Turns `existing` (whether `store.openProject` itself succeeded) and the content probe into
 * the shell's own launch discriminator (fix round 1, Finding 1). `"unknown"` folds into
 * `hasContent: true`, exactly like `"has-content"` — dispatching `project.open` anyway is the
 * only honest response to "the disk could not confirm there is nothing here"; defaulting to
 * Home would assert the opposite fact the failed read never established. The `existing` gate is
 * unchanged: a freshly created project (`existing: false`) never reaches this with anything but
 * `"no-content"` (`interactiveShell` skips the probe entirely for it), so it always resolves
 * `hasContent: false` regardless of what `probe` would say.
 *
 * A pure function of its two inputs — exported and unit-tested directly (fix round 1) rather
 * than only indirectly through a disk-backed `createShell` fixture, since forcing the `"unknown"`
 * branch through real disk I/O is exactly what {@link probeProjectContent}'s own doc comment
 * explains the real `Store` has no seam for.
 */
export function resolveShellLaunch(existing: boolean, probe: ProjectContentProbeV1): ShellLaunchV1 {
  return { existing, hasContent: existing && probe !== "no-content" };
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
 *
 * `existing` (Gap D) also lands here as `UiEnv.projectExists` — the SAME open-vs-create fact
 * `ShellLaunchV1.existing` carries, set unconditionally regardless of whether the manifest read
 * below succeeds: it is known independently of the manifest's own content, and `home-submit`
 * (`ui/app/model/intent.ts`) needs it to pick `project.open` over `project.create`.
 */
async function resolveEnvWithProjectIdentity(
  env: UiEnv,
  open: OpenProject,
  existing: boolean,
): Promise<UiEnv> {
  const manifest = await open.manifest.read();
  if (manifest instanceof Error) {
    // errore rule 21: this branch does not propagate the error (there is no caller left to
    // hand a mid-composition failure to — `createShell` already committed to `open` above), so
    // it must log instead of swallowing it silently, or a genuine post-open manifest failure
    // would leave no trace anywhere.
    console.warn(
      `termcraft: could not read the project manifest (${manifest.message}); keeping the path-based workspaceIdentity ${env.workspaceIdentity}`,
    );
    return { ...env, projectExists: existing };
  }
  return { ...env, workspaceIdentity: manifest.projectId, projectExists: existing };
}

/**
 * `%LOCALAPPDATA%/termcraft` (the roadmap's per-user path) — this root holds the trust ledger
 * per storage-identity (`trust/`), plus `sandboxes/`/`backups/`, so it needs its own namespaced
 * directory regardless of anything TypeScript-compiler-related; there is no longer a tsc
 * extraction cache under this root to mirror (phase-8 WP-1 deleted it — `gate/model
 * /tsc-extract.ts` now resolves the installed compiler directly, materializing nothing to disk).
 * Falls back to `<tmpdir>/termcraft`, not the bare OS temp dir, so it stays namespaced there too.
 */
function resolveDefaultUserStateRoot(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData !== undefined && localAppData.length > 0) {
    return path.join(localAppData, "termcraft");
  }
  return path.join(os.tmpdir(), "termcraft");
}

/**
 * Adapts the composed `Kernel` (`dispatch`/`events`/`currentPreview`/
 * `currentPreviewSessionId`/`publishFrame`/`acknowledgeDisplay`) to the `KernelPort`
 * (`dispatch`/`subscribe`/`preview`) `ui` depends on. `dispatch`/`subscribe` are passed
 * through directly — `Kernel`'s own `CommandDecodeError | CanonicalHashError`/
 * `EventBusPayloadError` return types are already narrower than the port's widened `Error`,
 * so no wrapping is needed. `preview` caches the adapted `PreviewSessionHandle` by the
 * underlying `PreviewSession` reference: `ui`'s own frame-consuming loop
 * (`ui/app/model/deps.ts`) calls `port.preview()` repeatedly while the SAME session stays
 * current, and a fresh wrapper on every call would restart `frames`'s async generator each
 * time — mirroring `FakeKernel.preview()`'s own "return the same stored handle" behavior.
 *
 * FIX ROUND 1, FINDING 3: `previewSessionId` now comes from `kernel.currentPreviewSessionId()`
 * — the SAME Kernel-minted id every `preview.*` event's own `previewSessionId` field carries
 * — not `session.identity.sessionId` (the host-internal id `toPreviewSessionHandle` used to
 * read here, which can never equal the Kernel's own id: `core/preview/model/
 * session-commands.ts`'s own header says so explicitly). Before this fix,
 * `ui/preview/model/interaction.ts`'s `handleGeometryResult` compared
 * `current.handle.previewSessionId !== payload.previewSessionId` and NEVER passed for a real
 * session, silently discarding every geometry result. If the two ever disagree now (should be
 * unreachable — `core/kernel/model/kernel.ts`'s `currentPreviewSessionId` doc comment explains
 * why `currentPreview()`/`currentPreviewSessionId()` always agree), this surfaces "no session"
 * rather than build a handle with a fabricated id.
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
        const previewSessionId = kernel.currentPreviewSessionId();
        if (previewSessionId === null) {
          console.warn(
            "entrypoint: kernel.currentPreview() is non-null but currentPreviewSessionId() is null — defensive, should be unreachable; treating as no session rather than fabricating an id",
          );
          cachedSession = null;
          cachedHandle = null;
          return null;
        }
        cachedSession = session;
        cachedHandle = toPreviewSessionHandle(kernel, session, previewSessionId);
      }
      return cachedHandle;
    },
  };
}

/**
 * Adapts one live `PreviewSession` into the `ui`-facing `PreviewSessionHandle` (phase-8
 * Task 16 closure — `preview.acknowledgeDisplay`'s wiring). Pairs every frame the
 * host-owned `session.frames` async iterable yields with a REAL ledger-minted
 * `FrameTokenV1` (`kernel.publishFrame`, kernel-command-contract §8.1: "For each
 * frame-stream item, the Kernel mints a `FrameTokenV1`") and forwards the UI's typed
 * display acknowledgement to the SAME Kernel authority (`kernel.acknowledgeDisplay`) —
 * replacing the fabricated `uuidv7()` this function used to mint locally and the
 * unconditional `FrameAcknowledgeNotWiredError` `acknowledgeDisplay` used to return
 * (both removed by this same change; see git history for the prior shape).
 *
 * Exported — not an inline closure inside `toKernelPort` — so `create-shell.test.ts` can
 * exercise this exact composition directly with a lightweight `Kernel` double backed by a
 * REAL `FrameTokenLedger`: the same testability reason `buildGateRunner`, above, is
 * already exported for.
 *
 * `kernel` is narrowed to `Pick<Kernel, "publishFrame" | "acknowledgeDisplay">`: this
 * function never dispatches a command or reads a snapshot, so it depends on nothing
 * beyond the two frame-token methods it actually calls. `previewSessionId` is taken as an
 * explicit parameter (fix round 1, Finding 3) rather than read a third time from `kernel`
 * here — `toKernelPort`'s own `preview()` already resolved and validated it once per fresh
 * session, and re-reading it here could in principle observe a DIFFERENT value if the
 * Kernel's own session churned between the two calls.
 *
 * A frame published with no live Kernel session (`PreviewNoLiveSessionError` — a real, if
 * narrow, race between `session.frames` yielding and the Kernel's own bookkeeping already
 * observing the session as closed) is DROPPED, logged, and never forwarded with an
 * invented token: a `UiPreviewFrame` without a genuine, ledger-recognized `frameToken`
 * would violate its own contract worse than skipping one frame (errore rule 21: an error
 * that is not propagated must still be logged).
 */
export function toPreviewSessionHandle(
  kernel: Pick<Kernel, "acknowledgeDisplay" | "publishFrame">,
  session: PreviewSession,
  previewSessionId: UUIDv7,
): PreviewSessionHandle {
  async function* displayFrames(): AsyncGenerator<UiPreviewFrame> {
    for await (const frame of session.frames) {
      const frameToken = kernel.publishFrame(frame);
      if (frameToken instanceof Error) {
        console.warn(`entrypoint: dropped a preview frame — ${frameToken.message}`);
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

function demoShell(env: UiEnv): ShellWithAgentRegistry {
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
    // No real agent to probe in an offline demo (`ShellWithAgentRegistry`'s own doc comment)
    // — `run-app.ts`'s `resolveAgentHealthProbe` treats `null` as "leave `createUiDeps`'s
    // default probe in place", preserving demo's existing seeded reading exactly.
    agentRegistry: null,
    // A demo owns no project on disk (Gap D) — never an existing project, never any content
    // to route a startup `project.open` dispatch against.
    launch: { existing: false, hasContent: false },
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
