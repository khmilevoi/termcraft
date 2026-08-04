import * as errore from "errore";

import type { AgentRegistry } from "core/ports";
import type { UInt64String, UUIDv7 } from "core/protocol";
import { type UiRootAdapters, type UiRootHandle, createUiRoot } from "ui";
import type { HomeAgentHealth } from "ui/home";
import type { AnyEventEnvelope, EventEnvelopeV1, KernelPort } from "ui/kernel";
import { createDispatcher } from "ui/kernel";

import type {
  AppShell,
  ProcessBoundary,
  RunningApp,
  ShellWithAgentRegistry,
  ShutdownSignal,
} from "../types";
import { createAgentHealthProbe, resolveDefaultAgentSelection } from "./agent-health";
import type { ProcessExit } from "./process-boundary";

const SHUTDOWN_SIGNALS: readonly ShutdownSignal[] = ["SIGINT", "SIGTERM"];

/** Any failure that prevents the application from reaching a mounted UI. */
export class AppStartupError extends errore.createTaggedError({
  name: "AppStartupError",
  message: "termcraft failed to start",
}) {}

/** A shell teardown that failed after the UI was already gone — reported, never propagated. */
export class AppShutdownError extends errore.createTaggedError({
  name: "AppShutdownError",
  message: "termcraft failed to release its shell cleanly",
}) {}

/** `exit()`'s default when `RunAppOptions.exit` is omitted — see that field's own doc comment. */
const NOOP_EXIT: ProcessExit = () => undefined;

export interface RunAppOptions {
  /**
   * `ShellWithAgentRegistry`, not the bare `AppShell` (`../types`): `runApp` needs the shell's
   * agent registry to build Task 9's real Home health probe (`resolveAgentHealthProbe` below).
   * A strict superset of `AppShell`, so `bootstrap.ts` — the one production caller — keeps
   * compiling unmodified: `createShell`'s own return type already widened to match.
   */
  readonly shell: ShellWithAgentRegistry;
  readonly process: ProcessBoundary;
  /** Injected in tests; production uses `ui`'s real OpenTUI defaults. */
  readonly adapters?: UiRootAdapters;
  /**
   * Terminates the OS process once `close()` has fully released the shell (phase-8 Task 11 /
   * WP-10's "the exit must actually exit" fix). A CORRECT `close()` is not enough on its own:
   * `@reatom/core`'s ESM bundle opens an unref'd `BroadcastChannel` at module import time
   * (`node_modules/@reatom/core/dist/index.js`, confirmed by bisection and `async_hooks`) — an
   * upstream handle this process can never close from `src/**`, not fixable, and reproduces
   * under Node too — so the event loop never drains on its own once the renderer is destroyed
   * (`main.tsx`'s own long-standing "Spike D" comment on its interactive branch). Without an
   * explicit `exit()`, a correctly-executed `/exit` or Ctrl+C leaves the process running and the
   * terminal never returns.
   *
   * Injected — mirroring `createProcessBoundary`'s own `ProcessExit` seam
   * (`./process-boundary.ts`) — so a test can pass a recording double instead of ending the
   * test runner. Defaults to a no-op so every OTHER existing composition of `runApp`
   * (`bootstrap.ts`'s demo-mode callers, any test that never anticipated a forced exit) keeps
   * behaving exactly as it did before this option existed. `main.tsx`'s interactive branch is
   * the one caller that supplies the real, flush-then-exit implementation — the same
   * `process.stdout.write(empty, () => process.exit(code))` shape its `_host`/`export`
   * branches already use, so a queued write (e.g. the renderer's own terminal-restore escape
   * codes) is never truncated on a piped, non-TTY stdout — worse on Windows.
   */
  readonly exit?: ProcessExit;
}

/**
 * Acquires the terminal for one shell and hands back the single shutdown path.
 *
 * `ui`'s `createUiRoot` already owns renderer/React lifetime — including destroying a
 * partially acquired renderer when mounting fails — so this function adds only what is above
 * the UI: releasing the shell on every exit path (a failed start included, so a shell that
 * acquired resources never leaks), binding the shutdown signals to that same path, wiring the
 * UI's own `/exit`/`q` quit affordances (Task 11) to the identical path, and exposing `closed`
 * so an executable root can await shutdown instead of polling.
 */
