import { type Computed, computed } from "@reatom/core";

import type { UUIDv7 } from "core/protocol";

import type { ProjectMirror, ScreenKind } from "../types";

/**
 * The app's minimum frame (design §9 / chrome-map "enlarge-window" placeholder). Below this
 * on either axis, the enlarge placeholder takes over the whole terminal.
 */
export const MIN_FRAME = { w: 80, h: 24 } as const;

export interface ScreenInput {
  readonly projectId: UUIDv7 | null;
  readonly trust: "trusted" | "untrusted-read-only" | null;
  readonly terminal: Readonly<{ w: number; h: number }>;
  /**
   * Whether the composition root is going to open a project for this run and has not yet been
   * told otherwise (`UiLocalState.startupOpenPending`). Its DESTINATION is the Workspace, so the
   * Workspace mounts now and fills when `finishOpen` lands, instead of parking on Home for the
   * whole ready sequence.
   */
  readonly startupOpenPending: boolean;
  /** `mirror.project().openFailure !== null` — a blocked open falls back to Home, which owns the
   *  failure panel and the ⏎ retry. */
  readonly openFailed: boolean;
}

/**
 * Derives which screen the app root mounts (phase-7 plan D6, revised 2026-08-02 by the
 * workspace-first launch spec).
 *
 * APPROXIMATION (documented): `trust === null` with a project open maps to `trust-prompt`,
 * conflating the true needs-trust state with the brief pre-`ready` opening/recovering window
 * (snapshot `trust` is null throughout both). It stays exactly as unreachable as it was:
 * `kernel.project.finishOpen` folds `projectId` and `trust` in one `project.set`
 * (`ui/mirror/model/mirror.ts:400`), so there is no intermediate state where one is known and
 * the other is not.
 *
 * THE "OPENING" STATE IS NOT A NEW `ScreenKind`. It is `"workspace"` with `projectId === null`,
 * which is why the transition to a filled Workspace is a re-render rather than a remount, and why
 * only `ui/workspace` needs to know the difference.
 */
export function deriveScreen(input: ScreenInput): ScreenKind {
  // Below the minimum frame the enlarge placeholder replaces everything (design §9).
  if (input.terminal.w < MIN_FRAME.w || input.terminal.h < MIN_FRAME.h) return "enlarge";
  if (input.projectId === null) {
    // An existing project's destination IS the Workspace — mount it now and let it fill,
    // rather than parking on Home for the whole ready sequence. A blocked open drops back
    // to Home, which owns the failure panel and the ⏎ retry.
    if (input.startupOpenPending && !input.openFailed) return "workspace";
    return "home";
  }
  if (input.trust === "untrusted-read-only") return "read-only";
  if (input.trust === null) return "trust-prompt";
  return "workspace";
}

/**
 * A reactive `ScreenKind` computed over the project slice, the UI-local terminal size, and the
 * UI-local startup-open flag. Neither the terminal size nor the flag is a mirror atom — one is a
 * render-time value and the other is an environment fact the composition root knows before the
 * Kernel exists — so the App injects both readers here.
 */
export function createScreenAtom(deps: {
  readonly project: () => ProjectMirror;
  readonly terminal: () => Readonly<{ w: number; h: number }>;
  readonly startupOpenPending: () => boolean;
}): Computed<ScreenKind> {
  return computed(() => {
    const project = deps.project();
    return deriveScreen({
      projectId: project.projectId,
      trust: project.trust,
      terminal: deps.terminal(),
      startupOpenPending: deps.startupOpenPending(),
      // `createScreenAtom` already holds `() => mirror.project()`, so this needs no new wiring.
      openFailed: project.openFailure !== null,
    });
  }, "ui.mirror.screen");
}
