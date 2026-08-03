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
   * Whether the composition root is going to open a project it already knows is on disk
   * (`UiEnv.projectExists`, itself `ShellLaunchV1.existing`), and that open is still
   * outstanding — neither abandoned nor already landed (`UiLocalState.startupOpenPending` in
   * `ui/app/model/deps.ts` clears it either way). Deliberately NOT `ProjectMirror.opening`: that
   * only turns true once the command is admitted, so between UI mount and admission `projectId`
   * is null and `opening` is false — Home would flash for a frame. The composition root knows
   * this synchronously, before the UI mounts; that fact is the input.
   */
  readonly startupOpenPending: boolean;
  /** `ProjectMirror.openFailure !== null` — a blocked open, which Home owns. */
  readonly openFailed: boolean;
}

/**
 * Derives which screen the app root mounts (phase-7 plan D6). Until the typed
 * `kernel.snapshot.models` lands, this reads the signals that DO exist — terminal size,
 * `projectId`, and `trust` — rather than a machine tag.
 *
 * APPROXIMATION (documented): `trust === null` with a project open maps to `trust-prompt`,
 * conflating the true needs-trust state with the brief pre-`ready` opening/recovering window
 * (snapshot `trust` is null throughout both). When the typed snapshot lands the derivation
 * tightens to the project machine's own phase without changing this screen set.
 *
 * The `projectId === null` + `startupOpenPending` case is the Workspace's "opening" state — NOT a
 * new `ScreenKind`, which is why the transition to a filled Workspace is a re-render rather than
 * a remount.
 */
export function deriveScreen(input: ScreenInput): ScreenKind {
  // Below the minimum frame the enlarge placeholder replaces everything (design §9).
  if (input.terminal.w < MIN_FRAME.w || input.terminal.h < MIN_FRAME.h) return "enlarge";
  if (input.projectId === null) {
    // An existing project's destination IS the Workspace — mount it now and let it fill,
    // rather than parking on Home for the whole ready sequence (up to ~30s,
    // `docs/architecture/flows/launch.md`). A blocked open drops back to Home, which owns
    // `HomeOpenFailurePanel` and the ⏎ retry.
    if (input.startupOpenPending && !input.openFailed) return "workspace";
    return "home";
  }
  if (input.trust === "untrusted-read-only") return "read-only";
  if (input.trust === null) return "trust-prompt";
  return "workspace";
}

/**
 * A reactive `ScreenKind` computed over the project slice and the UI-local terminal size.
 * Terminal size is deliberately NOT a mirror atom — it is a render-time value, not Kernel
 * state — so the App injects its reader here.
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
      openFailed: project.openFailure !== null,
    });
  }, "ui.mirror.screen");
}
