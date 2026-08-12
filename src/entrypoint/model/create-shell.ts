import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as errore from "errore";

import { createProductionAgentPromptSource, createProductionAgentRegistry } from "agent";
import { type KernelDeps, createKernel } from "core";
import type { Kernel } from "core/kernel";
import type {
  DesignSystemInstallPort,
  DesignSystemQuarantinePort,
  DesignSystemSource,
  GateRunner,
  PreviewFrameV1,
  PreviewSession,
} from "core/ports";
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
import { log } from "infrastructure/debug-log";
import { formatFsIdentity } from "infrastructure/fs-guard";
import { uuidv7 } from "infrastructure/uuid";
import { RUNTIME_DTS } from "runtime/generated/runtime-dts";
import {
  createChatStoreAdapter,
  createDesignSourceAdmission,
  createDesignStoreAdapter,
  createDesignSystemInstallAdapter,
  createDesignSystemQuarantineAdapter,
  createDesignSystemSourceAdapter,
  createExportPublishAdapter,
  createLocalDesignSystemSource,
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
  localLibraryDir,
  nodeDesignSystemFsDeps,
  nodeStoreDeps,
} from "store";
import type { OpenProject, Store, StoreAdapterDeps } from "store";
import { ManifestMigrationRequiredError } from "store/toml";
import type { KernelPort, PreviewSessionHandle, UiEnv, UiPreviewFrame } from "ui";
import { TEST_SHA, createFakeKernel, createFakePreviewSession } from "ui/testing";

import type {
  EntrypointMode,
  MigrationRequiredV1,
  ShellLaunchV1,
  ShellWithAgentRegistry,
} from "../types";
import { createGateDesignChecker } from "./design-checker";

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
  options?: ShellOptions,
): Promise<ShellCompositionError | MigrationRequiredV1 | ShellWithAgentRegistry> {
  return mode === "demo" ? demoShell(env) : interactiveShell(env, deps, options);
}

/**
 * Caller-supplied seeding for the shell this call builds — distinct from {@link ShellDeps}, which
 * overrides the seams `interactiveShell` otherwise computes from the real process. Only
 * `bootstrap.ts`'s post-migration `createShell` call passes either field today: the FIRST
 * `createShell` call in a run never has a migration to seed a draft from.
 *
 * `seedTurnText` is retained plumbing, not the live path: `bootstrap.ts` no longer passes it in
 * production (design-systems §9 / plan P4 decision D8 — an auto-run turn is actively harmful right
 * after a migration, see {@link ShellWithAgentRegistry.seedTurnText}'s own doc comment). Only
 * `seedComposerText` is passed by the real post-migration call; `seedTurnText` stays declared and
 * tested as a still-live protocol path (`project.open`'s own `text` payload), never removed as
 * churn this plan does not need.
 */
