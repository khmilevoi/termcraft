import type { HostSessionSpec, InteractionMode, PreviewFrame, PreviewIdentity, Size } from "../../types"
import type { HostSessionDeps, PreviewSession } from "../types"
import { createHostSession } from "./session"

/**
 * The UI-facing `PreviewSession` facade subset (host-supervision §3.2). It owns a
 * HostSession (which owns the broker + request table + watchdog) and exposes only
 * what the 2C child supports today: a stable identity without the nonce, the
 * capacity-1 frame stream, and typed `resize`/`setMode` adapters over the session's
 * correlated request senders. `setMode` follows §7: the effective interaction mode
 * changes ONLY on an accepted response echoing the requested mode. `retry` is a
 * 2D-2 stub; real restart lands in 2D-3. Deferred facade methods (forwardInput,
 * setTheme, setCapabilities, geometry query, tweaks) are intentionally absent.
 */
export function createPreviewSession(spec: HostSessionSpec, deps: HostSessionDeps): PreviewSession {
  const session = createHostSession(spec, deps)
  const mode: "preview" | "historical" = spec.mode === "historical" ? "historical" : "preview"
  let interactionMode: InteractionMode = spec.interactionMode

  // Kick off the incarnation. The pump publishes frames to the broker as they arrive.
  // On success the facade adopts the ACCEPTED ready response's effective interactionMode
  // (§6.6/§7 — response-driven, not the requested spec value; the host may downgrade it).
  // On failure the frames iterator is already ended by teardown (broker.close), and the
  // error is surfaced via onFatal — or logged if no sink is injected (never swallowed).
  void session.start().then((outcome) => {
    if (outcome instanceof Error) {
      if (deps.onFatal) deps.onFatal(outcome)
      else console.warn("preview-session: startup failed:", outcome.message)
      return
    }
    const echoed = outcome.ready.body.interactionMode
    if (echoed === "static" || echoed === "interactive") interactionMode = echoed
  })

  return {
    get identity(): PreviewIdentity {
      const { nonce: _nonce, ...rest } = session.identity
      return rest
    },
    get mode() {
      return mode
    },
    get interactionMode() {
      return interactionMode
    },
    frames: session.frames,
    resize(size: Size) {
      // Fire-and-forget dispatch; the response is diagnostic-only in 2D-2 (no queue/
      // backpressure surface until 2D-3) but a dropped error is LOGGED, never swallowed.
      void session.resize(size).then((result) => {
        if (result instanceof Error) console.warn("preview-session: resize failed:", result.message)
      })
    },
    setMode(next: InteractionMode) {
      void session.setMode(next).then((result) => {
        if (result instanceof Error) {
          console.warn("preview-session: set-mode failed:", result.message) // rejection/timeout/stale preserves the prior mode (§7)
          return
        }
        if (result.body.interactionMode === next) interactionMode = next
      })
    },
    retry() {
      // 2D-2 stub — the restart budget/circuit that acts on this lands in 2D-3.
    },
    async close() {
      await session.stop()
    },
  }
}
