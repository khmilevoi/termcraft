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
 * Pure map from one `AgentBackend.healthCheck()` reading to Home's `HomeAgentHealth`.
 * Exhaustive over every `AgentHealthState` variant (`agent/types.ts`, mirrored verbatim at
 * `core/ports/agent-backend.ts`) via a `switch` with no `default` arm — TypeScript's own
 * control-flow analysis makes a sixth variant added later a `tsc` failure here, not a silent
 * "ready".
 *
 * `HomeAgentHealth` carries no `version` field (phase-8 Task 13 removed it): `AgentInfo` never
 * had one to report (only `backendId`, `health`, `account` — `agent/types.ts`), so the field
 * was always a fabrication risk this map used to paper over by hardcoding `null` — dropping it
 * from the type is the honest fix, not a placeholder this function still needs to supply.
 *
 * Wording sources: `design/01-home.dc.html`'s `home()`/`homeErr()`
 * (`design/termcraft-engine.js:143` and `:576`) supply verbatim text for exactly two of these
 * five states — "agent ready" (idle) and "{agent} CLI not found" (not-installed). The other
 * three states have no design mock at all (the design predates the not-logged-in /
 * unconfirmed-exit / sandbox-degraded distinctions this port actually reports), so their
 * `detail` text is this module's own honest wording — documented per branch below, never
 * silently invented.
 */
export function homeHealthFromAgentInfo(info: AgentInfo): HomeAgentHealth {
  const { backendId, health } = info;
  switch (health.status) {
    case "ready":
      // Verbatim design wording — design/termcraft-engine.js:143 (`home()`'s health line:
      // "● codex 0.34 · agent ready").
      return { present: true, agent: backendId, detail: "agent ready" };

    case "not-installed":
      // Verbatim design wording pattern — design/termcraft-engine.js:576 (`homeErr()`:
      // "✗ codex CLI not found"). The ✗ glyph is static UI chrome `Home.tsx` prefixes onto
      // this `detail` string, not part of the domain value itself.
      return { present: false, agent: backendId, detail: `${backendId} CLI not found` };

    case "not-logged-in":
      // DIVERGENCE: no design mock distinguishes "found but not logged in" from "not found
      // at all" — design/01-home.dc.html's homeErr() only ever shows the CLI-absent case.
      // Honest, undesigned wording, parallel in shape to the not-installed branch above.
      return {
        present: false,
        agent: backendId,
        detail: `${backendId} CLI found but not logged in`,
      };

    case "unhealthy-unconfirmed-exit":
      // DIVERGENCE: also no design mock — this is the "inconclusive probe" outcome design
      // §WP-5 names but does not mock. Wording echoes the reasoning already logged at
      // `agent/run/model/unconfirmed-exit-latch.ts` ("run exited unconfirmed; latching this
      // backend unhealthy until it is restarted").
      return {
        present: false,
        agent: backendId,
        detail: `${backendId} exited without confirming shutdown; locked out until restarted`,
      };

    case "sandbox-degraded":
      // DIVERGENCE: Codex-only, never reported for the Claude backend MVP ships (this
      // variant's own doc comment on `AgentHealthState`) — unreachable today, still handled
      // honestly for exhaustiveness. Master spec §9 treats a degraded sandbox as the CLI
      // still being present and usable, just under a weaker confinement guarantee, not as
      // "missing" — unlike the three branches above, so `present` stays `true` here and the
      // caveat rides in `detail`, which folds in the backend's own message rather than
      // inventing one.
      return {
        present: true,
        agent: backendId,
        detail: `${backendId} sandbox degraded: ${health.detail}`,
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
 * `AgentHealthState`) becomes an honest not-present reading carrying the failure's own message
 * as `detail`, never a fabricated "ready" — the errore boundary rule (`.catch()` into a tagged
 * domain error with `cause`) plus rule 21 (an error that is not propagated past this probe must
 * still be logged).
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
        present: false,
        agent: backend.capabilities().backendId,
        detail: info.message,
      };
    }
    return homeHealthFromAgentInfo(info);
  };
}
