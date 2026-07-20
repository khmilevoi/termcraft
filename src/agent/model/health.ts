import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AgentInfo, BackendCapabilities } from "../types"
import { AgentHealthProbeError } from "./errors"
import type { ClaudeQueryFn } from "./query-fn"

const BACKEND_ID = "claude"

/** MVP model catalog (master §3.6 picker). Effort set mirrors the SDK `EffortLevel`. */
export function claudeCapabilities(): BackendCapabilities {
  return {
    backendId: BACKEND_ID,
    models: [
      { model: "claude-opus-4-8", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { model: "claude-sonnet-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
    ],
    confinement: "canUseTool",
    // Q1 (settled for MVP): a resumed vendor session may rebind to a NEW turn
    // workspace between attempts (cwd changes, the vendor session id stays put).
    // The conservative alternative — "fixed", forcing a fresh session whenever
    // the workspace changes — is a one-line change here if rebinding is ever
    // found to leak state across turn workspaces.
    sessionWorkspaceBinding: "rebindable",
  }
}

/** Deps for {@link probeHealth}. */
export interface ProbeHealthDeps {
  readonly abortController: AbortController
}

/**
 * One probe message's verdict, or `null` when the message is inconclusive and
 * the probe should keep reading. A conclusive verdict also fires the abort so
 * a `ready`/`not-logged-in` classification never lets a real, paid turn run
 * to completion (master §9).
 */
function classifyMessage(msg: SDKMessage, abortController: AbortController): AgentInfo | null {
  if (msg.type === "system" && msg.subtype === "init") {
    abortController.abort()
    return { backendId: BACKEND_ID, health: { status: "ready" }, account: msg.apiKeySource }
  }
  if (msg.type === "auth_status") {
    abortController.abort()
    return { backendId: BACKEND_ID, health: { status: "not-logged-in" }, account: null }
  }
  if (msg.type === "assistant" && msg.error === "authentication_failed") {
    abortController.abort()
    return { backendId: BACKEND_ID, health: { status: "not-logged-in" }, account: null }
  }
  return null
}

/** Read the probe stream message by message until one of them classifies the health state, or it ends. */
async function readUntilClassified(queryFn: ClaudeQueryFn, deps: ProbeHealthDeps): Promise<AgentInfo | null> {
  const stream = queryFn({ prompt: "ping", options: { abortController: deps.abortController } })
  for await (const msg of stream) {
    const info = classifyMessage(msg, deps.abortController)
    if (info !== null) return info
  }
  return null
}

/**
 * Probe installed/logged-in state (master §9) without completing a paid turn:
 * run a minimal query and read until a `system:init` message (CLI reached,
 * installed — `ready`, capturing the account discriminator), an auth signal
 * (`auth_status`, or an assistant `error:'authentication_failed'` — both
 * `not-logged-in`), or the stream ends. A spawn/`ENOENT` throw while iterating
 * is `not-installed`. Errors are values — the probe never throws.
 *
 * Non-Reatom: the `AbortController` and stream iteration here are explicit,
 * caller-owned state for one probe call, not a lifetime for Reatom to manage
 * — matches `agent/`'s non-Reatom adapter status (CLAUDE.md / plan Global
 * Constraints).
 */
export async function probeHealth(queryFn: ClaudeQueryFn, deps: ProbeHealthDeps): Promise<AgentInfo> {
  const result = await readUntilClassified(queryFn, deps).catch(
    (e) => new AgentHealthProbeError({ reason: e instanceof Error ? e.message : String(e), cause: e }),
  )

  if (result instanceof Error) {
    // Swallowed here (the probe never throws) — logged so a broken CLI/spawn
    // path is still visible, per errore's "log what you don't propagate".
    console.warn("agent/health: probe stream failed:", result.message)
    const notInstalled = /ENOENT|not found|spawn/i.test(String(result.reason))
    return {
      backendId: BACKEND_ID,
      health: { status: notInstalled ? "not-installed" : "not-logged-in" },
      account: null,
    }
  }

  if (result !== null) return result

  // Deliberate fallthrough (not accidental): the stream closed cleanly
  // without ever emitting `system:init` or an auth signal. The CLI process
  // ran without throwing, so this is not "not-installed"; but nothing
  // confirmed a working session either, so we must NOT report "ready" — a
  // false-ready would let a real, paid turn start against a broken backend.
  // Classify the unconfirmed case the same as an explicit auth failure.
  return { backendId: BACKEND_ID, health: { status: "not-logged-in" }, account: null }
}
