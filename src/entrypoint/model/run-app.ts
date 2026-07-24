import * as errore from "errore";

import { type UiRootAdapters, type UiRootHandle, createUiRoot } from "ui";

import type { AppShell, ProcessBoundary, RunningApp, ShutdownSignal } from "../types";

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

export interface RunAppOptions {
  readonly shell: AppShell;
  readonly process: ProcessBoundary;
  /** Injected in tests; production uses `ui`'s real OpenTUI defaults. */
  readonly adapters?: UiRootAdapters;
}

/**
 * Acquires the terminal for one shell and hands back the single shutdown path.
 *
 * `ui`'s `createUiRoot` already owns renderer/React lifetime — including destroying a
 * partially acquired renderer when mounting fails — so this function adds only what is above
 * the UI: releasing the shell on every exit path (a failed start included, so a shell that
 * acquired resources never leaks), binding the shutdown signals to that same path, and
 * exposing `closed` so an executable root can await shutdown instead of polling.
 */
export async function runApp(options: RunAppOptions): Promise<AppStartupError | RunningApp> {
  const { shell, process: boundary } = options;

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
  }).catch((cause: unknown) => new AppStartupError({ cause }));
  if (root instanceof Error) {
    await closeShell(shell, boundary);
    // `root` is already an `AppStartupError` when `createUiRoot` itself rejected (the `.catch`
    // above) — returning it directly avoids wrapping an `AppStartupError` in another one.
    // Otherwise `root` is a genuine `UiRootError`, which still needs exactly one wrap.
    return root instanceof AppStartupError ? root : new AppStartupError({ cause: root });
  }

  return startShutdownPath(shell, boundary, root);
}

function startShutdownPath(
  shell: AppShell,
  boundary: ProcessBoundary,
  root: UiRootHandle,
): RunningApp {
  const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>();
  // One shared promise IS the idempotence: a second `close()` — or a SIGTERM arriving behind a
  // SIGINT — awaits the first teardown instead of unmounting a second time.
  let closing: Promise<void> | null = null;

  const close = (): Promise<void> => {
    closing ??= (async () => {
      root.dispose();
      await closeShell(shell, boundary);
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
