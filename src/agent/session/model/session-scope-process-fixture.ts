import { deriveSessionScope } from "./session-scope";

/**
 * Run as a standalone Bun process by `session-scope.test.ts`'s cross-process test — never
 * imported by production code. Prints one scope hash for fixed, non-account inputs so the
 * test can compare two independent process runs and prove `UNRESUMABLE_ACCOUNT`
 * (`session-scope.ts`'s own module-level constant) genuinely differs across real process
 * boundaries, not merely across two calls inside one test file.
 */
process.stdout.write(
  deriveSessionScope("claude", {
    account: null,
    model: "claude-sonnet-5",
    workspaceIdentity: "fixture-ws",
  }),
);
