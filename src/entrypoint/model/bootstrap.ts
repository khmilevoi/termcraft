import path from "node:path";

import * as errore from "errore";

import type { UiEnv, UiRootAdapters } from "ui";

import type { EntrypointMode, ProcessBoundary, RunningApp } from "../types";
import { createShell } from "./create-shell";
import { AppStartupError, runApp } from "./run-app";

/** Opt-in flag that runs the real UI against the in-memory kernel while composition is pending. */
export const PREVIEW_SHELL_FLAG = "--preview-shell";

/**
 * The interactive entrypoint's honest refusal: the production Kernel composition (the
 * `store`/`agent`/`gate`/`host` adapter ring plus the command handler registry) has not landed,
 * so there is nothing real to start. Falling back to the demo kernel silently is exactly what
 * the entrypoints design forbids, so the run stops here with the two commands that do work.
 */
export class KernelCompositionPendingError extends errore.createTaggedError({
  name: "KernelCompositionPendingError",
  message:
    "the production Kernel is not composed yet, so there is no real project to open. " +
    `Run \`bun run demo\` for the in-memory demo, or \`bun start ${PREVIEW_SHELL_FLAG}\` ` +
    "to open the real UI against that same in-memory kernel.",
}) {}

export interface BootstrapDeps {
  /** Arguments after the executable and script — `process.argv.slice(2)`. */
  readonly argv: readonly string[];
  readonly cwd: () => string;
  readonly process: ProcessBoundary;
  readonly adapters?: UiRootAdapters;
}

/**
 * Turns one mode plus its arguments into a started application, or into the error the
 * executable root must report. This is where every root's logic lives; `main.tsx` and
 * `demo.tsx` stay thin enough that importing them can never start a terminal.
 */
export async function bootstrap(
  mode: EntrypointMode,
  deps: BootstrapDeps,
): Promise<AppStartupError | KernelCompositionPendingError | RunningApp> {
  if (mode === "interactive" && !deps.argv.includes(PREVIEW_SHELL_FLAG)) {
    return new KernelCompositionPendingError();
  }

  return runApp({
    shell: createShell(mode, resolveEnv(mode, deps)),
    process: deps.process,
    adapters: deps.adapters,
  });
}

/**
 * The project root is the first non-flag argument, resolved against the working directory.
 * `demo` never reads or writes a project, so it carries a label instead of a path — nothing
 * downstream should be able to mistake it for a directory.
 */
function resolveEnv(mode: EntrypointMode, deps: BootstrapDeps): UiEnv {
  if (mode === "demo") return { root: DEMO_ROOT_LABEL, workspaceIdentity: "demo" };

  const target = deps.argv.find((argument) => !argument.startsWith("-"));
  const root = path.resolve(deps.cwd(), target ?? ".");
  return { root, workspaceIdentity: root };
}

const DEMO_ROOT_LABEL = "(demo)";
