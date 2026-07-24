import path from "node:path";

import {
  bootstrap,
  createProcessBoundary,
  formatExportOutcome,
  parseExportArgs,
  runHeadlessExport,
} from "entrypoint";
import * as errore from "errore";

import { EMBEDDED_RUNTIME_DECLARATION, PROTOCOL_HARD_LIMITS } from "host/protocol";
import { parseHostArgs, runHostStdio } from "host/session";

/** The `_host` stdio boundary failed — real stdin, `registerRuntimeResolver`, and a real
 *  child process are all uncontrolled code, so errore's boundary rule applies here exactly
 *  as it does at the interactive branch's `bootstrap` boundary below. */
class HostStdioFailedError extends errore.createTaggedError({
  name: "HostStdioFailedError",
  message: "the _host stdio protocol loop failed",
}) {}

/**
 * The interactive root. Thin on purpose: every decision it could make lives in `entrypoint`,
 * where it is tested against injected renderer and process seams, so this file holds only what
 * cannot be tested without a real process — argv, the working directory, stderr, exit codes.
 *
 * Guarded by `import.meta.main` so importing it (the entrypoint contract test does) never
 * takes over the terminal.
 */
if (import.meta.main) {
  const boundary = createProcessBoundary(process);

  // Computed once, ahead of both branches below — `parseExportArgs` is a pure argv scan
  // (mirrors `parseHostArgs`'s own "_host" scan), so there is no cost to resolving it before
  // knowing whether the `_host` branch will fire first.
  const exportArgs = parseExportArgs(process.argv);

  // The design host is this same binary, re-invoked as `_host --stdio` (Spike E,
  // `createHostSpawnCommand` in `host/supervisor` builds that argv). Recognizing it
  // is the FIRST branch, ahead of the interactive bootstrap in the `else` below —
  // a `_host` argv only ever runs the stdio protocol loop.
  if (parseHostArgs(process.argv)) {
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
      boundary.reportFatal(outcome.message, outcome.cause);
      process.exit(1);
    }
  } else if (exportArgs !== null) {
    // M8/WP-5 Phase D: `termcraft export [dir]`. Headless — no renderer is ever acquired,
    // `entrypoint/model/run-export.ts` composes and closes the shell for its own single
    // dispatch-then-await lifetime. Every decision (trust/zero-page/turn-running refusal,
    // the resolved package directory) is computed there; this branch only resolves the
    // root against the working directory, prints, and exits.
    const root = path.resolve(process.cwd(), exportArgs.rootArg ?? ".");
    const outcome = await runHeadlessExport({ env: { root, workspaceIdentity: root } });
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
    });

    if (app instanceof Error) {
      boundary.reportFatal(app.message, app.cause);
      process.exit(1);
    }

    await app.closed;
    // Spike D: a Reatom + OpenTUI process does not exit on its own once the renderer is
    // destroyed — the exit has to be explicit or the shell hangs after Ctrl+C.
    process.exit(0);
  }
}
