import path from "node:path";

import * as errore from "errore";

import type { CommandRejectionCode, UInt64String } from "core/protocol";
import { log } from "infrastructure/debug-log";
import type { UiEnv } from "ui";
import type { AnyEventEnvelope, EventEnvelopeV1, KernelPort } from "ui/kernel";
import { createDispatcher } from "ui/kernel";

import type { AppShell } from "../types";
import { ShellCompositionError, createShell } from "./create-shell";
import type { ShellDeps } from "./create-shell";

/**
 * `termcraft export` (M8, WP-5 Phase D): the headless CLI driver. Composes the SAME real
 * Kernel graph `entrypoint/model/bootstrap.ts` builds for the interactive root
 * (`createShell("interactive", env)`) but never acquires a renderer — it dispatches
 * `project.open` then `export.start` directly at the `KernelPort`, the same command surface
 * `ui/app/model/deps.ts` drives, and waits for the terminal event.
 *
 * DESIGN D-Q7 (§3.1/§3.7/§9): the design spec fixes the SUBSTANCE of the CLI trust refusal
 * ("designs in this project are code and will run" + "points at the TUI") but not a verbatim
 * CLI string. {@link TRUST_REFUSAL_MESSAGE} reuses `ui/popups/ui/TrustPrompt.tsx`'s own §3.1
 * copy verbatim, plus a TUI pointer — this is this module's one recommended, reviewable wording,
 * not an invented value; the acceptance test asserts the §3.1 substring, not the whole sentence.
 */

// --- Errors -----------------------------------------------------------------------------

export const TRUST_REFUSAL_MESSAGE =
  "designs in this project are code and will run; this folder is not trusted. " +
  "Open termcraft in this directory to trust it, then export.";

/**
 * Design §3.7: "Export is likewise refused while a turn runs (§3.2), when the project has zero
 * pages, and on an untrusted project." Zero pages is refused by this driver's own pre-check
 * (see `runExport`'s comment on why `export.start` itself never rejects on a page count), and a
 * running turn is refused by `export.start`'s own guard (`TURN_RUNNING`). Neither has a
 * verbatim CLI string in the design spec (only §3.7's prose above) — these two constants are
 * this module's own reviewable wording for those two cases, the same status the untrusted
 * message has per D-Q7.
 */
export const ZERO_PAGES_REFUSAL_MESSAGE =
  "the project has zero pages; export refuses with nothing to package.";
export const RUNNING_TURN_REFUSAL_MESSAGE =
  "a turn is currently running; export refuses while a turn is active. Wait for it to finish, then export.";

/** `export.start` (or the pre-dispatch zero-pages check) refused to run — the CLI's non-zero exit path. */
export class ExportRefusedError extends errore.createTaggedError({
  name: "ExportRefusedError",
  message: "$reason",
}) {}

/** The headless driver itself could not complete — a protocol/decode failure, a subscribe
 *  failure, a wedged wait, or a genuine `export.failed` terminal outcome. Distinct from
 *  {@link ExportRefusedError}: this is a driver/execution fault, not a design-level refusal. */
export class ExportDriverError extends errore.createTaggedError({
  name: "ExportDriverError",
  message: "the headless export driver failed: $reason",
}) {}

/** The composed shell failed to release its resources cleanly after the headless export driver
 *  finished. Logged, never propagated: see {@link runHeadlessExportOverShell}'s doc comment for
 *  why this must never replace the primary export result. */
export class ExportShellCloseError extends errore.createTaggedError({
  name: "ExportShellCloseError",
  message: "the composed shell failed to close cleanly after headless export",
}) {}

export interface RunExportResult {
  /** The resolved, absolute package directory (design §3.7: "`Ctrl+E` (or `termcraft export`)
   *  publishes an immutable generation beneath `.termcraft/export/generations/<generationId>/`
   *  and returns that resolved package directory"). */
  readonly destination: string;
}

