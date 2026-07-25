/**
 * `ui/home` — the Home screen (design `home()`/`homeErr()`, `design/01-home.dc.html`,
 * chrome-map "SURFACE: Home"). Home is only ever shown before `.termcraft/` exists; an
 * existing project opens straight into Workspace. No chat/preview split, no tab strip.
 */

/** The mirrored agent health check Home renders (idle detail vs. missing-agent error). */
export interface HomeAgentHealth {
  readonly present: boolean;
  /** e.g. "0.34" */
  readonly version?: string | null;
  /** e.g. "agent ready" (idle) or "claude CLI not found" (error) */
  readonly detail: string;
  /** The backend id (M22), e.g. "claude" — sourced from the same probe as `version`/`detail`. */
  readonly agent?: string;
  /** The model label (M22), e.g. "sonnet-4.5" — same probe, drives the Home combo's model text. */
  readonly model?: string;
  /**
   * The reasoning effort label (phase-8 Task 9 / WP-5), e.g. "high" — drives the Home combo's
   * effort text. Unlike `agent`/`model` this is not something `AgentBackend.healthCheck()`
   * itself reports (it carries no selection data at all); it rides along the SAME probe
   * reading because `entrypoint/model/agent-health.ts`'s `createAgentHealthProbe` folds in
   * `AgentBackend.capabilities().defaultSelection` (WP-4) — a SELECTION fact, not a HEALTH
   * fact, merged here because there is exactly one probe injection point Home has.
   */
  readonly effort?: string;
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