export async function runApp(options: RunAppOptions): Promise<AppStartupError | RunningApp> {
  const { shell, process: boundary } = options;
  const exit = options.exit ?? NOOP_EXIT;

  // `createUiRoot` needs `requestExit` at construction — before `close()` exists, which
  // `startShutdownPath` only builds AFTER the UI has successfully mounted below. `closeRef` is
  // the forward-reference cell: `requestExit` is only ever actually CALLED later, from a user
  // keystroke, by which time `runApp` has already returned and `closeRef` is set.
  let closeRef: (() => Promise<void>) | null = null;
  const requestExit = (): void => {
    if (closeRef === null) {
      // Unreachable in practice — the UI can only issue `requestExit` after it has mounted,
      // which happens after `closeRef` below is assigned — but errore rule 21 (log a swallowed
      // error) applies to defensive branches too, not only genuine failures.
      console.warn("termcraft: requestExit called before the shutdown path was ready");
      return;
    }
    void closeRef();
  };

  // M9: `createUiRoot` never intentionally throws (every internal boundary is `errore.try`/
  // `.catch()`-wrapped), but it composes real `@opentui/core`/`@opentui/react` calls — an
  // uncontrolled dependency that could still reject unexpectedly. Converting that rejection
  // into the same `Error` value `root instanceof Error` already handles below (rather than
  // letting it escape as an unhandled rejection `main.tsx`'s own `if (app instanceof Error)`
  // branch would never run for) is what routes the failure through `boundary.reportFatal` —
  // and, since M9 also made `reportFatal` restore the terminal first, through that too.
  const root = await createUiRoot({
    port: shell.port,
    env: shell.env,
    adapters: options.adapters,
    agentHealthProbe: resolveAgentHealthProbe(shell.agentRegistry),
    agentSelection: resolveDefaultAgentSelection(shell.agentRegistry) ?? undefined,
    requestExit,
  }).catch((cause: unknown) => new AppStartupError({ cause }));
  if (root instanceof Error) {
    await closeShell(shell, boundary);
    // `root` is already an `AppStartupError` when `createUiRoot` itself rejected (the `.catch`
    // above) — returning it directly avoids wrapping an `AppStartupError` in another one.
    // Otherwise `root` is a genuine `UiRootError`, which still needs exactly one wrap.
    return root instanceof AppStartupError ? root : new AppStartupError({ cause: root });
  }

  const app = startShutdownPath(shell, boundary, root, exit);
  closeRef = app.close;

  // Gap D: an existing project holding pages or chats opens straight into the Workspace. This is
  // the ONE interactive caller of `project.open` — before it, the whole of `src` had exactly one
  // (`entrypoint/model/run-export.ts`, the headless export driver), so every relaunch landed on
  // Home no matter what was on disk.
  //
  // WHAT A FAILED STARTUP OPEN ACTUALLY DOES TODAY — the spec ("Error handling") requires it to
  // SURFACE rather than silently leave the user on Home, and this code does NOT meet that
  // requirement. The two `console.error` calls below run while the renderer owns the terminal,
  // so `infrastructure/debug-log`'s pass-through gate is engaged: with tracing on the line
  // reaches the trace file and nothing else; with tracing off it waits in the hold buffer and
  // prints only once the user has already quit. Either way the user sees Home with no
  // explanation. That is not a regression introduced by the gate — before it, the line tore a
  // hole in the live frame, which was not a surface either. The missing piece is a designed
  // in-app surface for a failed startup open, and there is none in `design/*.dc.html`; inventing
  // one here is forbidden (CLAUDE.md, "Design is a source of truth"), so this is recorded as an
  // open design gap rather than papered over. `project.retryOpen` already exists for the
  // recovery-conflict path and would be the natural action such a surface offers.
  //
  // Placed AFTER `startShutdownPath` (fix round 1): that call registers the SIGINT/SIGTERM
  // handlers this function awaits nothing before. Dispatching first, as this used to, meant a
  // Ctrl-C during the (up to ~30s) open sequence had no handler to catch it — the still-live
  // renderer never got torn down and the project lease never got released. Moving the dispatch
  // below costs nothing: `closeRef` is already assigned by the time this `await` starts, so
  // `requestExit`/a signal firing mid-dispatch tears down the shell correctly either way.
  if (shell.launch.hasContent) {
    const dispatcher = createDispatcher({
      port: shell.port,
      revision: () => peekStateRevision(shell.port),
    });
    // `text` is OMITTED, not set to `undefined`: `projectOpenPayloadSchema` is a `strictObject`
    // and an explicit `undefined` key is a decode failure, not an absent field (design-tree
    // §12.2 track 2).
    const payload =
      shell.seedTurnText === null
        ? { root: shell.env.root }
        : { root: shell.env.root, text: shell.seedTurnText };
    const result = await dispatcher.dispatch("project.open", payload);
    if (result instanceof Error) {
      console.error(
        `termcraft: the startup project.open failed to dispatch: ${result.message}`,
        result,
      );
    } else if (result.status === "rejected") {
      console.error(`termcraft: the startup project.open was rejected (${result.code})`);
    }
  }

  return app;
}

