import { expect, spyOn, test } from "bun:test";

import type { SpawnFn, SpawnedChild } from "../types";
import { SupervisorError } from "./errors";
import { createSparePool } from "./spare-pool";

/** A minimal `SpawnedChild` double: no real streams, just the liveness surface this pool reads. */
function createFakeChild(): SpawnedChild & { settleExit: (code: number) => void; killed: boolean } {
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  const child = {
    stdin: { write: () => {}, flush: () => {}, end: () => {} },
    stdout: (async function* () {})(),
    stderr: (async function* () {})(),
    exited,
    exitCode: null as number | null,
    signalCode: null as string | null,
    killed: false,
    kill() {
      child.killed = true;
    },
    settleExit(code: number) {
      child.exitCode = code;
      resolveExited(code);
    },
  };
  return child;
}

function createPool(overrides?: { canGrow?: () => boolean; capacity?: number }) {
  const spawned: ReturnType<typeof createFakeChild>[] = [];
  const spawn: SpawnFn = () => {
    const child = createFakeChild();
    spawned.push(child);
    return child;
  };
  const pool = createSparePool({
    spawn,
    command: { cmd: ["bun", "x", "_host", "--stdio"] },
    capacity: overrides?.capacity ?? 1,
    canGrow: overrides?.canGrow ?? (() => true),
  });
  return { pool, spawned };
}

test("replenish spawns up to capacity and no further", () => {
  const { pool, spawned } = createPool({ capacity: 2 });
  pool.replenish();
  pool.replenish();
  expect(spawned.length).toBe(2);
  expect(pool.size()).toBe(2);
});

test("replenish spawns nothing while canGrow is false", () => {
  const { pool, spawned } = createPool({ canGrow: () => false });
  pool.replenish();
  expect(spawned).toEqual([]);
  expect(pool.size()).toBe(0);
});

test("take hands back a spawned child and empties the slot", () => {
  const { pool, spawned } = createPool();
  pool.replenish();
  expect(pool.take()).toBe(spawned[0]!);
  expect(pool.size()).toBe(0);
});

test("take returns null on an empty pool and never spawns", () => {
  const { pool, spawned } = createPool();
  expect(pool.take()).toBeNull();
  expect(spawned).toEqual([]);
});

test("a spare that exited while idle is not handed out", async () => {
  const { pool, spawned } = createPool();
  pool.replenish();
  spawned[0]!.settleExit(1);
  await Promise.resolve().then(() => Promise.resolve()); // flush the exited.then(drop) microtask
  expect(pool.take()).toBeNull();
  expect(pool.size()).toBe(0);
});

test("a spawn failure is logged and leaves the pool empty, never a rejected promise", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const pool = createSparePool({
    spawn: () => new SupervisorError({ code: "SPAWN_FAILED", reason: "EACCES (spawn)" }),
    command: { cmd: ["bun"] },
    capacity: 1,
    canGrow: () => true,
  });
  pool.replenish();
  expect(pool.size()).toBe(0);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

test("drain kills every idle spare and empties the pool", () => {
  const { pool, spawned } = createPool({ capacity: 2 });
  pool.replenish();
  pool.drain();
  expect(spawned.every((child) => child.killed)).toBe(true);
  expect(pool.size()).toBe(0);
});
