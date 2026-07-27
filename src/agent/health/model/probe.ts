import * as errore from "errore";

import type { AgentInfo } from "agent/types";
import { trace } from "infrastructure/debug-log";

import type { HealthProbeDeps, HealthProbeReader } from "../types";
import { withProbeDeadline } from "./deadline";
import { AgentHealthProbeError } from "./errors";

function describeThrown(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * A probe that ran out of time — or whose stream closed cleanly with nothing classified — proves
 * NOTHING (finding §2.7). CORRECTED (fix round 1, Finding 3): this used to reuse
 * `unhealthy-unconfirmed-exit`, but that status is NOT a generic "could not confirm" bucket — it
 * is `agent/claude/backend/model/backend.ts`'s own POSITIVELY established latch, set only when a
 * prior RUN's exit was never confirmed, and it makes `startTurn` REFUSE new turns until restart
 * (`agent/run/model/unconfirmed-exit-latch.ts`). Reusing it here would make Home treat a
 * genuinely unproven probe reading as though a turn were confirmed to fail — telling the user
 * Enter is refused when nothing established that. `probe-inconclusive` is its own honest status:
 * Home maps it to the design's own `health unconfirmed` panel, which still allows submit — a
 * timeout is not evidence a turn would fail.
 *
 * CONFLICTING DESIGN SOURCES ON THIS EXACT POINT (fix round 2, recorded here per this project's
 * rule that a divergence lives in the code, not only a report): `design/01-home.dc.html:83`'s own
 * prose reads "The 20 s timeout in the checking state resolves here, to not signed in" — i.e. a
 * checking timeout should BLOCK. That contradicts `design/termcraft-engine.js:165-166`'s own
 * comment, which classifies "probe ended unconfirmed" as one of "the three health outcomes with
 * no full-screen takeover... (both advisory)" — i.e. a timeout should ALLOW submit. This code
 * follows `termcraft-engine.js` (the engine that actually renders `homeHealth('shutdown')`, the
 * panel a probe timeout reaches via `probe-inconclusive` above), not the `.dc.html` prose, which
 * appears to predate or simply misstate the engine's own behavior. Also matches the Global
 * Constraint against telling the user Enter is refused with no established cause, and the fix
 * bundle's own review, which confirmed this reading explicitly.
 */
function inconclusive(backendId: string): AgentInfo {
  return { backendId, health: { status: "probe-inconclusive" }, account: null };
}

/**
 * Run one backend's health probe under a bounded deadline and classify its
 * result. The vendor supplies `read`, which knows its own message vocabulary;
 * everything here is backend-agnostic policy:
 *
 *  - the deadline, its abort, and suppression of the abandoned read's late
 *    rejection (deadline.ts);
 *  - closing the adopted process tree once the probe settles, on EVERY path —
 *    this one call site sits after every branch, so a new early return cannot
 *    skip it. Arms kill-on-close for a probe CLI that ignored the abort;
 *  - the classification of an inconclusive probe. NEVER report `ready` on
 *    ambiguity: a false-ready would let a real, paid turn start against a
 *    broken backend. A deadline abort and a clean close with no verdict both
 *    genuinely prove NOTHING (finding §2.7) — neither classifies as an auth
 *    failure, and neither classifies as the backend's own confirmed
 *    `unhealthy-unconfirmed-exit` latch either (fix round 1, Finding 3); both
 *    go through {@link inconclusive}'s own honest `probe-inconclusive`. An
 *    actual stream failure (the read itself threw) is more decisive than
 *    either and keeps its own not-installed/not-logged-in split below,
 *    unaffected by this fix.
 */
export async function runHealthProbe(
  backendId: string,
  read: HealthProbeReader,
  deps: HealthProbeDeps,
): Promise<AgentInfo> {
  // `read` is an injected callback typed to return a Promise, but nothing
  // stops a non-async implementation from throwing synchronously. Calling it
  // here, inside the promise chain, instead of as a bare argument turns that
  // synchronous throw into a rejection the `.catch` below can convert into a
  // value, keeping the single `close()` call below reachable on every path.
  const result = await withProbeDeadline(Promise.resolve().then(read), deps).catch(
    (e) => new AgentHealthProbeError({ reason: describeThrown(e), cause: e }),
  );

  deps.processTree?.close();

  if (errore.isAbortError(result)) {
    console.warn("agent/health: probe aborted without a confirmed verdict:", result.message);
    const info = inconclusive(backendId);
    // DIAGNOSTIC (infrastructure/debug-log): the probe deadline aborted it before it could classify
    // anything -- recorded as its own reason, distinct from a genuine stream failure.
    trace("agent.health.probeResult", { backendId, reason: "aborted", info });
    return info;
  }

  if (result instanceof Error) {
    // Swallowed (the probe never throws) — logged so a broken CLI/spawn path
    // stays visible, per errore's "log what you don't propagate".
    console.warn("agent/health: probe stream failed:", result.message);
    const notInstalled = /ENOENT|not found|spawn/i.test(result.message);
    const info: AgentInfo = {
      backendId,
      health: { status: notInstalled ? "not-installed" : "not-logged-in" },
      account: null,
    };
    // DIAGNOSTIC (infrastructure/debug-log): the probe's own read threw -- the message is what
    // decides the not-installed/not-logged-in split below.
    trace("agent.health.probeResult", {
      backendId,
      reason: "stream-error",
      message: result.message,
      info,
    });
    return info;
  }

  if (result !== null) {
    // The vendor `read` is trusted for everything except its own `backendId`
    // echo — a reader that returns a mismatched id would otherwise pass
    // straight through and misattribute this verdict to the wrong backend.
    if (result.backendId !== backendId) {
      console.warn(
        `agent/health: probe verdict backendId mismatch (expected "${backendId}", got "${result.backendId}"); substituting the expected id`,
      );
      const info = { ...result, backendId };
      // DIAGNOSTIC (infrastructure/debug-log): the vendor reader echoed a mismatched backendId --
      // recording both the substitution and the verdict it wrapped.
      trace("agent.health.probeResult", { backendId, reason: "backendId-mismatch", info });
      return info;
    }
    // DIAGNOSTIC (infrastructure/debug-log): the probe classified normally -- the ordinary
    // healthCheck result every backend's own probe.ts eventually returns here.
    trace("agent.health.probeResult", { backendId, reason: "classified", info: result });
    return result;
  }

  // The stream closed cleanly without ever classifying. The CLI ran without
  // throwing, so this is not "not-installed"; nothing confirmed a working
  // session either, so it must not be "ready".
  const info = inconclusive(backendId);
  // DIAGNOSTIC (infrastructure/debug-log): the stream closed cleanly without ever classifying --
  // the CLI ran without throwing, but nothing confirmed a working session either.
  trace("agent.health.probeResult", { backendId, reason: "inconclusive", info });
  return info;
}
