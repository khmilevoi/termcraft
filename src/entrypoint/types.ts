import type { AgentRegistry } from "core/ports";
import type { MigrationPlanV1 } from "store/migration";
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
 * What the composition root learned while opening the caller's project (Gap D). `existing` has to
 * be captured INSIDE `openOrCreateProject`: by the time the UI mounts, `.termcraft/` exists on
 * disk in both cases — the shell just created it — so nothing downstream can re-derive it.
 *
 * It was briefly paired with a `hasContent` routing predicate (one manifest read plus one
 * `ChatStore.list()` before the Kernel was even constructed). Spec 2026-08-02 collapsed the two:
 * `deriveScreen` routes on the same `existing` fact, so a second, weaker predicate could only
 * ever disagree with it — and the case it existed to separate, an existing-but-empty project, is
 * practically unreachable since `createProject` always mints the first chat header.
 */
export interface ShellLaunchV1 {
  readonly existing: boolean;
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
  /**
   * The text the startup `project.open` seeds a first turn with, or `null` for an ordinary launch.
   * Non-null only immediately after a migration (design-tree §12.2 track 2). `runProjectReadySequence`
   * decides whether it actually becomes a turn: it needs a trusted project and an active chat, and
   * an untrusted project refuses the turn through the ordinary `PROJECT_UNTRUSTED` guard.
   */
  readonly seedTurnText: string | null;
  /**
   * Text pre-filled into the Workspace composer at construction, or `null` for an ordinary launch.
   * Non-null only immediately after a migration (design-systems §9). It is a DRAFT: nothing is
   * sent, and no turn starts — distinct from {@link ShellWithAgentRegistry.seedTurnText}, which
   * `runProjectReadySequence` turns into a real turn.
   */
  readonly seedComposerText: string | null;
}

/**
 * A project the composition root refuses to open because it is on format 1 (design-tree §12.1: "a
 * version-1 project never opens"). Carries the read-only plan the `migrate-80` dialog is drawn
 * from. NOT an `Error`: nothing is broken — the user has a project and a choice, and reporting
 * this through the fatal path is exactly the defect this outcome removes.
 */
export interface MigrationRequiredV1 {
  readonly kind: "needs-migration";
  readonly root: string;
  readonly plan: MigrationPlanV1;
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
