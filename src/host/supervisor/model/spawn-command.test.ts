import { describe, expect, test } from "bun:test";

import { createHostSpawnCommand } from "./spawn-command";

describe("createHostSpawnCommand", () => {
  test("compiled binary: execPath alone, no script path (Spike E)", () => {
    const command = createHostSpawnCommand({
      execPath: "C:/dist/termcraft.exe",
      isCompiled: true,
      srcRoot: "src/main.tsx",
    });
    expect(command).toEqual({ cmd: ["C:/dist/termcraft.exe", "_host", "--stdio"] });
  });

  test("dev (`bun run`): execPath + srcRoot as the script argument", () => {
    const command = createHostSpawnCommand({
      execPath: "/usr/local/bin/bun",
      isCompiled: false,
      srcRoot: "src/main.tsx",
    });
    expect(command).toEqual({
      cmd: ["/usr/local/bin/bun", "src/main.tsx", "_host", "--stdio"],
    });
  });
});
