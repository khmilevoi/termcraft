import type { ScoredSlashRow } from "ui/actions";
import type { AgentHealth } from "ui/agent-health";
import type { ProjectOpenFailure } from "ui/mirror";

/**
 * `ui/home` — the Home screen (design `home()`/`homeErr()`, `design/01-home.dc.html`,
 * chrome-map "SURFACE: Home"). Normally shown only before `.termcraft/` exists; an existing
 * project opens straight into Workspace (Gap D). CORRECTED: that is not the ONLY way Home is
 * reached with a project on disk — an open that ends in the project machine's `blocked` state
 * leaves `projectId` null, so `deriveScreen` holds Home over a folder that does have a project.
 * {@link HomeProps.openFailure} is what makes that case legible instead of silent. No
 * chat/preview split, no tab strip.
 */

/** Submit is refused exactly while the agent is unproven-and-unusable — see {@link AgentHealth}. */
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
   * Why the project on disk failed to open, when one did. `null` is the ordinary case (nothing
   * has failed to open). Independent of {@link HomeProps.health}: the agent can be perfectly
   * healthy and the project still unopenable, and both panels render together when both apply.
   *
   * TWO SOURCES reach this one prop, composed by `App.tsx` (branch review finding 2, 2026-08-03):
   * `ProjectMirror.openFailure` — Kernel truth, folded only from a real `kernel.project.blockOpen`
   * — and `UiLocalState.startupOpenFailure`, the UI's own reading of a startup `project.open` that
   * was never admitted at all, so no `blockOpen` could ever exist for it. Home neither knows nor
   * needs to know which one it got: both are a `ProjectOpenFailure` describing the same user-facing
   * event, and they are mutually exclusive per open attempt.
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
