import { afterEach, describe, expect, test } from "bun:test";

import type { SpawnedChild } from "../types";
import { SupervisorError } from "./errors";
import { buildChildEnv, createBunSpawn } from "./spawn";

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
