import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DirectoryFlushError } from "infrastructure/durability";

import type { StoreDeps } from "../types";
import { createStore, nodeStoreDeps } from "./factory";

// M5 (turn-durability S1/S13, storage-identity S4): the durability pre-flight must run BEFORE
// any mutation of the target volume — before the lease acquire in `openProject`, before
// `mkdirSync` in `createProject` — and refuse the whole call with the existing tagged error
// when it fails. This exercises the wiring through the store's existing `StoreDeps.flushDir`
// test seam (the same knob `nodeStoreDeps` already wires to the real `flushDir`), never a real
// non-durable volume.

const scratchRoots: string[] = [];

function freshScratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function cleanDeps(userStateRoot: string): StoreDeps {
  return nodeStoreDeps({ userStateRoot });
}

function refusingDeps(userStateRoot: string): StoreDeps {
  const flushError = new DirectoryFlushError({ path: "durability-gate-test", lastError: 1 });
  return { ...nodeStoreDeps({ userStateRoot }), flushDir: () => flushError };
}

describe("durability pre-flight gate (M5)", () => {
  test("createProject refuses on a volume the durability probe rejects, and performs no mutation — no .termcraft is created", async () => {
    const userStateRoot = freshScratch("tc-durability-userstate-");
    const projectRoot = freshScratch("tc-durability-create-");
    const store = createStore(refusingDeps(userStateRoot));

    const result = await store.createProject({
      root: projectRoot,
      name: "Refused",
      targetStack: "generic",
    });

    expect(result instanceof Error).toBe(true);
    expect(DirectoryFlushError.is(result)).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, ".termcraft"))).toBe(false);
  }, 20_000);

  test("openProject refuses on a volume the durability probe rejects, and leaves no lease held — a later attempt with a clean probe still succeeds", async () => {
    const userStateRoot = freshScratch("tc-durability-userstate-");
    const projectRoot = freshScratch("tc-durability-open-");

    // A real project must already exist for `openProject` to have anything to open.
    const cleanStore = createStore(cleanDeps(userStateRoot));
    const created = await cleanStore.createProject({
      root: projectRoot,
      name: "Original",
      targetStack: "generic",
    });
    if (created instanceof Error) throw new Error(`fixture bug: ${created.message}`);
    await created.close();

    const refusingStore = createStore(refusingDeps(userStateRoot));
    const refused = await refusingStore.openProject(projectRoot);
    expect(refused instanceof Error).toBe(true);
    expect(DirectoryFlushError.is(refused)).toBe(true);

    // No lease left held: a later attempt with a clean probe reaches the project rather than a
    // LeaseHeldError, proving the refused attempt above never acquired the lease.
    const reopened = await cleanStore.openProject(projectRoot);
    if (reopened instanceof Error) throw new Error(`openProject failed: ${reopened.message}`);
    await reopened.close();
  }, 20_000);
});
