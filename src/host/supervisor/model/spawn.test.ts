import { afterEach, describe, expect, test } from "bun:test";

import type { SpawnedChild } from "../types";
import { SupervisorError } from "./errors";
import {
  SCRATCH_SWEEP_MAX_DELETIONS,
  buildChildEnv,
  createBunSpawn,
  selectStaleScratchDirs,
} from "./spawn";

const children: SpawnedChild[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
});

describe("buildChildEnv", () => {
  test("is the explicit locale/timezone allowlist and carries no parent secrets", () => {
    process.env.TERMCRAFT_TEST_MARKER = "leak-me";
    const env = buildChildEnv();
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.LC_ALL).toBe("C.UTF-8");
    expect(env.TZ).toBe("UTC");
    expect("TERMCRAFT_TEST_MARKER" in env).toBe(false);
    delete process.env.TERMCRAFT_TEST_MARKER;
  });

  /**
   * THE GAP THIS CLOSES (2026-07-27). The child is a re-invocation of the same binary and
   * resolves `TERMCRAFT_DEBUG_LOG` through the same sink. Unset, it defaulted to a run file
   * under its OWN cwd — which `createBunSpawn` sets to a throwaway scratch directory — so
   * every smoke render, export render and preview session wrote its diagnostics to a temp
   * path nobody would read. Forwarding the parent's resolved path puts the design host's
   * trace in the same run file as the turn that spawned it.
   */
  test("forwards the parent's resolved trace file so the child traces into the same run", () => {
    const env = buildChildEnv({ TERMCRAFT_DEBUG_LOG: "C:/w/termcraft-debug/run-x.jsonl" });
    expect(env.TERMCRAFT_DEBUG_LOG).toBe("C:/w/termcraft-debug/run-x.jsonl");
  });

  test("omits the variable entirely when the parent has tracing off", () => {
    expect("TERMCRAFT_DEBUG_LOG" in buildChildEnv({})).toBe(false);
    expect("TERMCRAFT_DEBUG_LOG" in buildChildEnv({ TERMCRAFT_DEBUG_LOG: "" })).toBe(false);
  });

  /**
   * A child that inherits `0`/`off` must stay silent rather than mint a file of its own —
   * the value is forwarded verbatim, and the sink reads it as "tracing off" at the far end.
   */
  test("forwards an explicit off switch verbatim", () => {
    expect(buildChildEnv({ TERMCRAFT_DEBUG_LOG: "0" }).TERMCRAFT_DEBUG_LOG).toBe("0");
  });
});

describe("createBunSpawn", () => {
  test("returns a typed SupervisorError when the binary does not exist", () => {
    const spawn = createBunSpawn();
    const result = spawn({ cmd: ["C:/no/such/binary_termcraft_xyz.exe", "_host", "--stdio"] });
    expect(result).toBeInstanceOf(SupervisorError);
    if (result instanceof SupervisorError) {
      expect(result.code).toBe("SPAWN_FAILED");
      expect(result.reason).toContain("ENOENT");
    }
  });

  test("spawns a real echo-lite child and exposes streams + exited", async () => {
    const spawn = createBunSpawn();
    const result = spawn({
      cmd: [process.execPath, "-e", "process.stdout.write('hi'); process.exit(0)"],
    });
    expect(result).not.toBeInstanceOf(SupervisorError);
    if (result instanceof SupervisorError) throw result;
    children.push(result);
    let out = "";
    const dec = new TextDecoder();
    for await (const chunk of result.stdout) out += dec.decode(chunk, { stream: true });
    const code = await result.exited;
    expect(out).toBe("hi");
    expect(code).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(result.signalCode).toBeNull();
  });
});

describe("selectStaleScratchDirs", () => {
  const DAY = 24 * 60 * 60 * 1_000;
  const now = 1_000 * DAY;

  test("selects only this module's own directories, and only old ones", () => {
    const stale = selectStaleScratchDirs(
      [
        { name: "termcraft-host-4zvjjo", mtimeMs: now - 2 * DAY },
        { name: "termcraft-host-08Z6eW", mtimeMs: now - 60_000 },
        { name: "termcraft-debug", mtimeMs: now - 90 * DAY },
        { name: "some-other-tool-cache", mtimeMs: now - 90 * DAY },
        { name: "termcraft-host-", mtimeMs: now - 90 * DAY },
      ],
      now,
      DAY,
      SCRATCH_SWEEP_MAX_DELETIONS,
    );

    expect(stale).toEqual({ selected: ["termcraft-host-4zvjjo"], skipped: 0 });
  });

  test("a directory exactly at the age limit is not yet stale", () => {
    expect(
      selectStaleScratchDirs(
        [{ name: "termcraft-host-abcdef", mtimeMs: now - DAY }],
        now,
        DAY,
        SCRATCH_SWEEP_MAX_DELETIONS,
      ),
    ).toEqual({ selected: [], skipped: 0 });
  });

  // THE CAP (final-review Finding 2). `sweepStaleScratchDirs` runs on the boot path, before the
  // renderer comes up, so an inherited backlog is dead time the operator sees as a frozen launch.
  // Bounding it per run is what keeps that cost flat no matter how large the backlog got.
  test("deletes at most the per-run cap, oldest first, and reports what it left", () => {
    // Ages deliberately NOT in listing order (a deterministic scatter), so a pass that trusted
    // `readdir` order rather than mtime would pick the wrong subset.
    const entries = Array.from({ length: SCRATCH_SWEEP_MAX_DELETIONS + 5 }, (_, index) => ({
      name: `termcraft-host-${String(index).padStart(6, "z")}`,
      mtimeMs: now - 2 * DAY - ((index * 37 + 11) % 97) * 1_000,
    }));
    const oldestFirst = [...entries]
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
      .slice(0, SCRATCH_SWEEP_MAX_DELETIONS)
      .map((entry) => entry.name);

    const stale = selectStaleScratchDirs(entries, now, DAY, SCRATCH_SWEEP_MAX_DELETIONS);

    expect(stale.selected).toEqual(oldestFirst);
    expect(stale.skipped).toBe(5);
  });

  test("a cap of zero selects nothing and reports the whole backlog as skipped", () => {
    expect(
      selectStaleScratchDirs([{ name: "termcraft-host-abcdef", mtimeMs: 0 }], now, DAY, 0),
    ).toEqual({ selected: [], skipped: 1 });
  });
});
