import path from "node:path";

import {
  MigrationDeclinedError,
  bootstrap,
  createProcessBoundary,
  formatExportOutcome,
  parseExportArgs,
  runHeadlessExport,
} from "entrypoint";
import type { ProcessExit, TerminalControl } from "entrypoint";
import * as errore from "errore";

import { EMBEDDED_RUNTIME_DECLARATION, PROTOCOL_HARD_LIMITS } from "host/protocol";
import { parseHostArgs, runHostStdio } from "host/session";
import { beginTraceRun, log, trace } from "infrastructure/debug-log";

/** The `_host` stdio boundary failed — real stdin, `registerRuntimeResolver`, and a real
 *  child process are all uncontrolled code, so errore's boundary rule applies here exactly
 *  as it does at the interactive branch's `bootstrap` boundary below. */
class HostStdioFailedError extends errore.createTaggedError({
  name: "HostStdioFailedError",
  message: "the _host stdio protocol loop failed",
}) {}

/** `_host` and `export` never acquire a terminal — `process.stdout` there is either the binary
 *  framing channel to the parent supervisor (`_host`) or the CLI result channel (`export`), and
 *  neither branch ever mounts OpenTUI's `CliRenderer`. `createProcessBoundary`'s `reportFatal`/
 *  panic path calls `restoreTerminal()` unconditionally, so without this no-op double a fatal
 *  report or an escaping panic on either headless path would write xterm mode-reset escape
 *  sequences into that channel — corrupting the frame stream (`_host`) or the CLI output
 *  (`export`) for no reason, since no terminal mode was ever entered there to begin with. */
const NOOP_TERMINAL_CONTROL: TerminalControl = {
  disableRawMode() {},
  disableMouseCapture() {},
  exitAlternateScreen() {},
};

/**
 * The interactive branch's real `exit` seam (phase-8 Task 11 / WP-10), threaded into
 * `bootstrap`/`runApp`'s own `exit` option — see that option's doc comment
 * (`entrypoint/model/run-app.ts`) for why a forced exit is unavoidable even after a fully
 * correct `close()` (an upstream `@reatom/core` handle keeps the event loop alive on its own).
 * Same flush-then-exit shape as the `_host` branch's own `exit` callback and the `export`
 * branch's own write below: an empty trailing `stdout` write's callback fires only after every
 * earlier write's callback already has (Writable streams process queued writes strictly in
 * order), which is what actually guarantees the renderer's own terminal-restore escape codes
 * (written by `root.dispose()` inside `close()`, before this fires) physically land before the
 * process disappears — worse on a piped, non-TTY stdout, i.e. on Windows.
 */
const interactiveExit: ProcessExit = (code) => {
  process.stdout.write(new Uint8Array(0), () => process.exit(code));
};

/**
 * The interactive root. Thin on purpose: every decision it could make lives in `entrypoint`,
 * where it is tested against injected renderer and process seams, so this file holds only what
 * cannot be tested without a real process — argv, the working directory, stderr, exit codes.
 *
 * Guarded by `import.meta.main` so importing it (the entrypoint contract test does) never
 * takes over the terminal.
 */
