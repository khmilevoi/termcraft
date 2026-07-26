/**
 * `entrypoint/model/agent-health.ts` — phase-8 Task 9 (design §WP-5): the real Home health
 * probe. This file imports BOTH `agent` (backend/domain types — `AgentBackend`, `AgentInfo`)
 * and `ui/home` (presentation types — `HomeAgentHealth`) directly, which is normally forbidden
 * (`docs/architecture/code-structure.md`: "`ui` sees only core boundary types +
 * `PreviewSession` — never `store`, never host stdio, never `agent`"). `entrypoint` is the one
 * exception: it is the composition root, "the ONE place allowed to import across modules" —
 * this module is exactly that kind of glue, not a `ui`-module file reaching into `agent` on
 * its own.
 */
import * as errore from "errore";

import type { AgentBackend, AgentInfo } from "agent";
import type { AgentRegistry } from "core/ports";
import type { HomeAgentHealth } from "ui/home";

/**
 * Map from one `AgentBackend.healthCheck()` reading to Home's five-outcome `HomeAgentHealth`
 * (finding §2.7, phase-8 Task 15) — pure aside from one incidental diagnostic `console.warn`
 * (the `sandbox-degraded` branch, errore rule 21: a fact this function does not propagate into
 * its return value must still be logged). Exhaustive over every `AgentHealthState` variant
 * (`agent/types.ts`, mirrored verbatim at `core/ports/agent-backend.ts`) via a `switch` with no
 * `default` arm — TypeScript's own control-flow analysis makes a seventh variant added later a
 * `tsc` failure here, not a silent "ready".
 *
 * `HomeAgentHealth` carries no `version` field: `AgentInfo` never had one to report (only
 * `backendId`, `health`, `account` — `agent/types.ts`), so the field was always a fabrication
 * risk; dropping it is the honest fix, not a placeholder this function still needs to supply.
 *
 * CORRECTED CITATION (carried over from phase-8 Task 13, which introduced it): this doc comment
 * and the `ready` branch used to cite `design/termcraft-engine.js:143` for a Home "agent ready"
 * health line. Read literally, `:143` is `this.box(b,ix,iy,iw,boxH,{title:'describe',...})` —
 * the prompt input's own frame — and `home()` (`:135-163`) draws no health line at all; the
 * function was renamed/restructured (phase-8 Task 15) specifically because that line never
 * existed in the design and was false for the whole time a probe ran. The real agent-version
 * sites in this file are `homeHealth()`'s `spec.login` line (`:177`, "✗ codex 0.34 found · not
 * signed in") and `homeErr()`'s "healthy reads" legend (`:726`, "✓ codex 0.34") — both consumed
 * honestly (verbatim text minus the version this port never reads) by `HomeHealthPanel.tsx` and
 * the `not-installed` branch below, never by a "ready" line.
 *
 * Wording sources: `not-installed` below is verbatim design text (`design/termcraft-engine.js:720`
 * inside `homeErr()`, `:716-728`: `this.text(b,ix+2,iy+1,'✗ codex CLI not found',...)`) — CORRECTED
 * (fix round 1, Finding 2): previously miscited `:576`, which is
 * `if(e.role!==undefined){ this.ctext(...)` inside `chatSeq()`, an unrelated chat-transcript
 * branch. `not-logged-in` matches `homeHealth('login')`'s own line (`:177`) minus the version.
 * The other states have no design mock naming their exact text, so their `detail` is this
 * module's own honest wording — documented per branch below, never silently invented.
 */
export function homeHealthFromAgentInfo(info: AgentInfo): HomeAgentHealth {
  const { backendId, health } = info;
  switch (health.status) {
    case "ready":
      return { kind: "ready", agent: backendId };

    case "not-installed":
      // Verbatim design wording pattern — design/termcraft-engine.js:720 (`homeErr()`:
      // "✗ codex CLI not found"). The ✗ glyph is static UI chrome `Home.tsx` prefixes onto
      // this `detail` string, not part of the domain value itself.
      return { kind: "missing", agent: backendId, detail: `${backendId} CLI not found` };

    case "not-logged-in":
      // Design `homeHealth('login')` (`:177`, "✗ codex 0.34 found · not signed in") minus the
      // version `AgentInfo` never carries — a panel below the prompt (`HomeHealthPanel.tsx`),
      // not the full-screen takeover `not-installed` above still gets.
      return {
        kind: "blocked",
        agent: backendId,
        panel: "login",
        detail: `${backendId} found · not signed in`,
      };

    case "unhealthy-unconfirmed-exit":
      // CORRECTED (fix round 1, Finding 3): this status is the backend's own POSITIVELY
      // established latch (`agent/claude/backend/model/backend.ts`'s `unhealthy.isLatched()`
      // guard) — a prior run's exit was never confirmed, and `startTurn` REFUSES new turns
      // until restart (`agent/run/model/unconfirmed-exit-latch.ts`). That is a genuine block,
      // not an unproven reading — mapping it to `advisory` (as this switch used to) told the
      // user Enter would work when a real turn would be rejected, exactly the class of
      // fabrication finding §2.7 exists to remove. DIVERGENCE: no design mock covers "backend
      // latched" — `homeHealth()`'s three panels are `login`/`shutdown`/`sandbox` only
      // (`design/termcraft-engine.js:165-195`) — so `blocked`/`panel:"latched"` is the closest
      // faithful mapping (same refuse-and-panel-below-prompt shape as `login`); honest new
      // wording lives in `HomeHealthPanel.tsx`'s own `panelSpec`, which documents the
      // divergence at the point it renders. Restored the pre-Task-15 wording ("locked out until
      // restarted") that names the actual, only unblock condition
      // (`unconfirmed-exit-latch.ts`'s own doc comment: "the user restarts").
      return {
        kind: "blocked",
        agent: backendId,
        panel: "latched",
        detail: `${backendId} exited without confirming shutdown; locked out until restarted`,
      };

    case "probe-inconclusive":
      // The health PROBE ITSELF could not reach a verdict (deadline, abort, or a clean stream
      // close with nothing classified — `agent/health/model/probe.ts`'s `inconclusive`) — this
      // is the genuinely unproven case finding §2.7 names, distinct from the confirmed latch
      // above (fix round 1, Finding 3). Submit stays allowed, and Home renders design's own
      // `health unconfirmed` panel (`homeHealth('shutdown')`, `:180-183`).
      return {
        kind: "advisory",
        agent: backendId,
        panel: "shutdown",
        detail: `${backendId}'s health probe ended without a confirmed verdict`,
      };

    case "sandbox-degraded":
      // DIVERGENCE: Codex-only, never reported for the Claude backend MVP ships (this
      // variant's own doc comment on `AgentHealthState`) — unreachable today, still handled
      // honestly for exhaustiveness. Master spec §9 treats a degraded sandbox as the CLI still
      // being present and usable, just under a weaker confinement guarantee — submit stays
      // allowed, matching design's own `homeHealth('sandbox')` panel (`:184-187`). Design's own
      // fixed line there has no room for the backend's own free-text `health.detail` — kept out
      // of the visible `detail` (which stays the design's exact wording) but logged, not
      // silently discarded (errore rule 21).
      console.warn(
        `agent-health: ${backendId} reported sandbox-degraded — backend detail: ${health.detail}`,
      );
      return {
        kind: "advisory",
        agent: backendId,
        panel: "sandbox",
        detail: `sandbox unavailable — ${backendId} runs unconfined`,
      };
  }
}

