import * as errore from "errore"
import os from "node:os"
import type { CanUseTool, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AgentInfo, BackendCapabilities } from "../types"
import { makeConfinementPolicy } from "./confinement"
import { AgentHealthProbeError } from "./errors"
import type { ClaudeQueryFn } from "./query-fn"

const BACKEND_ID = "claude"

/** MVP model catalog (master §9 picker). Effort set mirrors the SDK `EffortLevel`. */
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

/** Fired when no classifying message (nor a clean stream end) arrives within the probe deadline. */
class ProbeDeadlineAbortError extends errore.createTaggedError({
  name: "ProbeDeadlineAbortError",
  message: "health probe exceeded $deadlineMs ms with no classifying message",
  extends: errore.AbortError,
}) {}

/** Deps for {@link probeHealth}. */
export interface ProbeHealthDeps {
  readonly abortController: AbortController
  /**
   * Injectable delay for the probe deadline below — mirrors `RunDeps.wait` in
   * agent-run.ts. Defaults to a real, `unref`'d timer (never blocks process
   * exit) so production is bounded even without an explicit override; tests
   * inject a fake to exercise the timeout path without a real clock.
   */
  readonly wait?: (ms: number) => Promise<void>
  /** Probe read budget; defaults to {@link DEFAULT_PROBE_DEADLINE_MS}. */
  readonly deadlineMs?: number
}

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

/** Probe read budget (master §9). No spec value is given; generous enough for
 * a cold CLI start + auth handshake, bounded so a silent CLI cannot hang
 * `healthCheck()` forever. Overridable via {@link ProbeHealthDeps.deadlineMs}. */
const DEFAULT_PROBE_DEADLINE_MS = 20_000

/** Real default for {@link ProbeHealthDeps.wait}: `unref`'d so an abandoned
 * deadline (the read finished first) never keeps the process alive. */
function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

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
 */
function buildProbeOptions(deps: ProbeHealthDeps): Options {
  const policy = makeConfinementPolicy(PROBE_CWD)
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
    return { backendId: BACKEND_ID, health: { status: "ready" }, account: null }
  }
  if (msg.type === "auth_status") {
    return { backendId: BACKEND_ID, health: { status: "not-logged-in" }, account: null }
  }
  if (msg.type === "assistant" && msg.error === "authentication_failed") {
    return { backendId: BACKEND_ID, health: { status: "not-logged-in" }, account: null }
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
async function readUntilClassified(queryFn: ClaudeQueryFn, deps: ProbeHealthDeps): Promise<AgentInfo | null> {
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
 * Bound `readUntilClassified` so a CLI that connects and then emits nothing
 * cannot hang `probeHealth` — and therefore `AgentBackend.healthCheck()` —
 * forever. Uses the injected `wait` seam (mirrors `RunDeps.wait` in
 * agent-run.ts) rather than a bare timer so the deadline is a testable
 * value, not a real clock. On a timeout, aborts the controller so the
 * still-pending read eventually stops, and attaches a log-only handler to
 * that now-abandoned promise so a late settle (success or failure) never
 * surfaces as an unhandled rejection — the timeout has already committed to
 * its own verdict by then.
 */
async function withProbeDeadline(
  pending: Promise<AgentInfo | null>,
  deps: ProbeHealthDeps,
): Promise<AgentInfo | null | ProbeDeadlineAbortError> {
  const wait = deps.wait ?? defaultWait
  const deadlineMs = deps.deadlineMs ?? DEFAULT_PROBE_DEADLINE_MS
  const timedOut = wait(deadlineMs).then(() => new ProbeDeadlineAbortError({ deadlineMs }))

  const winner = await Promise.race([pending, timedOut])
  if (!(winner instanceof ProbeDeadlineAbortError)) return winner

  deps.abortController.abort(winner)
  pending.catch((e) => {
    // Deliberately swallowed (rule: log what you don't propagate) — the
    // deadline already produced probeHealth's verdict; a late rejection from
    // the abandoned read is expected once we abort it above, not a new failure.
    console.warn("agent/health: probe read failed after the deadline already fired:", describeThrown(e))
  })
  return winner
}

/**
 * Probe installed/logged-in state (master §9) without completing a paid turn:
 * run a minimal, isolated query and read until a `system:init` message (CLI
 * reached, installed — `ready`), an auth signal (`auth_status`, or an
 * assistant `error:'authentication_failed'` — both `not-logged-in`), the
 * stream ends, or the bounded deadline elapses. A spawn/`ENOENT` throw while
 * iterating is `not-installed`. Errors are values — the probe never throws.
 *
 * Non-Reatom: the `AbortController` and stream iteration here are explicit,
 * caller-owned state for one probe call, not a lifetime for Reatom to manage
 * — matches `agent/`'s non-Reatom adapter status (CLAUDE.md / plan Global
 * Constraints).
 */
export async function probeHealth(queryFn: ClaudeQueryFn, deps: ProbeHealthDeps): Promise<AgentInfo> {
  const result = await withProbeDeadline(readUntilClassified(queryFn, deps), deps).catch(
    (e) => new AgentHealthProbeError({ reason: describeThrown(e), cause: e }),
  )

  if (errore.isAbortError(result)) {
    // Either the read's own IteratorClose raced with something unrelated to
    // our post-verdict abort, or the probe deadline elapsed with no
    // classification — either way there is no confirmed verdict. Never
    // report "ready" on ambiguity (a false-ready would let a real, paid turn
    // start against a broken backend); fall through to the same safe default
    // as any other inconclusive probe.
    console.warn("agent/health: probe aborted without a confirmed verdict:", result.message)
    return { backendId: BACKEND_ID, health: { status: "not-logged-in" }, account: null }
  }

  if (result instanceof Error) {
    // Swallowed here (the probe never throws) — logged so a broken CLI/spawn
    // path is still visible, per errore's "log what you don't propagate".
    // NOTE: only `.message` (present on any `Error`) is read here, not a
    // tag-specific field like `AgentHealthProbeError.reason` — errore's
    // `isAbortError` types its parameter as `error is Error` (not a
    // narrower abort type), so its negative branch above already widens
    // `result`'s statically-known type past the concrete tagged-error
    // class; `.message` still carries the same `$reason` text as part of
    // the rendered template, so the regex below is unaffected.
    console.warn("agent/health: probe stream failed:", result.message)
    const notInstalled = /ENOENT|not found|spawn/i.test(result.message)
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
