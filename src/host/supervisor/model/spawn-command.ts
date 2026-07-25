import type { SpawnCommand } from "../types";

/**
 * Builds the argv used to spawn this same termcraft binary as the `_host --stdio`
 * child (roadmap phase 8, Spike E `docs/spikes/05-host-respawn/FINDINGS.md`).
 *
 * termcraft ships as an npm package run under Bun (phase-8 design §2), so there is
 * exactly one shape: the Bun executable, then the installed entry script, then the
 * host argv — `[execPath, srcRoot, "_host", "--stdio"]`. This is the same shape
 * `package.json`'s `start` script uses to invoke `src/main.tsx`, and it applies
 * uniformly whether `execPath` resolves the globally installed `bun`/`bun.exe` or a
 * dev checkout's local Bun binary; `srcRoot` is the installed entry script's path
 * either way.
 *
 * Spike E's compiled-binary shape (`[execPath, "_host", "--stdio"]`, no script
 * argument, because a compiled executable IS the entry point) is dormant, not
 * deleted from the findings: it stops applying under the npm-distribution decision
 * and would only return if `bun build --compile` distribution comes back post-MVP.
 */
export function createHostSpawnCommand(env: {
  readonly execPath: string;
  readonly srcRoot: string;
}): SpawnCommand {
  return {
    cmd: [env.execPath, env.srcRoot, "_host", "--stdio"],
  };
}
