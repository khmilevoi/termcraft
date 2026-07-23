import { bootstrap, createProcessBoundary } from "entrypoint";

/**
 * The demo root: the same `App`, the same shell lifecycle, driven by the in-memory kernel. It
 * needs no credentials, spawns no design host, and never reads or writes a project on disk —
 * `createShell("demo", ...)` seeds a trusted workspace and one static preview frame instead.
 */
if (import.meta.main) {
  const boundary = createProcessBoundary(process);
  const app = await bootstrap("demo", {
    argv: process.argv.slice(2),
    cwd: () => process.cwd(),
    process: boundary,
  });

  if (app instanceof Error) {
    boundary.reportFatal(app.message, app.cause);
    process.exit(1);
  }

  await app.closed;
  // Spike D: the process does not exit on its own after the renderer is destroyed.
  process.exit(0);
}