if (import.meta.main) {
  // Computed once, ahead of both branches below — `parseExportArgs` is a pure argv scan
  // (mirrors `parseHostArgs`'s own "_host" scan), so there is no cost to resolving it before
  // knowing whether the `_host` branch will fire first. Both scans also decide which
  // `TerminalControl` the boundary below gets, so they have to run before it is constructed.
  // DIAGNOSTIC (infrastructure/debug-log): opens THIS run's own file under `termcraft-debug/`
  // and prunes the directory back to its retention cap. Runs on all three branches below on
  // purpose: a `_host` child inherits the parent's resolved path and appends to the SAME run
  // file, so a page-render failure and the turn that caused it read as one story rather than
  // two.
  beginTraceRun();
  trace("main.start", { argv: process.argv.slice(2), cwd: process.cwd() });

  const exportArgs = parseExportArgs(process.argv);
  const isHostStdio = parseHostArgs(process.argv);

  const boundary = createProcessBoundary(
    process,
    isHostStdio || exportArgs !== null ? NOOP_TERMINAL_CONTROL : undefined,
  );

  // The design host is this same binary, re-invoked as `_host --stdio` (Spike E,
  // `createHostSpawnCommand` in `host/supervisor` builds that argv). Recognizing it
  // is the FIRST branch, ahead of the interactive bootstrap in the `else` below —
  // a `_host` argv only ever runs the stdio protocol loop.
  if (isHostStdio) {
    const outcome = await runHostStdio({
      argv: process.argv,
      input: process.stdin,
      output: (bytes) => {
        process.stdout.write(bytes);
      },
      now: () => Date.now(),
      exit: (code) => {
        // Node/Bun's `process.exit()` does not wait for a prior `process.stdout.write` to
        // physically flush (worse on a piped, non-TTY stdout, e.g. on Windows). An empty
        // trailing write's callback fires only after every earlier write's callback already
        // has — Writable streams process queued writes strictly in order — so this is what
        // actually guarantees the last frame/heartbeat handed to `process.stdout.write` above
        // landed before the process disappears.
        process.stdout.write(new Uint8Array(0), () => process.exit(code));
      },
      deps: {
        // ONE constant shared by both sides of the handshake (Important 2 of the WP-3 fix
        // pass) — see `host/protocol/model/embedded-declaration.ts`'s own doc comment for
        // why it lives there and not as an inline literal here.
        runtimeDeclaration: EMBEDDED_RUNTIME_DECLARATION,
        limits: PROTOCOL_HARD_LIMITS,
      },
    }).catch((cause: unknown) => new HostStdioFailedError({ cause }));

    if (outcome instanceof Error) {
      // `reportFatalAndExit` flushes `stderr` before exiting (same shape as the `export`
      // branch's own flush-then-exit write below, and the `_host` `exit` callback's write
      // above) — a bare `process.exit(1)` right after `reportFatal`'s `console.error` does
      // not wait for that write to physically land on a piped, non-TTY stderr (worse on
      // Windows), so the operator-facing diagnostic could get truncated.
      boundary.reportFatalAndExit(outcome.message, outcome.cause);
    }
  } else if (exportArgs !== null) {
    // M8/WP-5 Phase D: `termcraft export [dir]`. Headless — no renderer is ever acquired,
    // `entrypoint/model/run-export.ts` composes and closes the shell for its own single
    // dispatch-then-await lifetime. Every decision (trust/zero-page/turn-running refusal,
    // the resolved package directory) is computed there; this branch only resolves the
    // root against the working directory, prints, and exits.
    const root = path.resolve(process.cwd(), exportArgs.rootArg ?? ".");
    const outcome = await runHeadlessExport({
      // `projectExists` is never read on this headless path (`create-shell.ts`'s
      // `resolveEnvWithProjectIdentity` overwrites it from the real open-vs-create fact before
      // anything downstream can see it, and `run-export.ts` dispatches `project.open` directly
      // rather than through `home-submit`, the field's only reader) — `false` is a harmless
      // placeholder, matching `bootstrap.ts`'s own `resolveEnv`.
      env: { root, workspaceIdentity: root, projectExists: false },
    });
    const formatted = formatExportOutcome(outcome);
    const text = `${formatted.text}\n`;
    // Same Windows stdout/stderr-flush-before-exit concern as the `_host` branch's own
    // `exit` callback above: `process.exit()` does not wait for a prior `write` to
    // physically flush, so the exit is chained off the write's own callback.
    if (formatted.stream === "stderr") {
      process.stderr.write(text, () => process.exit(formatted.exitCode));
    } else {
      process.stdout.write(text, () => process.exit(formatted.exitCode));
    }
  } else {
    const app = await bootstrap("interactive", {
      argv: process.argv.slice(2),
      cwd: () => process.cwd(),
      process: boundary,
      // Phase-8 Task 11 / WP-10: `runApp`'s own `exit` option (`entrypoint/model/run-app.ts`)
      // fires this AFTER `close()` has fully released the shell — the SAME `close()` a SIGINT/
      // SIGTERM, an `/exit` command, or the `q` quit keys all now share. Wired here (not left
      // as a bare `process.exit(0)` after `await app.closed`, the old shape) because a bare
      // call is not unit-testable — `run-app.test.ts`'s "exit runs AFTER shell.close()" test
      // needs a recording double in `exit`'s place, which only an injected seam allows.
      exit: interactiveExit,
    });

    // `esc later` is a choice, not a crash: one plain line, exit 0, terminal already released
    // (`runMigrationPrompt` disposes the migration root on this path before returning).
    if (app instanceof MigrationDeclinedError) {
      log.error(app.message);
    } else if (app instanceof Error) {
      // Same flush-then-exit concern as the `_host` branch's own fatal report above.
      // `reportFatalAndExit` returns `void` rather than `never` (its injected `exit` seam is a
      // test-doubleable callback, not a guaranteed-never-return like `process.exit`), so the
      // success path below has to live in this `else` rather than fall through past this `if` —
      // relying on unreachability-after-`never` is what the old `process.exit(1)` let TypeScript
      // narrow `app` with, and that narrowing is gone now that this call isn't `never`-typed.
      boundary.reportFatalAndExit(app.message, app.cause);
    } else {
      // `close()` (triggered by a signal, `/exit`, or `q`) already ends the process itself via
      // `interactiveExit` above — awaiting `closed` here is only for symmetry with the other
      // branches' own structure, not because anything further needs to run after it.
      await app.closed;
    }
  }
}