function startShutdownPath(
  shell: AppShell,
  boundary: ProcessBoundary,
  root: UiRootHandle,
  exit: ProcessExit,
): RunningApp {
  const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>();
  // One shared promise IS the idempotence: a second `close()` — or a SIGTERM arriving behind a
  // SIGINT, or a `/exit` racing either — awaits the first teardown instead of unmounting twice.
  let closing: Promise<void> | null = null;

  const close = (): Promise<void> => {
    closing ??= (async () => {
      root.dispose();
      // Master spec §9: "cancellation completes only after confirmed process-tree exit."
      // Releasing the shell (below) tears down the host supervisor and, for `interactive`
      // mode, the project lease — doing that while a live agent CLI attempt is still running
      // would orphan that child process and strand the lease. Must run BEFORE `closeShell`.
      await cancelRunningTurnBeforeClose(shell);
      await closeShell(shell, boundary);
      // See `RunAppOptions.exit`'s own doc comment for why a forced exit is unavoidable here.
      // MUST run after `closeShell` resolves, never instead of it: releasing the lease and
      // tearing down host children is the whole point of `close()`, and firing this first
      // would abandon them mid-teardown if the real `process.exit()` interrupts pending I/O.
      exit(0);
      markClosed();
    })();
    return closing;
  };

  for (const signal of SHUTDOWN_SIGNALS) boundary.onSignal(signal, () => void close());

  return { shell, close, closed };
}

/**
 * Releases the shell, converting a rejection into a reported value. It cannot be propagated —
 * the UI is already unmounted and there is no caller left to hand it to — so it is reported
 * rather than swallowed.
 */
async function closeShell(shell: AppShell, boundary: ProcessBoundary): Promise<void> {
  const released = await shell.close().catch((cause) => new AppShutdownError({ cause }));
  if (released instanceof Error) boundary.reportFatal(released.message, released);
}

/**
 * Builds Home's real health probe from the shell's agent registry (phase-8 Task 9 / WP-5). Since
 * phase-8 Task 13 (finding §2.7) this reports HEALTH only — the sibling synchronous fact, the
 * registry's declared default agent/model/effort, is resolved separately by
 * `resolveDefaultAgentSelection` (`./agent-health.ts`) and passed straight into `createUiRoot`'s
 * `agentSelection`, not folded into this probe. MVP's registry carries exactly one entry
 * (`core/ports/agent-registry.ts`'s own header), so the sole catalog entry names the backend to
 * probe — no second, hardcoded source of truth for the backend id duplicating `agent/claude`'s
 * own `CLAUDE_BACKEND_ID`.
 *
 * `undefined` only for demo mode, whose shell carries no live registry
 * (`create-shell.ts`'s `demoShell` — there is no real agent to probe in an offline demo):
 * `createUiDeps`'s own default probe (`ui/app/model/deps.ts`'s `DEFAULT_PROBE_RESOLUTION`)
 * takes over — an honest `advisory` reading, NEVER `ready` (fix-bundle Task 15 review, fix
 * round 1, Finding 1 — CRITICAL: this exact seam is how demo mode used to reach a fabricated
 * `ready` with no probe ever run). The same `undefined` fallback also covers the defensive,
 * practically-unreachable case of an interactive registry reporting zero backends — an empty
 * catalog cannot honestly be probed either.
 */