// --- The event tracker: revision + page count + a replay-tolerant event wait ------------

interface PendingWaiter {
  readonly predicate: (envelope: AnyEventEnvelope) => boolean;
  readonly resolve: (envelope: AnyEventEnvelope) => void;
}

interface EventTracker {
  currentRevision(): UInt64String;
  pageCount(): number;
  /**
   * Resolves with the first envelope (already delivered, or yet to arrive) matching
   * `predicate`. Checking `history` first — not merely arming a live waiter — makes this
   * immune to the real event bus's own synchronous-batch delivery (`core/mailbox/model/
   * event-bus.ts`'s `notify`): a whole `runProjectReadySequence` batch (`page.descriptorsChanged`
   * then `kernel.stateChanged`) can land before this driver's own `await` chain gets back
   * around to calling `waitFor` for it.
   */
  waitFor(
    predicate: (envelope: AnyEventEnvelope) => boolean,
    timeoutMs: number,
  ): Promise<ExportDriverError | AnyEventEnvelope>;
  /** Releases the underlying Kernel subscription — call exactly once, on every exit path. */
  close(): void;
}

function createEventTracker(port: KernelPort): ExportDriverError | EventTracker {
  let revision: UInt64String = "0";
  let pages = 0;
  const history: AnyEventEnvelope[] = [];
  const waiters = new Set<PendingWaiter>();

  function handle(envelope: EventEnvelopeV1): void {
    revision = envelope.stateRevision;
    // Sound widening cast (the same documented idiom `ui/app/model/deps.ts` uses at its own
    // subscribe boundary): every `EventEnvelopeV1` genuinely IS some `EventEnvelopeV1<K>` — this
    // only narrows `payload` per `kind`, it never invents one.
    const distributed = envelope as AnyEventEnvelope;
    if (distributed.kind === "kernel.snapshot") pages = distributed.payload.pageDescriptors.length;
    if (distributed.kind === "page.descriptorsChanged") {
      pages = distributed.payload.descriptors.length;
    }
    history.push(distributed);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(distributed)) continue;
      waiters.delete(waiter);
      waiter.resolve(distributed);
    }
  }

  const unsubscribe = port.subscribe(handle);
  if (unsubscribe instanceof Error) {
    return new ExportDriverError({
      reason: `could not subscribe to Kernel events: ${unsubscribe.message}`,
      cause: unsubscribe,
    });
  }

  function waitFor(
    predicate: (envelope: AnyEventEnvelope) => boolean,
    timeoutMs: number,
  ): Promise<ExportDriverError | AnyEventEnvelope> {
    const already = history.find(predicate);
    if (already !== undefined) return Promise.resolve(already);

    return new Promise((resolve) => {
      const waiter: PendingWaiter = {
        predicate,
        resolve: (envelope) => {
          clearTimeout(timer);
          resolve(envelope);
        },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        resolve(
          new ExportDriverError({
            reason: `timed out after ${timeoutMs}ms waiting for a matching Kernel event`,
          }),
        );
      }, timeoutMs);
      waiters.add(waiter);
    });
  }

  return { currentRevision: () => revision, pageCount: () => pages, waitFor, close: unsubscribe };
}

// --- Event predicates ---------------------------------------------------------------------

function isProjectOpenSettled(envelope: AnyEventEnvelope): boolean {
  return (
    envelope.kind === "kernel.stateChanged" &&
    envelope.payload.modelId === "kernel.project.state" &&
    (envelope.payload.action === "kernel.project.finishOpen" ||
      envelope.payload.action === "kernel.project.blockOpen")
  );
}

function isExportTerminal(envelope: AnyEventEnvelope): boolean {
  return envelope.kind === "export.completed" || envelope.kind === "export.failed";
}

