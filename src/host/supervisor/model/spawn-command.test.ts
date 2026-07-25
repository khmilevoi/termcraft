import { describe, expect, test } from "bun:test";

import { createHostSpawnCommand } from "./spawn-command";

describe("createHostSpawnCommand", () => {
  // termcraft ships as an npm package run under Bun (phase-8 design §2), so there is
  // exactly one spawn shape: the Bun executable, the installed entry script, then the
  // host argv — the same shape package.json's `start` script uses. The compiled-binary
  // `[execPath, "_host", "--stdio"]` shape (Spike E) is gone from this suite along with
  // `isCompiled`; see spawn-command.ts's header comment for where that finding now lives.
  test("bun execPath + the installed entry script + the host argv", () => {
    const command = createHostSpawnCommand({
      execPath: "C:/Users/khmil/.bun/bin/bun.exe",
      srcRoot: "C:/Users/khmil/AppData/Roaming/npm/node_modules/termcraft/src/main.tsx",
    });
    expect(command).toEqual({
      cmd: [
        "C:/Users/khmil/.bun/bin/bun.exe",
        "C:/Users/khmil/AppData/Roaming/npm/node_modules/termcraft/src/main.tsx",
        "_host",
        "--stdio",
      ],
    });
  });
});