function resolveAgentHealthProbe(
  registry: AgentRegistry | null,
): (() => Promise<HomeAgentHealth>) | undefined {
  if (registry === null) return undefined;
  const [sole] = registry.list();
  if (sole === undefined) return undefined;
  const backend = registry.get(sole.backendId);
  if (backend === null) return undefined;
  return createAgentHealthProbe(backend);
}

// --- Cancel a running turn before releasing the shell (Task 11 Step 7 / master spec §9) -----

/** How long to wait for a Kernel-confirmed turn-terminal event before releasing the shell
 *  anyway. Bounds the one failure mode worse than an orphaned agent process: a user's quit that
 *  never quits because a Kernel that never confirms cancellation hangs `close()` forever — the
 *  overriding concern the whole forced-exit fix in this file exists for. */
const TURN_CANCEL_CONFIRM_TIMEOUT_MS = 30_000;

/**
 * If a turn is genuinely live, dispatches `turn.cancel` and waits for the Kernel's own
 * confirmation (a `turn.completed`/`turn.failed`/`turn.cancelled` event naming the same
 * `turnId`) before returning. A no-op when no turn is running.
 *
 * SEAM NOTE: `AppShell` exposes no synchronous turn-state query, and none was added — this
 * reads the LIVE turn model the same way `ui`'s own mirror bootstraps: `KernelPort.subscribe`'s
 * documented contract ("delivers one `kernel.snapshot` synchronously before returning",
 * `ui/kernel/types.ts`) lets a subscribe-then-immediately-unsubscribe peek observe CURRENT
 * state, because `core/mailbox`'s event bus rebuilds that snapshot payload fresh on every
 * `subscribe()` call (`core/mailbox/model/event-bus.ts`) — it is never a stale value from
 * process start. No new `AppShell` method, no new port.
 *
 * Narrowed to `models.turn.phase === "running"` — not merely non-idle — because that is the
 * ONE phase with a live agent CLI subprocess attached: `core/kernel/model/handlers/turn.ts`'s
 * `handleTurnCancel` only calls the attempt handle's `requestCancel()` (the thing that actually
 * stops a process) when `context.turnRunner.activeAttempt` is non-null, which the turn machine
 * only ever populates in this phase. The other in-flight phases (admitting, workspace-ready,
 * snapshotting, validating, finalizing, ...) are Kernel-side bookkeeping only — there is no
 * external process for exiting termcraft to orphan there. This mirrors the SAME narrow
 * "running" concept `ui/app/model/intent.ts`'s `applyEsc` and `ui/app/ui/App.tsx`'s own
 * `turnRunning` already use for turn cancellation, not a new one invented for this seam.
 */
async function cancelRunningTurnBeforeClose(shell: AppShell): Promise<void> {
  const peeked = peekRunningTurn(shell.port);
  if (peeked === null) return;

  // Armed BEFORE the dispatch, mirroring `entrypoint/model/run-export.ts`'s own
  // `createEventTracker`: a terminal event the Kernel publishes synchronously as part of
  // handling the dispatch must never race ahead of this listener's registration.
  const settled = waitForTurnTerminal(shell.port, peeked.turnId, TURN_CANCEL_CONFIRM_TIMEOUT_MS);

  const dispatcher = createDispatcher({ port: shell.port, revision: () => peeked.stateRevision });
  const dispatched = await dispatcher.dispatch("turn.cancel", { turnId: peeked.turnId });
  if (dispatched instanceof Error) {
    console.warn(
      `termcraft: turn.cancel dispatch failed while exiting (turn ${peeked.turnId}): ${dispatched.message}`,
      dispatched,
    );
  } else if (dispatched.status === "rejected") {
    console.warn(
      `termcraft: turn.cancel was rejected while exiting (turn ${peeked.turnId}, code ${dispatched.code})`,
    );
  }

  await settled;
}

/** The distributed envelope narrowed to `kernel.snapshot` — the ONE kind `KernelPort.subscribe`
 *  guarantees a synchronous delivery for on registration (that method's own doc comment,
 *  `ui/kernel/types.ts`). */
type KernelSnapshotEnvelope = Extract<AnyEventEnvelope, { kind: "kernel.snapshot" }>;