function refusalMessageForCode(code: CommandRejectionCode): string {
  if (code === "PROJECT_UNTRUSTED") return TRUST_REFUSAL_MESSAGE;
  if (code === "TURN_RUNNING" || code === "TURN_ALREADY_ACTIVE")
    return RUNNING_TURN_REFUSAL_MESSAGE;
  if (code === "NO_PAGES") return ZERO_PAGES_REFUSAL_MESSAGE;
  return `export refused (${code})`;
}

// --- The driver ------------------------------------------------------------------------

const DEFAULT_EXPORT_TIMEOUT_MS = 60_000;

export interface RunExportDeps {
  readonly port: KernelPort;
  /** The project root, threaded into `project.open`'s payload (§8.2: "canonical root") and
   *  used to resolve {@link RunExportResult.destination}. */
  readonly root: string;
  /** Overridable per call — production leaves the default; tests pass a small bound so a
   *  wedged wait fails fast instead of hanging the suite. */
  readonly timeoutMs?: number;
}

/**
 * Drives one headless export end to end over an already-composed `KernelPort`: opens the
 * project, dispatches `export.start`, and awaits its terminal event.
 *
 * UNTRUSTED / RUNNING-TURN refusals ARE carried by a guard rejection: `export.start` is not in
 * `PROJECT_UNTRUSTED_EXEMPT_KINDS` and IS in `TURN_LOCKED_KINDS`, so dispatching it on an
 * untrusted or turn-active project rejects with `PROJECT_UNTRUSTED`/`TURN_RUNNING` before the
 * handler ever runs — this driver only needs to map those two codes to the two refusal
 * messages above; no duplicate trust/turn-lock logic lives here. Per the guard's own priority
 * table (`core/protocol/model/unavailable-reason.ts`'s `UNAVAILABLE_REASON_PRIORITY_V1`),
 * `PROJECT_UNTRUSTED` outranks the zero-pages case below, so an untrusted, zero-page project
 * still reports the trust refusal, never the zero-pages one.
 *
 * ZERO-PAGES POST-ACCEPT CHECK (flagged, per the plan): `export.start`'s own guard
 * (`core/capabilities/model/guards.ts`) never checks page count — a zero-page project's
 * `export.start` is ACCEPTED (`disposition: "started"`), and its handler's `NO_PAGES` path
 * (`core/kernel/model/handlers/preview-export.ts`'s `runExportStart`) then emits NO terminal
 * event at all, since nothing ran. Waiting for a terminal event regardless would hang until
 * this function's own timeout. So once `export.start` is ACCEPTED, this driver reads the page
 * count off the ALREADY-ARRIVED `page.descriptorsChanged` event (populated by the same
 * `project.open` continuation that reached `ready`) and refuses immediately, without ever
 * waiting for a terminal event that will never come — the one refusal not carried by a guard
 * rejection.
 */
