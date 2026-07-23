import { bootstrap, createProcessBoundary } from "entrypoint";

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
