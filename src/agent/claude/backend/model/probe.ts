import * as errore from "errore"
import os from "node:os"
import type { CanUseTool, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { createConfinementPolicy } from "agent/confinement"
import { runHealthProbe } from "agent/health"
import type { HealthProbeDeps } from "agent/health"
import type { AgentInfo } from "agent/types"
import type { ClaudeQueryFn } from "agent/claude/types"
import { CLAUDE_BACKEND_ID } from "agent/claude/model/backend-id"
import { makeSpawnAndAdopt } from "agent/claude/model/spawn-adopt"
import { CLAUDE_CONFINEMENT_TABLES } from "agent/claude/tools"

/**
 * Fired once a verdict has already left `readUntilClassified`'s `for await`
 * loop (see below) — never while the loop is still consuming a message. The
 * `for await` loop's own `break`/`return` triggers the SDK generator's
 * `IteratorClose` (awaiting its `.return()`); if we had already aborted the
 * controller at that point, the generator's cleanup can see the aborted
 * signal and reject, and — for a `return` completion — that rejection
 * REPLACES the value we were returning, silently discarding an
 * already-computed verdict. Firing the abort only after the loop has fully
 * exited (its own close already settled, unaffected by our controller)
 * removes that race entirely. Extends `errore.AbortError` so a downstream
 * `errore.isAbortError` check still detects it if it ever ends up wrapped in
 * another error's `.cause` chain — mirrors `TurnAbortError` in agent-run.ts.
 */
class ProbeClassifiedAbortError extends errore.createTaggedError({
  name: "ProbeClassifiedAbortError",
  message: "health probe classified, aborting the ping",
  extends: errore.AbortError,
}) {}

/**
 * Health probe cwd (master §9: run at startup and before every `send`). The
 * probe has no turn workspace to bind to, and the SDK's `Options.cwd`
 * defaults to `process.cwd()` when unset — termcraft's OWN process cwd, i.e.
 * the user's project root. Binding there (combined with unset
 * `settingSources`) would let a project's `.claude/settings.json`
 * `SessionStart` hook execute before the master §3.1 trust prompt is ever
 * answered. `os.tmpdir()` is a fixed, project-independent scratch location:
 * nothing a project can plant reaches it.
 */
const PROBE_CWD = os.tmpdir()

/**
 * Build SDK options for the probe's minimal "ping" query, isolated AT LEAST
 * as strictly as a real turn's `buildQueryOptions` (query-fn.ts): settings
 * isolated (`settingSources: []`), cwd pinned to a scratch dir instead of
 * termcraft's own cwd, and `canUseTool` wired to the same deny-by-default
 * confinement policy (confinement.ts) scoped to that scratch dir — so the
 * probe can allow nothing a real project could ever have planted to be
 * allowed. The probe issues no tool calls itself; this is defense-in-depth
 * against a hostile or malfunctioning CLI, exactly how a turn treats its own
 * `canUseTool` as belt-and-braces alongside the Gate.
 *
 * Note: the file-tool allowance in the reused confinement policy is scoped to
 * the whole OS tmpdir (shared machine-wide scratch space), not a
 * single-use-per-probe directory — the probe has no per-call workspace to
 * allocate, and creating/removing one here would add filesystem side effects
 * to what should stay a read-only probe. This is still strictly more
 * isolated than any real turn, which always grants access to real
 * user-authored files.
 *
 * finding [26] half b: `spawnClaudeCodeProcess` is wired only when
 * `deps.processTree` is non-`null` — when the caller's `ProcessTreeFactory`
 * could not produce a tree at all, there is nothing to adopt into, and the
 * SDK falls back to spawning the CLI internally exactly as it did before
 * this fix (an explicit, narrower fallback, not the original bug of always
 * skipping adoption). See `claude-backend.ts`'s `healthCheck()` for why that
 * fallback still runs the probe instead of reporting a false verdict.
 */
function buildProbeOptions(deps: HealthProbeDeps): Options {
  const policy = createConfinementPolicy(PROBE_CWD, CLAUDE_CONFINEMENT_TABLES)
  const canUseTool: CanUseTool = async (toolName, input, options) => {
    const decision = policy(toolName, input, options.blockedPath)
    return decision.behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: decision.message }
  }
  return {
    cwd: PROBE_CWD,
    additionalDirectories: [],
    settingSources: [],
    permissionMode: "default",
    abortController: deps.abortController,
    canUseTool,
    ...(deps.processTree !== null ? { spawnClaudeCodeProcess: makeSpawnAndAdopt(deps.processTree, "agent/health") } : {}),
  }
}

