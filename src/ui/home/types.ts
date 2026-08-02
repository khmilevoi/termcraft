import type { ScoredSlashRow } from "ui/actions";
import type { AgentHealth } from "ui/agent-health";
import type { ProjectOpenFailure } from "ui/mirror";

/**
 * `ui/home` — the Home screen (design `home()`/`homeErr()`, `design/01-home.dc.html`,
 * chrome-map "SURFACE: Home"). NARROWED (workspace-first launch, 2026-08-02): Home is now
 * reached in exactly two situations — a genuinely fresh directory, and a startup open that
 * failed. An existing project mounts the Workspace immediately and fills there
 * (`design/30-workspace-first-launch.dc.html`). {@link HomeProps.openFailure} is what makes the
 * second case legible instead of silent. No chat/preview split, no tab strip.
 */

/** Submit is refused exactly while the agent is unproven-and-unusable — see {@link AgentHealth}.
 *  Stays in `ui/home` on purpose: this is HOME's submit policy. The Workspace composer is
 *  deliberately not gated on health — a dead CLI does not disable ⏎ there. */
export function homeSubmitAllowed(health: AgentHealth): boolean {
  return health.kind === "ready" || health.kind === "advisory";
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
  readonly health: AgentHealth;
  /** Current prompt text (empty string shows the placeholder). */
  readonly prompt: string;
  readonly combo: HomeCombo;
  /**
   * The Home-scoped slash rows to render below the prompt box (§3.10, phase-8 Task 17), already
   * filtered+scored by the caller via `filterSlashRows(prompt, actionContext)`. Empty whenever the
   * slash menu is not open, matching `ui/workspace`'s own `slashOpen ? filterSlashRows(...) : []`
   * convention (`Workspace.tsx`) — never derived inside this component, which is a plain function
   * with no Reatom access of its own, not a `reatomComponent`.
   */
  readonly rows: readonly ScoredSlashRow[];
  /** Index of the highlighted row within {@link rows} (caller lands it on the first enabled row). */
  readonly selectedIndex: number;
  /**
   * Why the project on disk failed to open, when one did — `ProjectMirror.openFailure`, straight
   * through. `null` is the ordinary case (nothing has failed to open). Independent of
   * {@link HomeProps.health}: the agent can be perfectly healthy and the project still unopenable,
   * and both panels render together when both apply.
   */
  readonly openFailure: ProjectOpenFailure | null;
  /**
   * Whether a `project.create`/`project.open` is in flight (`ProjectMirror.opening`). Home stays
   * mounted throughout — `deriveScreen` only leaves it once `finishOpen`'s metadata lands — so
   * this is what stops the screen claiming "no project yet" over a project that is actively
   * loading, and what makes the refused Enter visible before it is pressed.
   */
  readonly opening: boolean;
}