/** A rejected `healthCheck()` call — a spawn/probe fault, not a reported `AgentHealthState`. */
export class AgentHealthProbeError extends errore.createTaggedError({
  name: "AgentHealthProbeError",
  message: "$backendId health probe rejected: $reason",
}) {}

/**
 * The agent/model/effort triple Home's combo selectors read. A SELECTION fact, not a HEALTH fact
 * — `AgentBackend.healthCheck()` reports none of it. Split out of the probe (fix-bundle §3.2,
 * finding §2.7): `capabilities()` is synchronous on both port definitions and, for Claude, a plain
 * object literal with no I/O at all, so riding it on `healthCheck()`'s promise made Home wait up to
 * `DEFAULT_PROBE_DEADLINE_MS` (20 s) for a value that was available at construction.
 */
export interface HomeAgentSelection {
  readonly agent: string;
  readonly model: string;
  readonly effort: string;
}

/**
 * The sole registered backend's declared default. `null` for demo mode (no registry) or an empty
 * catalog — the honest absence, never a duplicated literal: restating `claude-sonnet-5`/`high`
 * inside `ui` or `entrypoint` would let it drift from the catalog that actually resolves a turn.
 */
export function resolveDefaultAgentSelection(
  registry: AgentRegistry | null,
): HomeAgentSelection | null {
  if (registry === null) return null;
  const [sole] = registry.list();
  if (sole === undefined) return null;
  return {
    agent: sole.backendId,
    model: sole.defaultSelection.model,
    effort: sole.defaultSelection.effort,
  };
}

/**
 * Builds the real Home health probe around one live `AgentBackend` (phase-8 Task 9 / WP-5) —
 * the value `UiRootOptions.agentHealthProbe` / `UiDeps.refreshHomeHealth` actually calls.
 *
 * Returns HEALTH ONLY (phase-8 Task 13, finding §2.7): is the CLI there, logged in, healthy?
 * Mapped through {@link homeHealthFromAgentInfo}. It used to also fold in
 * `capabilities().defaultSelection` — a SEPARATE, synchronous fact with no I/O at all — which
 * meant Home's `agent ‹…› model ‹…› effort ‹…›` combo waited behind this probe's real cold
 * spawn (up to `DEFAULT_PROBE_DEADLINE_MS`, 20 s) for a value that was available at
 * construction. {@link resolveDefaultAgentSelection} now delivers that fact synchronously,
 * straight from the composition root into `UiRootOptions.agentSelection` — it never rides this
 * probe's promise again.
 *
 * A REJECTED `healthCheck()` (the promise itself rejects — a spawn/probe fault, not a reported
 * `AgentHealthState`) becomes `advisory`/`shutdown`, never `blocked` — the errore boundary rule
 * (`.catch()` into a tagged domain error with `cause`) plus rule 21 (an error that is not
 * propagated past this probe must still be logged). A spawn fault is UNPROVEN, not proof of a
 * signed-out user (finding §2.7): the old `present: false` mapping made the same over-claim a
 * probe timeout did — see `agent/health/model/probe.ts`'s `inconclusive` for the sibling fix.
 */
export function createAgentHealthProbe(backend: AgentBackend): () => Promise<HomeAgentHealth> {
  return async () => {
    const info = await backend.healthCheck().catch(
      (cause: unknown) =>
        new AgentHealthProbeError({
          backendId: backend.capabilities().backendId,
          reason: cause instanceof Error ? cause.message : "the healthCheck() promise rejected",
          cause,
        }),
    );
    if (info instanceof Error) {
      console.warn(info.message, info.cause);
      return {
        kind: "advisory",
        agent: backend.capabilities().backendId,
        panel: "shutdown",
        detail: info.message,
      };
    }
    return homeHealthFromAgentInfo(info);
  };
}
