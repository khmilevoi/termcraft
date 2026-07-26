import * as errore from "errore";

import type { AgentInfo } from "agent/types";

import type { HealthProbeDeps, HealthProbeReader } from "../types";
import { withProbeDeadline } from "./deadline";
import { AgentHealthProbeError } from "./errors";

function describeThrown(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * A probe that ran out of time proves NOTHING — least of all that the user is signed out
 * (finding §2.7). Reporting `not-logged-in` on deadline expiry is what locked the whole
 * application on a slow-but-working CLI after 20 s. `unhealthy-unconfirmed-exit` is the existing
 * variant that already means "we could not confirm", and Home maps it to the design's own
 * `health unconfirmed` panel, which still allows submit.
 */
function inconclusive(backendId: string): AgentInfo {
  return { backendId, health: { status: "unhealthy-unconfirmed-exit" }, account: null };
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
 *    failure any more; both go through {@link inconclusive}'s honest
 *    `unhealthy-unconfirmed-exit`. An actual stream failure (the read itself
 *    threw) is more decisive than either and keeps its own not-installed/
 *    not-logged-in split below, unaffected by this fix.
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
    return inconclusive(backendId);
  }

  if (result instanceof Error) {
    // Swallowed (the probe never throws) — logged so a broken CLI/spawn path
    // stays visible, per errore's "log what you don't propagate".
    console.warn("agent/health: probe stream failed:", result.message);
    const notInstalled = /ENOENT|not found|spawn/i.test(result.message);
    return {
      backendId,
      health: { status: notInstalled ? "not-installed" : "not-logged-in" },
      account: null,
    };
  }

  if (result !== null) {
    // The vendor `read` is trusted for everything except its own `backendId`
    // echo — a reader that returns a mismatched id would otherwise pass
    // straight through and misattribute this verdict to the wrong backend.
    if (result.backendId !== backendId) {
      console.warn(
        `agent/health: probe verdict backendId mismatch (expected "${backendId}", got "${result.backendId}"); substituting the expected id`,
      );
      return { ...result, backendId };
    }
    return result;
  }

  // The stream closed cleanly without ever classifying. The CLI ran without
  // throwing, so this is not "not-installed"; nothing confirmed a working
  // session either, so it must not be "ready".
  return inconclusive(backendId);
}
