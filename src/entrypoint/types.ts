import type { AgentRegistry } from "core/ports";
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
 * What the composition root learned while opening the caller's project, and threw away before
 * this existed (Gap D). Both facts have to be captured INSIDE `openOrCreateProject`: by the time
 * the UI mounts, `.termcraft/` exists on disk in both cases — the shell just created it — so
 * nothing downstream can re-derive them.
 *
 * `hasContent` reports whether the project holds anything to view or edit — at least
 * one page, or at least one chat. Its purpose WAS the CLONE case (pages present, zero chats, since
 * `chats/` is git-ignored as of fix-bundle §2.5) reaching the Workspace — that was exactly the
 * case that most needed it, before the predicate moved to `existing` (see below). `createProject`
 * always mints the first chat header, so "exists but is empty" is practically unreachable — this
 * field is `false` essentially only for a genuinely fresh directory. `true` also for an EXISTING
 * project whose content could not actually be confirmed (a manifest or chat-listing read failed,
 * fix round 1 Finding 1, `create-shell.ts`'s `resolveShellLaunch`) — never fabricated as "nothing
 * here" just because the disk could not answer, though workspace-first launch (2026-08-02) made
 * that choice moot: an `existing` project's startup dispatch runs regardless of what the probe
 * found.
 *
 * NO LONGER THE ROUTING PREDICATE (workspace-first launch, 2026-08-02): `existing` is. Both
 * `run-app.ts`'s startup dispatch and `deriveScreen` read `existing`, because routing on one
 * fact while dispatching on the other would strand an existing-but-empty project in a Workspace
 * that never opens. `hasContent` is still computed and still reported; nothing reads it.
 */
export interface ShellLaunchV1 {
  readonly existing: boolean;
  readonly hasContent: boolean;
}

/**
 * `AppShell` widened with the live agent registry Task 9's Home health probe needs
 * (`run-app.ts`'s `resolveAgentHealthProbe`). Declared here, in the module's shared `types.ts`
 * (this repository's module-shape convention — CLAUDE.md), rather than in a `model/` file —
 * moved from `create-shell.ts` by phase-8 Task 11, which found it living there. Its reasoning is
 * unchanged by the move: `AppShell` is the general per-mode contract every entrypoint consumer
 * (`bootstrap.ts`, `run-export.ts`) already depends on, and only the run-app path needs the
 * registry. `ShellWithAgentRegistry` is a strict superset (`AppShell & {…}`), so it satisfies
 * every existing `shell: AppShell`-typed call site without any of them changing — `createShell`'s
 * own callers keep compiling unmodified. `agentRegistry` is `null` for the demo shell: there is
 * no real agent to probe in an offline demo (see `create-shell.ts`'s `demoShell`).
 */
export interface ShellWithAgentRegistry extends AppShell {
  readonly agentRegistry: AgentRegistry | null;
  /** The open-vs-create discriminator (Gap D) — see {@link ShellLaunchV1}'s own doc comment. */
  readonly launch: ShellLaunchV1;
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
