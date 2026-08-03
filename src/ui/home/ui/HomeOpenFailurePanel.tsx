import type { ProjectOpenFailure } from "ui/mirror";
import { SHELL_PALETTE, shellAttrs } from "ui/theme";

export interface HomeOpenFailurePanelProps {
  readonly id: string;
  readonly width: number;
  readonly failure: ProjectOpenFailure;
}

/**
 * Why the project on disk did not open — rendered on Home below the prompt, beside (never
 * instead of) whatever the agent-health panel is already saying.
 *
 * WHY THIS EXISTS (defect fix, 2026-07-26): `core/kernel/model/handlers/project.ts` funnels
 * nine distinct startup failures through one `blockOpen`, and nothing in `src/ui` consumed it.
 * The user saw an ordinary, healthy-looking Home — while the project machine sat in `blocked`,
 * where `beginOpen`/`beginCreate` are both illegal, so every Enter was rejected
 * `CAPABILITY_UNAVAILABLE` and did nothing at all, silently and permanently. This panel is the
 * "what went wrong"; `ui/app/model/deps.ts`'s blocked-open recovery is the "and here is how you
 * get out of it".
 *
 * TWO FAILURE PATHS, ONE PANEL (branch review finding 2, 2026-08-03). Since `App.tsx` composes
 * `ProjectMirror.openFailure` with `UiLocalState.startupOpenFailure` into the single prop below,
 * this panel also explains the OTHER way an open ends on Home: the composition root's startup
 * `project.open` (`entrypoint/model/run-app.ts`) failing to dispatch or being rejected outright.
 * That path never reaches the Kernel's `blocked` state, so its `reason`/`safeMessage` are built by
 * `run-app.ts` from what it actually knows rather than folded from a `blockOpen` — the shape is
 * identical, the provenance is not, and nothing about that is visible here BY DESIGN: the user is
 * being told why their project did not open, and both readings answer exactly that.
 *
 * DIVERGENCE, closest faithful mapping (CLAUDE.md: flag the gap, never guess a value). The
 * design has no screen for a project that fails to open — `design/12-errors-edge-states.dc.html`
 * enumerates its honest failure surface as "missing agent ..., the schema-retry loop, a
 * cancelled turn, a canonical-source that fails Gate ..., plus the two full-screen refusals:
 * terminal-too-small and second-instance lock", and none of those is this. What IS design's own
 * is the SHAPE reused here verbatim: `homeErr()`'s red-bordered box with a red bold `✗`
 * headline followed by explanation lines (`design/termcraft-engine.js:716-727`), already
 * transcribed into this flexbox layout by the sibling `HomeHealthPanel`. Nothing about the
 * failure itself is invented — the second line is the reading's own `safeMessage`, the title
 * carries its own `reason` slug, and neither is reworded here.
 */
export function HomeOpenFailurePanel(props: HomeOpenFailurePanelProps) {
  const P = SHELL_PALETTE;
  return (
    <box
      id={props.id}
      width={props.width}
      border
      borderStyle="rounded"
      borderColor={P.red}
      title={`project · ${props.failure.reason}`}
      titleColor={P.red}
      flexDirection="column"
      padding={0}
    >
      <text id={`${props.id}-line-1`} fg={P.red} attributes={shellAttrs({ bold: true })}>
        {"✗ this folder's project could not be opened"}
      </text>
      {/* The failure's own `safeMessage`, verbatim — the Kernel's `FailureDtoV1.safeMessage` for a
          blocked open, `run-app.ts`'s own account for a startup dispatch that was never admitted.
          The one line that says what actually went wrong either way, so it is never paraphrased or
          truncated here. */}
      <text id={`${props.id}-line-2`} fg={P.dim}>
        {props.failure.safeMessage}
      </text>
      {/* Honest because the recovery below really does restore it: `deps.ts` closes the blocked
          project, which walks the machine back to `closed`, where `project.open` — exactly what
          Home's Enter dispatches for an existing project — is legal again. */}
      <text id={`${props.id}-line-3`} fg={P.faint}>
        {"⏎ retries the open once you have fixed it"}
      </text>
    </box>
  );
}
