import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { systemClock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";
import { CURRENT_KIT_API_VERSION } from "runtime";
import { createStore, nodeStoreDeps } from "store/model/factory";

import type { OpenProject } from "../types";
import type { StoreAdapterDeps } from "./types";

// Shared contract-test fixture: a real `createProject(...)` over a temp directory, offline
// (no network, no external process) — every adapter's contract test in this ring drives the
// SAME real store this way, per the plan's Task 1 "TDD steps". Test-only; not re-exported
// from `store/index.ts`.

const scratchRoots: string[] = [];

function freshScratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchRoots.push(dir);
  return dir;
}

/** Registers the standard cleanup for every scratch directory minted by {@link withRealProject} in this test file. Call once at module scope inside an `afterEach`. */
export function cleanupScratchRoots(): void {
  for (const dir of scratchRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

export interface RealProjectFixture {
  readonly open: OpenProject;
  readonly deps: StoreAdapterDeps;
}

/** Opens a fresh real project over a temp directory and hands back both the raw `OpenProject` and the `StoreAdapterDeps` bundle every adapter factory takes. Caller must `await open.close()` when done. */
export async function createRealProjectFixture(options?: {
  readonly name?: string;
  readonly targetStack?: "rust-ratatui" | "go-bubbletea" | "js-opentui" | "generic";
}): Promise<RealProjectFixture> {
  const userStateRoot = freshScratch("tc-adapters-userstate-");
  const projectRoot = freshScratch("tc-adapters-project-");
  const storeDeps = nodeStoreDeps({ userStateRoot });
  const store = createStore(storeDeps);
  const opened = await store.createProject({
    root: projectRoot,
    name: options?.name ?? "Adapter Fixture Project",
    targetStack: options?.targetStack ?? "generic",
    kitApiVersion: CURRENT_KIT_API_VERSION,
  });
  if (opened instanceof Error) {
    throw new Error(`fixture bug: createProject failed: ${opened.message}`, { cause: opened });
  }
  return { open: opened, deps: { open: opened, uuidv7, clock: systemClock } };
}