export interface ShellOptions {
  /** Threaded straight through to {@link ShellWithAgentRegistry.seedTurnText} — see that field's
   *  own doc comment (`../types.ts`) for why nothing in production passes this any more. */
  readonly seedTurnText?: string;
  /** Threaded straight through to {@link ShellWithAgentRegistry.seedComposerText} — see that
   *  field's own doc comment (`../types.ts`). */
  readonly seedComposerText?: string;
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

/**
 * THE store construction, extracted so `bootstrap`'s pre-Kernel migration branch (`store:
 * createStoreForShell(deps.shell)`, ahead of `runMigrationPrompt`) builds a store the same way
 * `interactiveShell` does below, instead of re-deriving `nodeStoreDeps({...})` a second time.
 * The real reason is ONE consistent `userStateRoot` resolution shared by both call sites — not
 * lease contention: construction itself takes no lease (`createStore` just wires adapters), so
 * `bootstrap` legitimately builds TWO independent stores over the same project across a
 * migration run (this one for the pre-Kernel `migrateProject` call, then `interactiveShell`'s own
 * for the post-migration `createShell` retry) — that only works because the first store's lease,
 * acquired inside `migrateProject` itself, is released before the second one ever calls
 * `openProject`.
 */
/** The ONE resolution `createStoreForShell` and `interactiveShell` both use — see
 *  {@link createStoreForShell}'s own doc comment for why two call sites legitimately exist, and
 *  `interactiveShell`'s own use of this same helper (never a second, independent
 *  `resolveDefaultUserStateRoot()` call) for why the design-system library composed alongside the
 *  store below is guaranteed to land under the SAME per-user root (project-design-systems §8.2). */
function resolveUserStateRootForShell(deps?: ShellDeps): string {
  return deps?.userStateRoot ?? resolveDefaultUserStateRoot();
}

export function createStoreForShell(deps?: ShellDeps): Store {
  return createStore(nodeStoreDeps({ userStateRoot: resolveUserStateRootForShell(deps) }));
}

async function interactiveShell(
  env: UiEnv,
  deps: ShellDeps,
  options?: ShellOptions,
): Promise<ShellCompositionError | MigrationRequiredV1 | ShellWithAgentRegistry> {
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

  // Hoisted so it is resolved EXACTLY ONCE and shared by `nodeStoreDeps` below and
  // `buildDesignSystemDeps` further down — project-design-systems §8.2 requires the
  // design-system library to live under the SAME per-user root as `trust/`/`sandboxes/`, and a
  // second independent `resolveDefaultUserStateRoot()` call could never be proven to agree with
  // the first if the two were ever computed differently (`ShellDeps.userStateRoot` is caller
  // input in tests; `resolveDefaultUserStateRoot()` reads `process.env.LOCALAPPDATA`, which does
  // not change mid-process, but "does not change" is not "is not called twice").
  const userStateRoot = resolveUserStateRootForShell(deps);
  const store = createStore(nodeStoreDeps({ userStateRoot }));

  const prepared = await openOrCreateProject(store, env.root);
  if (prepared instanceof Error) return prepared;
  // The offer travels to `bootstrap` untouched: no Kernel, no adapters, no UI root is built for a
  // project that is not opening (design-tree §12.1).
  if ("kind" in prepared) return prepared;
  const { open, existing } = prepared;

  const resolvedEnv = await resolveEnvWithProjectIdentity(env, open, existing);

  const launch: ShellLaunchV1 = { existing };

  const storeAdapterDeps: StoreAdapterDeps = { open, uuidv7, clock: systemClock };
  const projections = createProjectionsAdapter(storeAdapterDeps);
  const chatStore = createChatStoreAdapter(storeAdapterDeps);
  const pageStore = createDesignStoreAdapter(storeAdapterDeps);
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

  // ONE `GateRunner`, TWO CONSUMERS, and that is deliberate (spec WP-10, Task 12). The Kernel
  // gets it as `kernelDeps.gateRunner` for the turn's own validation; the agent gets it —
  // wrapped as a `DesignCheckerPort` — behind its in-process `check_design` tool. Two
  // independently built runners would mean the mid-attempt self-check and the verdict that
  // rejects the attempt could disagree about the same tree, which is the one thing a self-check
  // must never do. `agent` never sees `gate` at all: it declares the port, this root injects it.
  const gateRunner = buildGateRunner(compilerPath, smokeRenderer);

  // Captured once so the SAME registry both feeds the Kernel's own `agentRegistry` port AND is
  // exposed on the returned shell (`ShellWithAgentRegistry.agentRegistry`) for `run-app.ts`'s
  // Task 9 Home health probe — never two independently constructed registries drifting apart.
  const agentRegistry = createProductionAgentRegistry(createGateDesignChecker(gateRunner));

  // project-design-systems §8.2: the library lives under the SAME per-user root as `trust/`,
  // `sandboxes/` and `backups/` (`userStateRoot`, resolved ONCE above), so the ledger and the
  // library can never disagree about which machine they are on. See `buildDesignSystemDeps`'s
  // own doc comment for the composition and D9's grant-but-record handling of `local`.
  const designSystemDeps = await buildDesignSystemDeps(userStateRoot, storeAdapterDeps);

  const kernelDeps: KernelDeps = {
    projectStore: createProjectStoreAdapter(storeAdapterDeps),
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
    gateRunner,
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
    ...designSystemDeps,
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
    seedTurnText: options?.seedTurnText ?? null,
    seedComposerText: options?.seedComposerText ?? null,
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

/** The four `KernelDeps` fields project-design-systems §8.1/§8.3/§8.5 (Wave 3 / P10) add — see
 *  {@link buildDesignSystemDeps}'s own doc comment for how each is built. */
export interface DesignSystemKernelDeps {
  readonly designSystemSource: DesignSystemSource;
  readonly designSystemQuarantine: DesignSystemQuarantinePort;
  readonly designSystemInstall: DesignSystemInstallPort;
  readonly designSystemIsGranted: (source: DesignSystemSource) => Promise<boolean>;
}

/**
 * Builds the design-system-facing slice of `KernelDeps` (plan P10 Task 14): the local source
 * wrapped through the port adapter with the REAL admission budget
 * (`createDesignSourceAdmission`, never `allowAllPackageAdmission` — that is tests-only and P3's
 * `LocalDesignSystemSourceDeps.admission` is required precisely so this cannot be forgotten), the
 * quarantine adapter (Task 4's `store/design-systems` quarantine under this SAME `userStateRoot`),
 * the install adapter (Task 5's `TransactionEngine.installDesignSystem` over the caller's already-
 * open project), and the `local`-source trust grant (decision D9).
 *
 * `admission` is handed the FACTORY, `createDesignSourceAdmission` itself, never a called
 * instance (fix for the I1 review finding): `LocalDesignSystemSourceDeps.admission` is a
 * `() => PackageAdmission` precisely so `fetch`/`publish` each mint their own fresh budget per
 * call, rather than this composition binding ONE instance for the shell's entire lifetime and
 * silently making every fetch/publish in the session share its cumulative counters.
 *
 * DECISION D9. `local` is the user's own directory under their own `userStateRoot`, so it is
 * granted WITHOUT A PROMPT on first use — but the grant is still RECORDED through
 * `trustStore.grantSource`, so the ledger stays the single authority on what was decided and a
 * later kind or path change is a fresh decision, exactly like every other source. A failure to
 * grant does NOT refuse to start the shell (disproportionate — a trust-ledger write fault is not
 * a reason to deny the whole shell): it is logged (errore rule 21 — the failure does not
 * propagate) and `local` simply shows as an `ungranted` row in the picker until a later run's
 * grant succeeds, which `core/design-systems`' `listGrantedSources` already renders legibly
 * (§8.4: "an unrecorded remote source is never queried" — the SAME refusal path a genuinely
 * ungranted remote source takes).
 *
 * `designSystemIsGranted` closes over the ONE subject built here rather than re-deriving one
 * per call: `core/kernel/model/handlers/design-system.ts`'s own header notes that, with exactly
 * one `designSystemSource` composed today, the only source a callback invocation can ever name
 * is this one — a `source.id` mismatch is defensive (unreachable under this composition, not a
 * per-source router for a multi-source future §10 does not build yet).
 *
 * Exported, not inlined into `kernelDeps` in `interactiveShell` — the SAME testability reason
 * `buildGateRunner`/`toPreviewSessionHandle` are already exported for: `createShell`'s return
 * value exposes no seam onto `kernelDeps` itself (`AppShell`/`KernelPort` are narrower on
 * purpose), so `create-shell.test.ts` exercises this exact composition directly against a
 * scratch `userStateRoot`.
 */
export async function buildDesignSystemDeps(
  userStateRoot: string,
  storeAdapterDeps: StoreAdapterDeps,
): Promise<DesignSystemKernelDeps> {
  const trustStore = storeAdapterDeps.open.trust;

  const designSystemSource = createDesignSystemSourceAdapter(
    createLocalDesignSystemSource({
      userStateRoot,
      fs: nodeDesignSystemFsDeps,
      // REQUIRED and defaultless by P3's design, so an unbudgeted fetch does not compile. The
      // FACTORY itself, not a called instance (I1 fix) — see this function's own doc comment.
      admission: createDesignSourceAdmission,
      clock: systemClock,
    }),
  );

  const localSourceSubject = trustStore.buildSourceSubject({
    sourceKind: "local",
    sourceId: designSystemSource.id,
    canonicalLocation: localLibraryDir(userStateRoot),
    locationFilesystemIdentity: localLibraryFsIdentity(userStateRoot),
  });

  const alreadyGranted = await trustStore.isSourceGranted(localSourceSubject);
  if (!alreadyGranted) {
    const granted = await trustStore.grantSource(localSourceSubject);
    if (granted instanceof Error) {
      log.warn(
        `entrypoint: could not record the local design-system source's trust grant (${granted.message}); it will show as ungranted in the picker until a later run's grant succeeds`,
      );
    }
  }

  async function designSystemIsGranted(source: DesignSystemSource): Promise<boolean> {
    if (source.id !== designSystemSource.id) {
      // Defensive, should be unreachable — see this function's own doc comment.
      log.warn(
        `entrypoint: designSystemIsGranted was asked about an unrecognized source "${source.id}"; refusing rather than guessing`,
      );
      return false;
    }
    return trustStore.isSourceGranted(localSourceSubject);
  }

  return {
    designSystemSource,
    designSystemQuarantine: createDesignSystemQuarantineAdapter({ userStateRoot }),
    designSystemInstall: createDesignSystemInstallAdapter(storeAdapterDeps),
    designSystemIsGranted,
  };
}

/** `true` for the ordinary "nothing here yet" `ENOENT` a fresh `userStateRoot` produces before
 *  any install has ever run — mirrors `store/trust`'s own `isMissingFile` — so it can be told
 *  apart from a genuine fault (permissions, a locked handle, …) below. */
function isMissingPathError(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT"
  );
}

/** `infrastructure/fs-guard`'s filesystem identity for the local design-system library
 *  directory, or `null` when it is unavailable (D9) — most commonly because no install has ever
 *  run yet, so the directory does not exist on disk. Never refuses the grant over this: a
 *  missing identity is the ordinary "nothing published here yet" case, not a fault, and the
 *  `SourceTrustSubjectInput` encoding already has an `absent` tag for exactly this. Logged only
 *  when the failure is NOT the ordinary missing-directory case — otherwise every shell launch
 *  before the first install would warn on every single run. */
function localLibraryFsIdentity(userStateRoot: string): string | null {
  const identity = formatFsIdentity(localLibraryDir(userStateRoot));
  if (identity instanceof Error) {
    if (!isMissingPathError(identity.cause)) {
      log.warn(
        `entrypoint: could not read the local design-system library's filesystem identity (${identity.message}); the trust subject carries a null identity`,
      );
    }
    return null;
  }
  return identity;
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
): Promise<ShellCompositionError | MigrationRequiredV1 | OpenedProjectV1> {
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

  // A version-1 project is NOT "no project here yet". Before this branch existed, its typed
  // refusal fell through to `createProject`, which refuses an existing `.termcraft`, and the pair
  // of failures became a `ShellCompositionError` that `main.tsx` reported as fatal — the binary
  // could not start against the user's own project. `findCause`, not `instanceof`: today
  // `openProject`'s manifest-read step (`store/model/factory.ts`) returns this error unwrapped,
  // but `findCause` checks the error itself before walking `.cause`, so this stays correct if a
  // later open-sequence layer ever wraps it, and it is the errore-idiomatic way to test a typed
  // error's identity regardless.
  if (errore.findCause(opened, ManifestMigrationRequiredError) !== undefined) {
    const plan = await store.planMigration(root);
    // A project that says "migrate me" but cannot say what migrating would change is a genuine
    // failure — the offer would have nothing honest to draw. Reported, not silently downgraded to
    // the create path. The concrete origin (1 or 2) lives in the plan `planMigration` just failed
    // to produce, so it is not in scope here — "an older format" is what is actually known.
    if (plan instanceof Error)
      return new ShellCompositionError({
        root,
        reason: `the project is on an older format but its migration plan could not be read (${plan.message})`,
        cause: plan,
      });
    return { kind: "needs-migration", root, plan };
  }

  const created = await store.createProject({
    root,
    name: deriveProjectName(root),
    // The only target stack this binary's own runtime facade (`@termcraft/runtime`,
    // `EMBEDDED_RUNTIME_DECLARATION.module`) and Gate actually validate/render pages for
    // today — a fact about this MVP's supported stack, not an invented design value.
    targetStack: "js-opentui",
    // `store` must not import `runtime` (D3), so this binary's own embedded kit API identity
    // — the same constant the host/Gate handshake checks — is supplied here, never re-derived
    // inside `store` (`CreateProjectInput.kitApiVersion`'s own doc comment).
    kitApiVersion: EMBEDDED_RUNTIME_DECLARATION.currentKitApiVersion,
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
    log.warn(
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
          log.warn(
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
 * `kernel` is narrowed to `Pick<Kernel, "publishFrame" | "acknowledgeDisplay" |
 * "currentPreviewSessionId">`: this function never dispatches a command or reads a snapshot,
 * so it depends on nothing beyond the two frame-token methods it calls plus the live
 * incarnation id. `previewSessionId` is still taken as an explicit parameter (fix round 1,
 * Finding 3) — `toKernelPort`'s own `preview()` already resolved and validated it once per
 * fresh session — but it is now the SEED for a read-through getter rather than the value the
 * handle reports for its whole life; see that property's own comment for why a handle that
 * outlives a page switch must not freeze it.
 *
 * A frame published with no live Kernel session (`PreviewNoLiveSessionError` — a real, if
 * narrow, race between `session.frames` yielding and the Kernel's own bookkeeping already
 * observing the session as closed) is DROPPED, logged, and never forwarded with an
 * invented token: a `UiPreviewFrame` without a genuine, ledger-recognized `frameToken`
 * would violate its own contract worse than skipping one frame (errore rule 21: an error
 * that is not propagated must still be logged).
 */
export function toPreviewSessionHandle(
  kernel: Pick<Kernel, "acknowledgeDisplay" | "currentPreviewSessionId" | "publishFrame">,
  session: PreviewSession,
  previewSessionId: UUIDv7,
): PreviewSessionHandle {
  async function* displayFrames(): AsyncGenerator<UiPreviewFrame> {
    for await (const frame of session.frames) {
      const frameToken = kernel.publishFrame(frame);
      if (frameToken instanceof Error) {
        log.warn(`entrypoint: dropped a preview frame — ${frameToken.message}`);
        continue;
      }
      yield { frame, frameToken, handle };
    }
  }

  const handle: PreviewSessionHandle = {
    /**
     * READ THROUGH TO THE KERNEL, NOT THE VALUE CAPTURED AT BUILD TIME (2026-08-09, with the
     * `HostSupervisorPort` identity fix). A handle now OUTLIVES the id it was built with: since
     * a page switch within one `treeRevision` keeps the same `PreviewSession` object,
     * `toKernelPort`'s session-keyed cache correctly reuses this handle — while the Kernel mints
     * a fresh `previewSessionId` on every switch (`core/preview/model/session-commands.ts`'s
     * `noteSessionEstablished`, kernel-command-contract §7.6: "Each start/switch mints a UUIDv7").
     *
     * Captured, those two drift apart on the first switch, and
     * `ui/preview/model/interaction.ts`'s `handleGeometryResult` correlation
     * (`current.handle.previewSessionId !== payload.previewSessionId`) then rejects every
     * geometry result for the rest of the run — hover, pin and click silently dead. That is the
     * SAME defect fix round 1's Finding 3 closed from the other direction, so it is read live
     * here rather than re-captured.
     *
     * REBUILDING THE HANDLE IS NOT THE ALTERNATIVE: `frames` above is one generator over the
     * supervisor's single-consumer relay, and `ui/app/model/deps.ts`'s `resyncPreviewSession`
     * returns the iterator the moment the handle identity changes — a rebuild per switch would
     * end the live frame stream, which is precisely the freeze this whole change removes.
     *
     * The seeded value stays the fallback so this never widens to `null`: `toKernelPort` already
     * refuses to build a handle without a valid id, and a closed session is dropped by the same
     * `preview()` call rather than read through this getter.
     */
    get previewSessionId(): UUIDv7 {
      return kernel.currentPreviewSessionId() ?? previewSessionId;
    },
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
          entry: `pages/${DEMO_PAGE_SLUG}.tsx`,
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
    // A demo owns no project on disk (Gap D) — never an existing project to route a startup
    // `project.open` dispatch against.
    launch: { existing: false },
    // No real project has just been migrated in an offline demo (design-tree §12.2 track 2) —
    // never a synthesized refactor turn to seed.
    seedTurnText: null,
    // Same reasoning as `seedTurnText` above, for the composer draft (design-systems §9).
    seedComposerText: null,
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
