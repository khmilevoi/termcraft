/**
 * `entrypoint` — everything the executable roots (`src/main.tsx`, `src/demo.tsx`) need, and
 * nothing they own themselves. The roots are `import.meta.main` guards over `bootstrap`; all
 * behavior lives here, behind injected renderer and process seams, so `bun test` exercises
 * startup and shutdown without ever acquiring a terminal.
 */
export type {
  AppShell,
  EntrypointMode,
  ProcessBoundary,
  RunningApp,
  ShutdownSignal,
} from "./types";

export { createShell } from "./model/create-shell";
export { AppShutdownError, AppStartupError, runApp } from "./model/run-app";
export type { RunAppOptions } from "./model/run-app";
export { KernelCompositionPendingError, PREVIEW_SHELL_FLAG, bootstrap } from "./model/bootstrap";
export type { BootstrapDeps } from "./model/bootstrap";
export { createProcessBoundary } from "./model/process-boundary";
export type { SignalTarget } from "./model/process-boundary";
