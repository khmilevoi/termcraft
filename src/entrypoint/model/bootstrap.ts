import path from "node:path";

import { designSystemMigrationSeed, formatOneMigrationSeed } from "agent/prompt";
import { EMBEDDED_RUNTIME_DECLARATION } from "host/protocol";
import type { UiEnv, UiRootAdapters } from "ui";

import type { EntrypointMode, ProcessBoundary, RunningApp } from "../types";
import { ShellCompositionError, createShell, createStoreForShell } from "./create-shell";
import type { ShellDeps } from "./create-shell";
import type { ProcessExit } from "./process-boundary";
import { AppStartupError, runApp } from "./run-app";
import { MigrationDeclinedError, runMigrationPrompt } from "./run-migration";

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
): Promise<AppStartupError | ShellCompositionError | MigrationDeclinedError | RunningApp> {
  const env = resolveEnv(mode, deps);
  const first = await createShell(mode, env, deps.shell);
  if (first instanceof Error) return first;
  if (!("kind" in first))
    return runApp({
      shell: first,
      process: deps.process,
      adapters: deps.adapters,
      exit: deps.exit,
    });

  // A version-1 project: the migrate offer is the ONLY thing this process draws until it is
  // answered (design §12.1). No Kernel, no adapters, no UI deps have been built at this point.
  const migrated = await runMigrationPrompt({
    required: first,
    store: createStoreForShell(deps.shell),
    // `store` must not import `runtime` (D3) — the same routing precedent
    // `CreateProjectInput.kitApiVersion` set in `create-shell.ts`'s `openOrCreateProject`.
    kitApiVersion: EMBEDDED_RUNTIME_DECLARATION.currentKitApiVersion,
    adapters: deps.adapters,
  });
  if (migrated instanceof MigrationDeclinedError) return migrated;
  // Anything else `runMigrationPrompt` can fail with — `createMigrationRoot`'s own `UiRootError`
  // or `store.migrateProject`'s bare `Error` — is a genuine startup failure, wrapped the same way
  // `runApp` below wraps every other layer's failure into `AppStartupError` (never left as a bare
  // `Error` this function's own return type does not carry).
  if (migrated instanceof Error) return new AppStartupError({ cause: migrated });

  // Migrated: build the real shell from scratch. `createShell` re-opens the project, which now
  // decodes as the current format. A second `needs-migration` here would mean the migration
  // reported success without changing the manifest — refused loudly rather than looping.
  //
  // Track 2 (design-tree §12.2) / design-systems §9: the seed rides ONLY this second `createShell`
  // call — the first call above never got this far without hitting the `needs-migration` branch,
  // so there is never a migration to seed a draft from on an ordinary (non-migrated) launch.
  //
  // §9: the code migration is a SEEDED DRAFT, never an automatic turn. `seedTurnText` is
  // deliberately NOT passed any more — see plan P4's decision D8 for why an auto-run turn is
  // actively harmful here (every page is red on the `Color` change until this rewrite lands).
  //
  // A format-1 origin gets BOTH tracks joined through `formatOneMigrationSeed`, not a bare
  // concatenation here — the two seeds contradict each other without its bridge sentence (see
  // that function's own doc comment). A format-2 origin never carries the refactor seed at all:
  // it already has the multi-file tree, so only the design-system rewrite applies.
  const second = await createShell(mode, env, deps.shell, {
    seedComposerText:
      first.plan.fromVersion === 1
        ? formatOneMigrationSeed({ pageCount: first.plan.pageCount })
        : designSystemMigrationSeed({ pageCount: first.plan.pageCount }),
  });
  if (second instanceof Error) return second;
  if ("kind" in second)
    return new ShellCompositionError({
      root: env.root,
      reason: "the migration reported success but the project still reads as format 1",
    });

  return runApp({ shell: second, process: deps.process, adapters: deps.adapters, exit: deps.exit });
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