export async function runExport(
  deps: RunExportDeps,
): Promise<ExportDriverError | ExportRefusedError | RunExportResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  const tracker = createEventTracker(deps.port);
  if (tracker instanceof Error) return tracker;

  const dispatcher = createDispatcher({
    port: deps.port,
    revision: () => tracker.currentRevision(),
  });

  const openResult = await dispatcher.dispatch("project.open", { root: deps.root });
  if (openResult instanceof Error) {
    tracker.close();
    return new ExportDriverError({
      reason: `project.open dispatch failed: ${openResult.message}`,
      cause: openResult,
    });
  }
  if (openResult.status === "rejected") {
    tracker.close();
    return new ExportDriverError({ reason: `project.open was rejected (${openResult.code})` });
  }

  const openSettled = await tracker.waitFor(isProjectOpenSettled, timeoutMs);
  if (openSettled instanceof Error) {
    tracker.close();
    return openSettled;
  }
  if (openSettled.kind !== "kernel.stateChanged") {
    // Defensive, should be unreachable: `isProjectOpenSettled` only ever matches this kind.
    tracker.close();
    log.warn(
      "entrypoint/run-export: the project-open waiter resolved with an unexpected event kind",
    );
    return new ExportDriverError({ reason: "project.open did not settle as expected" });
  }
  if (openSettled.payload.action === "kernel.project.blockOpen") {
    tracker.close();
    return new ExportDriverError({ reason: "the project failed to open" });
  }

  const exportDispatch = await dispatcher.dispatch("export.start", {});
  if (exportDispatch instanceof Error) {
    tracker.close();
    return new ExportDriverError({
      reason: `export.start dispatch failed: ${exportDispatch.message}`,
      cause: exportDispatch,
    });
  }
  if (exportDispatch.status === "rejected") {
    tracker.close();
    return new ExportRefusedError({ reason: refusalMessageForCode(exportDispatch.code) });
  }

  // Accepted, but a zero-page project's handler never emits a terminal event at all (see this
  // function's own header) — check now, BEFORE ever waiting for one that will never arrive.
  if (tracker.pageCount() === 0) {
    tracker.close();
    return new ExportRefusedError({ reason: ZERO_PAGES_REFUSAL_MESSAGE });
  }

  const terminal = await tracker.waitFor(isExportTerminal, timeoutMs);
  tracker.close();
  if (terminal instanceof Error) return terminal;
  if (terminal.kind !== "export.completed" && terminal.kind !== "export.failed") {
    // Defensive, should be unreachable: `isExportTerminal` only ever matches these two kinds.
    log.warn(
      "entrypoint/run-export: the export-terminal waiter resolved with an unexpected event kind",
    );
    return new ExportDriverError({ reason: "export.start did not settle as expected" });
  }
  if (terminal.kind === "export.failed") {
    const failureMessage =
      terminal.payload.failure === null ? "unknown failure" : terminal.payload.failure.safeMessage;
    return new ExportDriverError({ reason: `export failed: ${failureMessage}` });
  }

  const { generationId } = terminal.payload;
  if (generationId === null) {
    // Defensive, should be unreachable: `preview-export.ts`'s own header states `generationId`
    // is non-null ONLY on `export.completed`, taken verbatim from the publish intent.
    log.warn("entrypoint/run-export: export.completed carried a null generationId");
    return new ExportDriverError({ reason: "export.completed carried no generation id" });
  }

  return { destination: path.join(deps.root, ".termcraft", "export", "generations", generationId) };
}

// --- The compose-and-close wrapper -------------------------------------------------------

export interface RunHeadlessExportDeps {
  readonly env: UiEnv;
  /** Injected only for tests — production leaves `createShell`'s own real defaults. */
  readonly shell?: ShellDeps;
  readonly timeoutMs?: number;
}

export interface RunHeadlessExportOverShellDeps {
  readonly shell: AppShell;
  readonly root: string;
  readonly timeoutMs?: number;
}

/**
 * Drives {@link runExport} over an ALREADY-composed shell and closes it on every exit path — the
 * part of {@link runHeadlessExport} that does not need `createShell`'s real store/host graph,
 * split out so this exit-path boundary is directly testable with an injected `AppShell` (mirrors
 * `run-app.ts`'s own `runApp`, which likewise takes its `AppShell` as a parameter instead of
 * composing one itself).
 *
 * `shell.close()` can reject — `create-shell.ts`'s `closeShellResources` throws a
 * `ShellTeardownError` when any teardown step (`kernel.close`, `hostSupervisor.stopAll`,
 * `open.close`) fails, and that is most likely on exactly the success path, where `close()` is
 * tearing down still-live host children. A bare `await shell.close()` inside `finally` would let
 * that rejection escape: a `throw` from a `finally` block ALWAYS supersedes whatever the `try`
 * block already returned, discarding a real `{ destination }` or a legitimate
 * `ExportRefusedError`/`ExportDriverError` and making this function reject instead of resolve —
 * breaking its own declared error-as-value return type and turning a clean §3.1 trust refusal
 * into an unhandled rejection. `closeHeadlessShell` converts that rejection into a logged value
 * instead, the identical `.catch()` conversion `run-app.ts`'s own `closeShell` performs for the
 * same `AppShell.close()` boundary — so the primary result computed above is always what this
 * function resolves with, regardless of teardown outcome.
 */
