/**
 * `ui/home` — the Home screen (design `home()`/`homeErr()`, `design/01-home.dc.html`,
 * chrome-map "SURFACE: Home"). Home is only ever shown before `.termcraft/` exists; an
 * existing project opens straight into Workspace. No chat/preview split, no tab strip.
 */

/** The mirrored codex-agent health check Home renders (idle detail vs. missing-agent error). */
export interface HomeAgentHealth {
  readonly present: boolean;
  /** e.g. "0.34" */
  readonly version?: string | null;
  /** e.g. "agent ready" (idle) or "codex CLI not found" (error) */
  readonly detail: string;
  /** e.g. "codex" */
  readonly agent?: string;
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
