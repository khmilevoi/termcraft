import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DirectoryFlushError, flushDir } from "infrastructure/durability";
import { LeaseIoError } from "store/lease";

import type { StoreDeps } from "../types";
import { createStore, nodeStoreDeps } from "./factory";

const onWindows = process.platform === "win32";

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

  // Regression test (review finding on WP-7): `openProject`'s durability probe must target
  // `root` — the directory the caller pointed at, which already exists — never `termcraftDir`,
  // which does not exist yet for the legitimate "this is not a project" case. Probing the
  // maybe-absent `.termcraft` would make `flushDir`'s Win32 `OPEN_EXISTING` call fail with
  // `ERROR_PATH_NOT_FOUND`, masking a merely-missing project as a `DirectoryFlushError` — the
  // same tagged error a genuinely non-durable volume produces (`ERROR_INVALID_FUNCTION`). With
  // the probe fixed, the next step to observe the missing `.termcraft` is the lease acquire's
  // own `requireLockDirectory` check (`store/lease/model/lease.ts`) — which already turns an
  // ENOENT `stat` into a named `LeaseIoError` rather than a raw OS error, by the same design
  // principle this fix applies to the durability probe. This only exercises the real Win32
  // primitives on Windows (`assertDurableVolume`'s `assertVolume` collaborator is not
  // overridable from this factory-level call, only `flush` is), so it follows the sibling
  // `flush-dir.test.ts`/`volume.test.ts` `skipIf(!onWindows)` convention.
  test.skipIf(!onWindows)(
    "openProject on a healthy volume with no .termcraft reaches the not-a-project error, not a DirectoryFlushError",
    async () => {
      const userStateRoot = freshScratch("tc-durability-userstate-");
      const projectRoot = freshScratch("tc-durability-missing-termcraft-");
      const probedPaths: string[] = [];
      const deps: StoreDeps = {
        ...cleanDeps(userStateRoot),
        flushDir: (dirPath) => {
          probedPaths.push(dirPath);
          return flushDir(dirPath);
        },
      };
      const store = createStore(deps);

      const result = await store.openProject(projectRoot);

      expect(result instanceof Error).toBe(true);
      expect(DirectoryFlushError.is(result)).toBe(false);
      expect(LeaseIoError.is(result)).toBe(true);
      // The probe ran against `root` (which exists) — never against the missing `.termcraft`.
      expect(probedPaths).toEqual([projectRoot]);
    },
    20_000,
  );
});