export async function runHeadlessExportOverShell(
  deps: RunHeadlessExportOverShellDeps,
): Promise<ExportDriverError | ExportRefusedError | RunExportResult> {
  try {
    return await runExport({ port: deps.shell.port, root: deps.root, timeoutMs: deps.timeoutMs });
  } finally {
    await closeHeadlessShell(deps.shell);
  }
}

/**
 * Composes the real Kernel graph (`createShell("interactive", env)` — no renderer, no `runApp`)
 * and drives the export over it via {@link runHeadlessExportOverShell}.
 */
export async function runHeadlessExport(
  deps: RunHeadlessExportDeps,
): Promise<ShellCompositionError | ExportDriverError | ExportRefusedError | RunExportResult> {
  const shell = await createShell("interactive", deps.env, deps.shell);
  if (shell instanceof Error) return shell;
  // Same temporary refusal as `bootstrap.ts` (design-tree phase-1b Task 6): this headless driver
  // has no migration surface either, and wiring one is out of this task's scope.
  if ("kind" in shell)
    return new ShellCompositionError({
      root: shell.root,
      reason: "the project is on format 1 and the migration surface is not wired yet",
    });

  return runHeadlessExportOverShell({ shell, root: deps.env.root, timeoutMs: deps.timeoutMs });
}

/**
 * Releases the shell, converting a rejection into a reported (logged) value — the identical
 * `.catch()` conversion `run-app.ts`'s own `closeShell` performs for the same `AppShell.close()`
 * boundary. There is no `ProcessBoundary` at this headless boundary (unlike `runApp`), so the
 * failure is logged via `console.warn` rather than reported fatally (errore rule 21: an error
 * branch that does not propagate must still leave a trace).
 */
async function closeHeadlessShell(shell: AppShell): Promise<void> {
  const released = await shell.close().catch((cause) => new ExportShellCloseError({ cause }));
  if (released instanceof Error) {
    log.warn(`entrypoint/run-export: ${released.message}`, released);
  }
}

// --- argv + CLI-output formatting (kept here so `main.tsx` stays a thin argv/exit-code shell) --

export interface ExportArgs {
  /** The raw, not-yet-resolved argv token following `export` — `undefined` defaults to `"."`. */
  readonly rootArg: string | undefined;
}

/**
 * True (a non-`null` `ExportArgs`) iff argv requests `termcraft export [dir]` (compiled or
 * `bun run`; mirrors `host/session/model/entry.ts`'s `parseHostArgs` — scanning for the token
 * ANYWHERE in argv, not a fixed index, is what tolerates the position shift between a compiled
 * binary's argv and `bun run <script>`'s argv).
 */
export function parseExportArgs(argv: readonly string[]): ExportArgs | null {
  const exportIndex = argv.indexOf("export");
  if (exportIndex === -1) return null;
  const rootArg = argv.slice(exportIndex + 1).find((arg) => !arg.startsWith("-"));
  return { rootArg };
}

export interface ExportCliOutcome {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  readonly exitCode: 0 | 1;
}

/** Maps a {@link runHeadlessExport} outcome to exactly what the CLI root prints and exits with —
 *  success 0 (destination on stdout), any refusal/failure non-zero (message on stderr). */
export function formatExportOutcome(
  outcome: ShellCompositionError | ExportDriverError | ExportRefusedError | RunExportResult,
): ExportCliOutcome {
  if (outcome instanceof Error) return { stream: "stderr", text: outcome.message, exitCode: 1 };
  return { stream: "stdout", text: outcome.destination, exitCode: 0 };
}
