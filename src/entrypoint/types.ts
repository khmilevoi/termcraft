import type { KernelPort, UiEnv } from "ui";

/**
 * `entrypoint/` — the process-lifecycle ring between an executable root (`src/main.tsx`,
 * `src/demo.tsx`) and the `ui` module. It owns exactly three things the UI must not: which
 * Kernel boundary a run is wired to (the SHELL), when the terminal is acquired and released
 * (the RUN), and how a startup failure reaches the operator (the BOUNDARY). Everything it
 * touches is injected, so the whole ring is testable without ever taking over a real terminal.
 */

/** Which kernel boundary and seed a run is wired to. */
export type EntrypointMode = "interactive" | "demo";

/** The OS signals that trigger a graceful shutdown. */
export type ShutdownSignal = "SIGINT" | "SIGTERM";

/**
 * One run's Kernel boundary plus the environment facts `ui` needs, with its own teardown.
 * `close()` must be idempotent — `runApp` calls it on every exit path, including the one where
 * the UI root never started.
 */
export interface AppShell {
  readonly mode: EntrypointMode;
  readonly port: KernelPort;
  readonly env: UiEnv;
  close(): Promise<void>;
}

/**
 * The process seam: signal registration and the operator-facing failure report. Injected so a
 * test can fire "SIGINT" without signalling the test runner, and so nothing under `model/`
 * writes to a real stderr.
 */
export interface ProcessBoundary {
  onSignal(signal: ShutdownSignal, handler: () => void): void;
  reportFatal(message: string, cause: unknown): void;
}

/** A started application: the shell it runs against, plus one idempotent shutdown. */
export interface RunningApp {
  readonly shell: AppShell;
  /** Unmounts the UI and releases the shell exactly once, in reverse acquisition order. */
  close(): Promise<void>;
  /** Resolves once the app has closed — through a shutdown signal or an explicit `close()`. */
  readonly closed: Promise<void>;
}
