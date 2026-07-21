// Claude backend public entry (master §6.1): the concrete AgentBackend over
// @anthropic-ai/claude-agent-sdk, plus the real-world wiring (Job Object
// process tree, real sleep, the Spike F reparse-point backstop) that
// assembles the PRODUCTION instance. NON-Reatom injected adapter — no atoms,
// no connect-hook lifetimes; the run/process lifetime is owned explicitly
// (hardening §3.8).
import type { AgentBackend } from "agent/types";
import { isReparsePoint } from "infrastructure/fs-guard";
import { createJobObjectTree } from "infrastructure/process";

import { createClaudeBackend } from "./backend";
import { createRealQueryFn } from "./query";
import type { ClaudeBackendDeps } from "./types";

export { createClaudeBackend } from "./backend";
export { createRealQueryFn } from "./query";
export type { ClaudeBackendDeps, ClaudeQuery, ClaudeQueryFn } from "./types";

/**
 * `hasReparsePoint` narrows `isReparsePoint`'s
 * `boolean | FileAttributesError | FsGuardUnavailableError` down to the
 * plain `boolean` the confinement chain wants — path-containment.ts's
 * `isInsideStaging` only ever asks "is this a reparse point?", not "did the
 * query itself fail?"; a query failure (non-Windows, or a transient
 * `GetFileAttributesW` error) is treated the same as "not a reparse point"
 * (`false`), i.e. fails open on THIS specific signal — the prefix
 * containment test above it in `isInsideStaging` remains the primary guard
 * either way, so this backstop degrading to a no-op on query failure does
 * not itself defeat confinement.
 */
function hasReparsePoint(candidatePath: string): boolean {
  return isReparsePoint(candidatePath) === true;
}

/**
 * Production wiring: real SDK query + real Job Object tree + real sleep +
 * the Spike F reparse backstop. Exported (not inlined into
 * `createProductionClaudeBackend`) so a test can assert the backstop is
 * actually present on the deps the shipped binary constructs — a passing
 * unit test for the standalone `hasReparsePoint` helper proves nothing about
 * whether the production wiring site actually wires it in.
 */
export function createProductionClaudeBackendDeps(): ClaudeBackendDeps {
  return {
    queryFn: createRealQueryFn(),
    processTreeFactory: createJobObjectTree,
    wait: (ms) => Bun.sleep(ms),
    hasReparsePoint,
  };
}

/** Production wiring: real SDK query + real Job Object tree + real sleep + the Spike F reparse backstop. */
export function createProductionClaudeBackend(): AgentBackend {
  return createClaudeBackend(createProductionClaudeBackendDeps());
}
