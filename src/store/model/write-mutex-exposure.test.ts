import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CURRENT_KIT_API_VERSION } from "runtime";

import type { StoreDeps } from "../types";
import { createStore, nodeStoreDeps } from "./factory";

// Blocker B2 (phase-6 plan §2): `OpenProject` must expose the SAME `WriteMutex` instance
// every `TransactionEngine` method acquires/releases against internally — creating a SECOND,
// independent mutex would silently break single-writer exclusion (KCC §7.5/§12.5 needs export
// preparation to hold one short permit across a source/settings snapshot, release it before
// rendering, then reacquire the mutex for publication — impossible unless the same primitive
// backs both `OpenProject.writeMutex` and every engine call).
//
// The discriminating test: hold a permit through the PUBLIC handle (`opened.writeMutex`) and
// prove an engine call queues behind it rather than proceeding — if `writeMutex` were a
// separate mutex, the engine call would complete immediately regardless of the held permit.

const scratchRoots: string[] = [];

function freshScratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function testDeps(userStateRoot: string): StoreDeps {
  return nodeStoreDeps({ userStateRoot });
}

/** A trivial, zero-operation project-mutation — durable enough to exercise the real engine's acquire/release path without depending on any particular file content. */
function emptyMutation(input: { transactionId: string; actionId: string; createdAt: string }) {
  return {
    transactionId: input.transactionId,
    actionId: input.actionId,
    mutationKind: "local-state-write" as const,
    operations: [],
    payloads: new Map<string, Uint8Array>(),
    createdAt: input.createdAt,
  };
}

describe("OpenProject.writeMutex — the same exclusion primitive the engine uses internally (blocker B2)", () => {
  test("a permit held through the public handle blocks a TransactionEngine call, and releasing it lets that call proceed", async () => {
    const userStateRoot = freshScratch("tc-writemutex-userstate-");
    const projectRoot = freshScratch("tc-writemutex-project-");
    const store = createStore(testDeps(userStateRoot));

    const opened = await store.createProject({
      root: projectRoot,
      name: "Mutex Test",
      targetStack: "generic",
      kitApiVersion: CURRENT_KIT_API_VERSION,
    });
    if (opened instanceof Error)
      throw new Error(`fixture bug: createProject failed: ${opened.message}`);

    try {
      const held = await opened.writeMutex.acquire();
      expect(opened.writeMutex.isActive(held)).toBe(true);

      const order: string[] = [];
      const enginePromise = opened.transactions
        .runProjectMutation(
          emptyMutation({
            transactionId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d01",
            actionId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d02",
            createdAt: "2026-07-21T10:00:00Z",
          }),
        )
        .then((result) => {
          order.push("engine-settled");
          return result;
        });

      // Give the event loop several real turns to prove the engine call has NOT settled while
      // the test still holds the only permit. If `writeMutex` were a second, independent
      // mutex, the engine call would already have settled well before this timeout fires —
      // this is not a fragile timing race, it is a genuine dependency: the engine's own
      // internal `mutex.acquire()` cannot resolve until `held` is released, and it never will
      // be released within this window because ONLY this test controls that release.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(order).toEqual([]);

      opened.writeMutex.release(held);
      const result = await enginePromise;
      expect(order).toEqual(["engine-settled"]);
      expect(result instanceof Error).toBe(false);
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("openProject also exposes the shared mutex — a permit held after reopening blocks a fresh engine call the same way", async () => {
    const userStateRoot = freshScratch("tc-writemutex-userstate-");
    const projectRoot = freshScratch("tc-writemutex-reopen-");
    const store = createStore(testDeps(userStateRoot));

    const created = await store.createProject({
      root: projectRoot,
      name: "Reopen Mutex Test",
      targetStack: "generic",
      kitApiVersion: CURRENT_KIT_API_VERSION,
    });
    if (created instanceof Error) throw new Error(`fixture bug: ${created.message}`);
    await created.close();

    const reopened = await store.openProject(projectRoot);
    if (reopened instanceof Error)
      throw new Error(`fixture bug: openProject failed: ${reopened.message}`);

    try {
      const held = await reopened.writeMutex.acquire();

      const order: string[] = [];
      const enginePromise = reopened.transactions
        .runProjectMutation(
          emptyMutation({
            transactionId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d03",
            actionId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d04",
            createdAt: "2026-07-21T10:00:00Z",
          }),
        )
        .then((result) => {
          order.push("engine-settled");
          return result;
        });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(order).toEqual([]);

      reopened.writeMutex.release(held);
      await enginePromise;
      expect(order).toEqual(["engine-settled"]);
    } finally {
      await reopened.close();
    }
  }, 20_000);
});
