import path from "node:path";

import type { UiEnv, UiRootAdapters } from "ui";

import type { EntrypointMode, ProcessBoundary, RunningApp } from "../types";
import { ShellCompositionError, createShell } from "./create-shell";
import type { ShellDeps } from "./create-shell";
import type { ProcessExit } from "./process-boundary";
import { AppStartupError, runApp } from "./run-app";

export interface BootstrapDeps {
  /** Arguments after the executable and script — `process.argv.slice(2)`. */
  readonly argv: readonly string[];
  readonly cwd: () => string;
  readonly process: ProcessBoundary;
  readonly adapters?: UiRootAdapters;
  /** Injected only for tests — production always uses `createShell`'s own real defaults. */
  readonly shell?: ShellDeps;
  /**
   * Forwarded verbatim to `runApp`'s own `exit` option (phase-8 Task 11 / WP-10) — see that
   * option's doc comment (`run-app.ts`) for why a forced exit is unavoidable. Optional so
   * `demo.tsx` (which owns its own separate `process.exit(0)` after `app.closed`) keeps
   * compiling and behaving exactly as before; `main.tsx`'s interactive branch is the one
   * caller that supplies the real, flush-then-exit implementation.
   */
  readonly exit?: ProcessExit;
}

/**
 * Turns one mode plus its arguments into a started application, or into the error the
 * executable root must report. This is where every root's logic lives; `main.tsx` and
 * `demo.tsx` stay thin enough that importing them can never start a terminal.
 */
export async function bootstrap(
  mode: EntrypointMode,
  deps: BootstrapDeps,
): Promise<AppStartupError | ShellCompositionError | RunningApp> {
  const shell = await createShell(mode, resolveEnv(mode, deps), deps.shell);
  if (shell instanceof Error) return shell;
  // Task 8 replaces this refusal with the real pre-Kernel migration surface.
  if ("kind" in shell)
    return new ShellCompositionError({
      root: shell.root,
      reason: "the project is on format 1 and the migration surface is not wired yet",
    });

  return runApp({
    shell,
    process: deps.process,
    adapters: deps.adapters,
    exit: deps.exit,
  });
}

/**
 * The project root is the first non-flag argument, resolved against the working directory.
 * `demo` never reads or writes a project, so it carries a label instead of a path — nothing
 * downstream should be able to mistake it for a directory.
 */
function resolveEnv(mode: EntrypointMode, deps: BootstrapDeps): UiEnv {
  if (mode === "demo") {
    return { root: DEMO_ROOT_LABEL, workspaceIdentity: "demo", projectExists: false };
  }

  const target = deps.argv.find((argument) => !argument.startsWith("-"));
  const root = path.resolve(deps.cwd(), target ?? ".");
  // `projectExists` is not yet known here — `createShell` (`createShell(mode, resolveEnv(...),
  // ...)`, this function's own caller below) overwrites it with the real open-vs-create fact
  // once `interactiveShell` learns it (`create-shell.ts`'s `resolveEnvWithProjectIdentity`).
  // `false` is the safe placeholder: it is never actually READ before that overwrite, since
  // nothing dispatches on `env.projectExists` before the shell is constructed.
  return { root, workspaceIdentity: root, projectExists: false };
}

const DEMO_ROOT_LABEL = "(demo)";
