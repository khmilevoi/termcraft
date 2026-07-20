// Claude backend public entry (master §6.1): the concrete AgentBackend over
// @anthropic-ai/claude-agent-sdk, plus the real-world wiring (Job Object
// process tree, real sleep, the Spike F reparse-point backstop) that
// assembles the PRODUCTION instance. NON-Reatom injected adapter — no atoms,
// no connect-hook lifetimes; the run/process lifetime is owned explicitly
// (hardening §3.8).
export { createClaudeBackend } from "./model/claude-backend"
export { createRealQueryFn } from "./model/query-fn"
export type { ClaudeBackendDeps, ClaudeQuery, ClaudeQueryFn } from "./types"

import { isReparsePoint } from "infrastructure/fs-guard"
import { createJobObjectTree } from "infrastructure/process"
import type { AgentBackend } from "agent/types"
import { createClaudeBackend } from "./model/claude-backend"
import { createRealQueryFn } from "./model/query-fn"
import type { ClaudeBackendDeps } from "./types"

/**
 * finding [34]: `hasReparsePoint` narrows `isReparsePoint`'s
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
  return isReparsePoint(candidatePath) === true
}

/**
 * Production wiring: real SDK query + real Job Object tree + real sleep +
 * the Spike F reparse backstop. Exported (not inlined into
 * `createProductionClaudeBackend`) so a test can assert the backstop is
 * actually present on the deps the shipped binary constructs, rather than
 * only on the standalone `hasReparsePoint` helper — finding [34] was
 * specifically that the wiring site silently omitted it while an unrelated
 * unit test kept reporting the primitive itself as covered.
 */
export function createProductionClaudeBackendDeps(): ClaudeBackendDeps {
  return {
    queryFn: createRealQueryFn(),
    processTreeFactory: createJobObjectTree,
    wait: (ms) => Bun.sleep(ms),
    hasReparsePoint,
  }
}

/** Production wiring: real SDK query + real Job Object tree + real sleep + the Spike F reparse backstop. */
export function createProductionClaudeBackend(): AgentBackend {
  return createClaudeBackend(createProductionClaudeBackendDeps())
}
