/**
 * `ui/home` — the Home screen (design `home()`/`homeErr()`, `design/01-home.dc.html`,
 * chrome-map "SURFACE: Home"). Home is only ever shown before `.termcraft/` exists; an
 * existing project opens straight into Workspace. No chat/preview split, no tab strip.
 */

/** The mirrored agent health check Home renders (idle detail vs. missing-agent error). */
export interface HomeAgentHealth {
  readonly present: boolean;
  /** e.g. "agent ready" (idle) or "claude CLI not found" (error) */
  readonly detail: string;
  /** The backend id (M22), e.g. "claude" — sourced from the same probe as `detail`. */
  readonly agent?: string;
}

/**
 * The agent/model/effort triple Home's combo selectors read (finding §2.7, phase-8 Task 13). A
 * synchronous fact the composition root resolves off the agent registry at construction
 * (`entrypoint/model/agent-health.ts`'s own `HomeAgentSelection`) — mirrored here, not
 * imported: `ui` never imports `entrypoint` (code-structure.md's DAG has the composition root
 * importing every module, never the reverse), so the two declarations are kept structurally
 * identical by convention, the same "verbatim lift" pattern `core/ports/agent-backend.ts`
 * already uses for `agent/types.ts`. `HomeCombo` below is the always-concrete render-ready
 * triple this feeds; `HomeAgentSelection | null` is the honest upstream fact — `null` only when
 * the registry could not name a default (no registry, or an empty catalog), never a fabricated
 * identity.
 */
export interface HomeAgentSelection {
  readonly agent: string;
  readonly model: string;
  readonly effort: string;
}

/** The inline agent/model/effort combo selectors shown under the prompt box. */
export interface HomeCombo {
  readonly agent: string;
  readonly model: string;
  readonly effort: string;
}

/** Props for the `Home` screen component. `id` is the mandatory stable id. */
export interface HomeProps {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly health: HomeAgentHealth;
  /** Current prompt text (empty string shows the placeholder). */
  readonly prompt: string;
  readonly combo: HomeCombo;
}
