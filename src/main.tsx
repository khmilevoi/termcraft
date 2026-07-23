import { bootstrap, createProcessBoundary } from "entrypoint";
import { PROTOCOL_HARD_LIMITS } from "host/protocol";
import { parseHostArgs, runHostStdio } from "host/session";
import { CURRENT_KIT_API_VERSION, DEFAULT_THEME_ID } from "runtime";

/**
 * The interactive root. Thin on purpose: every decision it could make lives in `entrypoint`,
 * where it is tested against injected renderer and process seams, so this file holds only what
 * cannot be tested without a real process — argv, the working directory, stderr, exit codes.
 *
 * Guarded by `import.meta.main` so importing it (the entrypoint contract test does) never
 * takes over the terminal.
 */
if (import.meta.main) {
  // The design host is this same binary, re-invoked as `_host --stdio` (Spike E,
  // `createHostSpawnCommand` in `host/supervisor` builds that argv). Recognizing it
  // is the FIRST branch — a `_host` argv never reaches the interactive bootstrap
  // below, it only ever runs the stdio protocol loop.
  if (parseHostArgs(process.argv)) {
    await runHostStdio({
      argv: process.argv,
      input: process.stdin,
      output: (bytes) => {
        process.stdout.write(bytes);
      },
      now: () => Date.now(),
      exit: (code) => process.exit(code),
      deps: {
        // The binary's own embedded runtime-API identity (host-supervision §5.1,
        // §7.1) — reused from `runtime`'s public constants, not invented here.
        // `publicCapabilityIds` carries only the MVP theme capability; widening it
        // is a later phase's job, not this seam's.
        runtimeDeclaration: {
          module: "@termcraft/runtime",
          currentKitApiVersion: CURRENT_KIT_API_VERSION,
          supportedKitApiVersions: [CURRENT_KIT_API_VERSION],
          publicCapabilityIds: [`theme:${DEFAULT_THEME_ID}`],
        },
        limits: PROTOCOL_HARD_LIMITS,
      },
    });
  } else {
    const boundary = createProcessBoundary(process);
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
