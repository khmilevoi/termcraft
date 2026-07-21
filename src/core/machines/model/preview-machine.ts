import { createStateMachine, type StateMachine, type TransitionTable } from "./state-machine"

/**
 * The Preview model (kernel-command-contract §7.6).
 *
 * "Frames do not pass through the control-event stream. The UI consumes a bounded,
 * latest-wins `PreviewSession` frame stream and sends preview intents through Kernel
 * commands. It never starts, kills, or writes to the host subprocess directly." (§7.6)
 * — HostSupervisor, session lifetime, and the frame stream are out of scope here; this
 * file is only the `PreviewState` graph.
 *
 * Two rows in §7.6 both keep `PreviewState` at `"live"` but mean opposite things for
 * `stateRevision`:
 * - `setMode`/`setTweak`/`resize`/`setThemeCapabilities` each mutate authoritative
 *   live-session state (mode, tweak values, geometry, theme capabilities) even though
 *   the `PreviewState` enum itself does not move — so each is modeled as a real
 *   `live -> live` edge WITHOUT `noOp`, and `apply` reports `"changed"` for it.
 * - `forwardInput`/`queryGeometry` are guarded service pass-throughs; §7.6 says they
 *   "do not bump `stateRevision` unless authoritative Kernel state changes" — the
 *   default case this table can express is "did not change it", so both are modeled
 *   `noOp: true`. A caller that determines one DID change authoritative state (e.g. a
 *   geometry query that also updates a bounded request counter the Kernel tracks) is
 *   outside this table's job to represent; that is the owning service's call, not a
 *   second edge this factory could pick between.
 */

export type PreviewState = "disabled" | "idle" | "starting" | "live" | "switching" | "failed" | "circuit-open"

export type PreviewAction =
  | "kernel.preview.enable"
  | "kernel.preview.beginStart"
  | "kernel.preview.beginSwitch"
  | "kernel.preview.sessionReady"
  | "kernel.preview.sessionFailed"
  | "kernel.preview.openCircuit"
  | "kernel.preview.retryCircuit"
  | "kernel.preview.setMode"
  | "kernel.preview.setTweak"
  | "kernel.preview.resize"
  | "kernel.preview.setThemeCapabilities"
  | "kernel.preview.forwardInput"
  | "kernel.preview.queryGeometry"
  | "kernel.preview.disable"

/** Every non-`disabled` state (§7.6: "any open state | kernel.preview.disable | disabled"). */
const OPEN_STATES: readonly PreviewState[] = ["idle", "starting", "live", "switching", "failed", "circuit-open"]

/** §7.6's table, transcribed row for row; a multi-source/multi-action row expands to one edge each. */
export const PREVIEW_TRANSITION_TABLE: TransitionTable<PreviewState, PreviewAction> = {
  "kernel.preview.enable": [{ from: "disabled", to: "idle" }],
  "kernel.preview.beginStart": [
    { from: "idle", to: "starting" },
    { from: "failed", to: "starting" },
  ],
  "kernel.preview.beginSwitch": [
    { from: "live", to: "switching" },
    { from: "failed", to: "switching" },
  ],
  "kernel.preview.sessionReady": [
    { from: "starting", to: "live" },
    { from: "switching", to: "live" },
  ],
  "kernel.preview.sessionFailed": [
    { from: "starting", to: "failed" },
    { from: "switching", to: "failed" },
    { from: "live", to: "failed" },
  ],
  "kernel.preview.openCircuit": [{ from: "failed", to: "circuit-open" }],
  "kernel.preview.retryCircuit": [{ from: "circuit-open", to: "starting" }],
  "kernel.preview.setMode": [{ from: "live", to: "live" }],
  "kernel.preview.setTweak": [{ from: "live", to: "live" }],
  "kernel.preview.resize": [{ from: "live", to: "live" }],
  "kernel.preview.setThemeCapabilities": [{ from: "live", to: "live" }],
  "kernel.preview.forwardInput": [{ from: "live", to: "live", noOp: true }],
  "kernel.preview.queryGeometry": [{ from: "live", to: "live", noOp: true }],
  "kernel.preview.disable": OPEN_STATES.map((from) => ({ from, to: "disabled" as const })),
}

/**
 * Builds one Kernel's Preview model. §11.1: `OPERATION_BUSY` is "The relevant
 * single-operation model is not idle" — Preview is exactly that kind of model, so every
 * unlisted (source, action) pair rejects with it.
 */
export function reatomPreviewStateMachine(): StateMachine<PreviewState, PreviewAction> {
  return createStateMachine<PreviewState, PreviewAction>({
    traceRoot: "kernel.preview",
    initial: "disabled",
    table: PREVIEW_TRANSITION_TABLE,
    illegalCode: "OPERATION_BUSY",
  })
}
