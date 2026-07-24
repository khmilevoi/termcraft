import type { SpawnCommand } from "../types";

/**
 * Builds the argv used to spawn this same termcraft binary as the `_host --stdio`
 * child (roadmap phase 8, Spike E `docs/spikes/05-host-respawn/FINDINGS.md`). A
 * compiled executable IS the entry point, so `_host --stdio` alone follows
 * `execPath`; `bun run <srcRoot>` (dev) needs the script path as the second argv
 * token, exactly like `package.json`'s `start`/`dev` scripts invoke `src/main.tsx`.
 * No branching beyond the `isCompiled` flag — the two shapes are fixed by Spike E.
 */
export function createHostSpawnCommand(env: {
  readonly execPath: string;
  readonly isCompiled: boolean;
  readonly srcRoot: string;
}): SpawnCommand {
  return {
    cmd: env.isCompiled
      ? [env.execPath, "_host", "--stdio"]
      : [env.execPath, env.srcRoot, "_host", "--stdio"],
  };
}