/**
 * One probe message's verdict, or `null` when the message is inconclusive
 * and the probe should keep reading. Pure — no side effects. The caller
 * (`readUntilClassified`) decides when to actually fire the abort, and does
 * so deliberately AFTER the verdict has left the `for await` loop (see
 * {@link ProbeClassifiedAbortError}).
 */
function classifyMessage(msg: SDKMessage): AgentInfo | null {
  if (msg.type === "system" && msg.subtype === "init") {
    // `apiKeySource` (`'user'|'project'|'org'|'temporary'|'oauth'`) is WHERE
    // the credential came from, not WHOSE it is — it takes one of five values
    // for every account alive, so it cannot serve as the stable account
    // discriminator `sessionScope` needs (storage-identity §6.2). The
    // installed SDK's `SDKSystemMessage` has no field that is one, so `null`
    // — which safely disables cross-process resume for this backend
    // (types.ts `AgentInfo.account` doc) — is the honest value, not a guess.
    return { backendId: CLAUDE_BACKEND_ID, health: { status: "ready" }, account: null }
  }
  if (msg.type === "auth_status") {
    return { backendId: CLAUDE_BACKEND_ID, health: { status: "not-logged-in" }, account: null }
  }
  if (msg.type === "assistant" && msg.error === "authentication_failed") {
    return { backendId: CLAUDE_BACKEND_ID, health: { status: "not-logged-in" }, account: null }
  }
  return null
}

/** Renders a thrown/rejected value into a stable message even when it is not an `Error` instance. */
function describeThrown(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Read the probe stream message by message until one of them classifies the
 * health state, or it ends.
 *
 * Two defenses against the SDK generator's own `IteratorClose` cleanup
 * discarding an already-computed verdict (see {@link ProbeClassifiedAbortError}):
 * (1) the `break` below leaves the loop BEFORE the controller is aborted, so
 * the generator's `.return()` runs against a not-yet-aborted signal; (2) even
 * so, `.return()` can still reject for reasons unrelated to our own abort (a
 * flaky CLI, a vendor generator that always tears down uncleanly) — the
 * `try/catch` shields exactly that: a close failure AFTER `verdict` was
 * already set is swallowed (logged) instead of discarding the verdict, while
 * a close failure with no verdict yet still propagates as a real stream
 * failure. Boundary: `stream` is an injected/vendor async generator we do
 * not control — a raw `try/catch` here (not `errore.try`, which is for sync
 * boundaries) is the errore-sanctioned way to convert an external throw into
 * a value at the lowest call-stack level, mirroring `driveQuery` in
 * agent-run.ts.
 */
async function readUntilClassified(queryFn: ClaudeQueryFn, deps: HealthProbeDeps): Promise<AgentInfo | null> {
  const stream = queryFn({ prompt: "ping", options: buildProbeOptions(deps) })
  let verdict: AgentInfo | null = null
  try {
    for await (const msg of stream) {
      verdict = classifyMessage(msg)
      if (verdict !== null) break
    }
  } catch (cause) {
    if (verdict === null) throw cause
    console.warn(
      "agent/health: ignoring a stream-close failure that arrived after a verdict was already classified:",
      describeThrown(cause),
    )
  }
  // Fired only once the verdict (or a clean stream end) has fully left the
  // loop above, never while `for await` is still mid-iteration.
  if (verdict !== null) deps.abortController.abort(new ProbeClassifiedAbortError({}))
  return verdict
}

/**
 * The Claude health probe: run a minimal, isolated "ping" query and read until
 * a message classifies the state. Everything not specific to Claude's message
 * vocabulary — the deadline, the tree close, the ambiguity classification —
 * belongs to `runHealthProbe` (agent/health).
 */
export function probeClaudeHealth(queryFn: ClaudeQueryFn, deps: HealthProbeDeps): Promise<AgentInfo> {
  return runHealthProbe(CLAUDE_BACKEND_ID, () => readUntilClassified(queryFn, deps), deps)
}
