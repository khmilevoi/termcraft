import { log } from "infrastructure/debug-log";

import type { HostSessionSpec, InteractionMode, PreviewIdentity, Size } from "../../types";
import type { FrameCoordinates, GeometryQuery, HostSessionDeps, PreviewSession } from "../types";
import { createHostSession } from "./session";

/**
 * The UI-facing `PreviewSession` facade subset (host-supervision §3.2) over a SINGLE
 * incarnation: a stable identity without the nonce, the capacity-1 frame stream, and
 * typed `resize`/`setMode`/`query` adapters over that one `HostSession`'s correlated
 * request senders. `setMode` follows §7: the effective interaction mode changes ONLY on
 * an accepted response echoing the requested mode. `retry` is a stub — there is no
 * restart/backoff/circuit to act on here, by design.
 *
 * BLOCKER B4 DECISION (phase 6 slice 6D): this file used to note that both `PreviewHandle`
 * (crash-loop-safe, no resize/setMode/query) and this richer single-incarnation facade
 * existed "with no core yet to choose between them." Phase 6 chooses the shape below —
 * `PreviewSession` (host-supervision §3.2: identity, mode, interactionMode, frames, resize,
 * setMode, query, retry, close) — as what `HostSupervisor.preview()` returns. The
 * composition lives in `supervisor.ts`'s `sessionFor`, NOT here: this function still owns
 * and starts exactly ONE `HostSession` with no restart, so it is not reused directly by the
 * supervisor (which must rebind `resize`/`setMode`/`query` to whichever incarnation is
 * currently live across automatic restarts). `supervisor.ts` follows the SAME
 * interactionMode-tracking and resize/setMode/query-delegation pattern demonstrated here,
 * driven by its own per-key `KeyState` instead of a single fixed `session`. Deferred facade
 * methods (forwardInput, setTheme, setCapabilities, tweaks) remain intentionally absent from
 * both.
 */
export function createPreviewSession(spec: HostSessionSpec, deps: HostSessionDeps): PreviewSession {
  const session = createHostSession(spec, deps);
  const mode: "preview" | "historical" = spec.mode === "historical" ? "historical" : "preview";
  let interactionMode: InteractionMode = spec.interactionMode;

  // Kick off the incarnation. The pump publishes frames to the broker as they arrive.
  // On success the facade adopts the ACCEPTED ready response's effective interactionMode
  // (§6.6/§7 — response-driven, not the requested spec value; the host may downgrade it).
  // On failure the frames iterator is already ended by teardown (broker.close), and the
  // error is surfaced via onFatal — or logged if no sink is injected (never swallowed).
  void session.start().then((outcome) => {
    if (outcome instanceof Error) {
      if (deps.onFatal) deps.onFatal(outcome);
      else log.warn("preview-session: startup failed:", outcome.message);
      return;
    }
    const echoed = outcome.ready.body.interactionMode;
    if (echoed === "static" || echoed === "interactive") interactionMode = echoed;
  });

  return {
    get identity(): PreviewIdentity {
      const { nonce: _nonce, ...rest } = session.identity;
      return rest;
    },
    get mode() {
      return mode;
    },
    get interactionMode() {
      return interactionMode;
    },
    frames: session.frames,
    resize(size: Size) {
      // Fire-and-forget dispatch; the response is diagnostic-only in 2D-2 (no queue/
      // backpressure surface until 2D-3) but a dropped error is LOGGED, never swallowed.
      void session.resize(size).then((result) => {
        if (result instanceof Error) log.warn("preview-session: resize failed:", result.message);
      });
    },
    setMode(next: InteractionMode) {
      void session.setMode(next).then((result) => {
        if (result instanceof Error) {
          log.warn("preview-session: set-mode failed:", result.message); // rejection/timeout/stale preserves the prior mode (§7)
          return;
        }
        if (result.body.interactionMode === next) interactionMode = next;
      });
    },
    query(frame: FrameCoordinates, query: GeometryQuery) {
      // The caller named the frame with the only two fields it can see; the incarnation half
      // is completed here, from THIS session's live identity (see `FrameCoordinates`' doc).
      return session.query(
        {
          sessionId: session.identity.sessionId,
          nonce: session.identity.nonce,
          sourceHash: frame.sourceHash,
          frameSeq: frame.frameSeq,
        },
        query,
      );
    },
    retry() {
      // 2D-2 stub — the restart budget/circuit that acts on this lands in 2D-3.
    },
    async close() {
      await session.stop();
    },
  };
}