/**
 * Subscribes just long enough to capture the synchronous bootstrap `kernel.snapshot` delivery,
 * then unsubscribes — the ONE peek primitive {@link peekRunningTurn} (turn-cancel-before-close)
 * and {@link peekStateRevision} (the Gap D startup dispatch) both need, factored out here so
 * neither duplicates the subscribe/immediately-unsubscribe dance. An `Error` means the subscribe
 * itself failed; `null` means it succeeded but delivered no `kernel.snapshot` synchronously
 * (defensive — should be unreachable against a correctly-wired `KernelPort`). Logging is left to
 * each caller, since only it knows what it was trying to read.
 */
function peekSnapshotEnvelope(port: KernelPort): Error | KernelSnapshotEnvelope | null {
  let snapshot: KernelSnapshotEnvelope | null = null;
  const unsubscribe = port.subscribe((envelope: EventEnvelopeV1) => {
    if (snapshot !== null) return; // only the synchronous bootstrap delivery matters here
    const distributed = envelope as AnyEventEnvelope;
    if (distributed.kind === "kernel.snapshot") snapshot = distributed;
  });
  if (unsubscribe instanceof Error) return unsubscribe;
  unsubscribe();
  return snapshot;
}

/** A synchronous peek at the live turn model — see {@link cancelRunningTurnBeforeClose}'s own
 *  doc comment for why this needs no new `AppShell` seam. `null` when no cancellable turn is
 *  running, or when the peek itself could not be taken. */
function peekRunningTurn(
  port: KernelPort,
): { readonly turnId: UUIDv7; readonly stateRevision: UInt64String } | null {
  const snapshot = peekSnapshotEnvelope(port);
  if (snapshot instanceof Error) {
    console.warn(`termcraft: could not read turn state before exit: ${snapshot.message}`);
    return null;
  }
  if (snapshot === null) return null;
  const { turn } = snapshot.payload.models;
  if (turn.phase !== "running" || turn.activeTurnId === null) return null;
  return { turnId: turn.activeTurnId, stateRevision: snapshot.stateRevision };
}

/**
 * A synchronous peek at the Kernel's current `stateRevision`, for the dispatcher the Gap D
 * startup `project.open` dispatch builds before any command has run yet — shares
 * {@link peekSnapshotEnvelope} rather than a second subscribe/unsubscribe copy. Falls back to
 * `"0"` (the Kernel's own documented initial revision) when the peek itself could not be taken —
 * logged here (errore rule 21: an error that is not propagated must still be logged); a wrong
 * guess only ever causes the dispatch to be honestly REJECTED as stale, never a fabricated
 * success.
 */
function peekStateRevision(port: KernelPort): UInt64String {
  const snapshot = peekSnapshotEnvelope(port);
  if (snapshot instanceof Error) {
    console.warn(
      `termcraft: could not read the Kernel's bootstrap state revision before the startup dispatch: ${snapshot.message}; falling back to "0"`,
    );
    return "0";
  }
  if (snapshot === null) {
    console.warn(
      'termcraft: the Kernel delivered no bootstrap snapshot before the startup dispatch; falling back to "0"',
    );
    return "0";
  }
  return snapshot.stateRevision;
}

/** Resolves once a `turn.completed`/`turn.failed`/`turn.cancelled` event names `turnId`, or once
 *  `timeoutMs` elapses — whichever comes first, so a Kernel that never confirms cancellation
 *  cannot hang the user's quit forever. */
function waitForTurnTerminal(port: KernelPort, turnId: UUIDv7, timeoutMs: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const unsubscribe = port.subscribe((envelope: EventEnvelopeV1) => {
    const distributed = envelope as AnyEventEnvelope;
    if (
      distributed.kind !== "turn.completed" &&
      distributed.kind !== "turn.failed" &&
      distributed.kind !== "turn.cancelled"
    ) {
      return;
    }
    if (distributed.payload.turnId !== turnId) return;
    resolve();
  });
  if (unsubscribe instanceof Error) {
    console.warn(
      `termcraft: could not confirm turn ${turnId} cancelled before exit: ${unsubscribe.message}`,
    );
    return Promise.resolve();
  }

  const timer = setTimeout(() => {
    console.warn(
      `termcraft: timed out after ${timeoutMs}ms confirming turn ${turnId} cancelled before exit; releasing the shell anyway`,
    );
    resolve();
  }, timeoutMs);

  return promise.finally(() => {
    clearTimeout(timer);
    unsubscribe();
  });
}
