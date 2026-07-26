import { wrap } from "@reatom/core";
import * as errore from "errore";

import type { PreviewAction, PreviewState, StateMachine } from "core/machines";
import type {
  HostSessionSpecV1,
  HostSupervisorPort,
  InteractionModeV1,
  PreviewFrameV1,
  PreviewGeometryQueryResultV1,
  PreviewSession,
  TerminalCapabilitiesV1,
} from "core/ports";
import type {
  CommandPayloadByKindV1,
  FailureDtoV1,
  FrameIdentityV1,
  FrameTokenV1,
  GeometryTokenV1,
  UnavailableReason,
} from "core/protocol";
import type { Size } from "entities/page";
import { uuidv7 } from "infrastructure/uuid";

import type { PreviewBackpressure } from "./backpressure";
import type { FrameBroker } from "./frame-broker";
import type { FrameAckError, FrameTokenLedger } from "./frame-token-ledger";
import type { GeometryTokenLedger } from "./geometry-token-ledger";

/**
 * `createPreviewSessionCommands` (kernel-command-contract §7.6, §8.1-§8.2, §12.5-§12.6):
 * the thin routing layer between `preview.*` Kernel commands, the landed `PreviewState`
 * machine (`core/machines/model/preview-machine.ts`), and the narrowed `PreviewSession`/
 * `HostSupervisorPort` ports. It also ties the frame/geometry token chain together for
 * real use: §8.1's "For each frame-stream item, the Kernel mints a `FrameTokenV1`" is
 * `publishFrame`; the UI's typed display acknowledgement (§8.1) is `acknowledgeDisplay`;
 * `queryGeometry` is where §12.6 items 5-6 actually run — "verifies that frame token
 * before any host request" (BEFORE calling `PreviewSession.query`, never after), and mints
 * a `GeometryTokenV1` only for a resolving `hit`/`pin-anchor` result.
 *
 * NAMED GAP: `FrameIdentityV1.nonce` (host-supervision §3.2's per-incarnation nonce) has no
 * source anywhere in this slice's narrowed ports — `PreviewIdentityV1` deliberately excludes
 * it ("the facade's stable identity ... MINUS the volatile nonce"), and neither
 * `SupervisorEventV1` nor `PreviewFrameV1` carries one either. Until a later slice threads a
 * real host-incarnation nonce through the port boundary, this module mints its own
 * replacement nonce (and its own UUIDv7 `previewSessionId` — kernel-command-contract §7.6:
 * "Each start/switch mints a UUIDv7 `previewSessionId`", independent of whatever internal
 * id the host adapter happens to use) once per successfully established session, exactly
 * where the real host nonce will eventually need to be plumbed in. This is the closest
 * faithful mapping available today, not a silent substitution — see this file's own
 * `mintHostNonce`.
 *
 * Every port call is `await wrap(...)`-ed, matching `admission.ts`'s own rule: code
 * after each await calls `deps.machine.apply` (a Reatom write), and a plain unwrapped
 * `await` would resume outside the caller's `context.start(...)` frame.
 *
 * kernel-assembly Task 16 finding: `selectPage`/`selectCurrent`/`selectHistorical`/`close`
 * above are NOT currently reachable in production — `handlers/preview-export.ts` drives
 * session establishment/teardown directly against `HandlerContext.setActivePreviewSession`
 * instead (Gap A). `publishFrame`/`acknowledgeDisplay` remain the real, tested frame-token
 * authority regardless; `noteSessionEstablished`/`noteSessionClosed` (bottom of this file)
 * are the external hooks `kernel.ts` uses to keep this module's own incarnation identity in
 * step with whichever path actually set the session, so those two methods stay genuinely
 * reachable even while Gap A is open.
 */

/** §8.2/§10.1's closed geometry-query-body union, reused directly rather than redeclared. */
export type GeometryQueryV1 = CommandPayloadByKindV1["preview.queryGeometry"]["query"];

/** host-supervision §8: "Outstanding request table | 64 requests | Reject before send with `TOO_MANY_REQUESTS`." */
export const MAX_OUTSTANDING_GEOMETRY_REQUESTS = 64;

export type PreviewCommandOutcomeV1 =
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected"; readonly reason: UnavailableReason }
  | { readonly kind: "failed"; readonly failure: FailureDtoV1 };

export type PreviewQueryOutcomeV1 =
  | {
      readonly kind: "resolved";
      readonly result: PreviewGeometryQueryResultV1;
      readonly geometryToken: GeometryTokenV1 | null;
    }
  | { readonly kind: "rejected"; readonly reason: UnavailableReason }
  | { readonly kind: "failed"; readonly failure: FailureDtoV1 };

/** A caller invoked `publishFrame`/`queryGeometry` with no live session established yet. */
export class PreviewNoLiveSessionError extends errore.createTaggedError({
  name: "PreviewNoLiveSessionError",
  message: "preview session-commands: $reason",
}) {}

export interface SessionCommandsDeps {
  readonly machine: StateMachine<PreviewState, PreviewAction>;
  readonly hostSupervisor: HostSupervisorPort;
  readonly frameBroker: FrameBroker;
  readonly frameTokenLedger: FrameTokenLedger;
  readonly geometryTokenLedger: GeometryTokenLedger;
  readonly backpressure: PreviewBackpressure;
}

export interface PreviewSessionCommands {
  readonly selectPage: (spec: HostSessionSpecV1) => Promise<PreviewCommandOutcomeV1>;
  readonly selectCurrent: (spec: HostSessionSpecV1) => Promise<PreviewCommandOutcomeV1>;
  readonly selectHistorical: (spec: HostSessionSpecV1) => Promise<PreviewCommandOutcomeV1>;
  readonly resize: (size: Size) => Promise<PreviewCommandOutcomeV1>;
  readonly setMode: (mode: InteractionModeV1) => Promise<PreviewCommandOutcomeV1>;
  readonly setThemeCapabilities: (
    theme: string,
    capabilities: TerminalCapabilitiesV1,
  ) => Promise<PreviewCommandOutcomeV1>;
  readonly retry: () => Promise<PreviewCommandOutcomeV1>;
  readonly close: () => Promise<PreviewCommandOutcomeV1>;
  readonly queryGeometry: (
    frameToken: FrameTokenV1,
    query: GeometryQueryV1,
  ) => Promise<PreviewQueryOutcomeV1>;
  /** Publishes one frame-stream item and mints its `FrameTokenV1` "beside the frame" (§8.1). */
  readonly publishFrame: (frame: PreviewFrameV1) => PreviewNoLiveSessionError | FrameTokenV1;
  /** The UI's typed display acknowledgement (§8.1) — not a Kernel command, see `frame-token-ledger.ts`. */
  readonly acknowledgeDisplay: (frameToken: FrameTokenV1) => FrameAckError | FrameIdentityV1;
  readonly currentPreviewSessionId: () => string | null;
  /**
   * The Kernel-tracked live `PreviewSession` itself, for the ONE caller that needs it
   * outside this module: `handlers/preview-export.ts`'s `handleRetry`, after a successful
   * `retry()` call, to feed `HandlerContext.setActivePreviewSession` (fix round 1, Finding
   * 2) — `retry()`'s own `PreviewCommandOutcomeV1` reports only accepted/rejected/failed,
   * never the session object, mirroring `selectPage`/`selectCurrent`'s own return shape
   * (see `handlers/preview-export.ts`'s file header, "ONE NARROWER GAP", for the identical
   * reasoning on the `selectPage`/`selectCurrent` path, which still does not use this
   * getter — its OWN session comes from `HostSupervisorPort.preview` directly, so it never
   * needed one). Returns `null` whenever no session is currently tracked (before the first
   * establish, after `close()`, or after a failed `establishSession`).
   */
  readonly currentSession: () => PreviewSession | null;
  /**
   * Marks the Kernel-tracked live session as freshly established from OUTSIDE this
   * module's own `selectSource` (kernel-assembly Task 16 finding): `core/kernel/model/
   * handlers/preview-export.ts`'s `selectCurrentSource`/`handleClose` still drive session
   * establishment/teardown directly against `HandlerContext.setActivePreviewSession`
   * rather than this module's `selectPage`/`selectCurrent`/`selectHistorical`/`close`
   * (Gap A, `handlers/types.ts`'s own `previewSessionCommands` doc comment: "NOT yet
   * called by any currently-wired handler") — so this module's own session-establishing
   * entry points never run in production today. `publishFrame`/`acknowledgeDisplay` are
   * still the real frame-token authority the UI needs regardless of which
   * session-establishment path actually ran, so `core/kernel/model/kernel.ts`'s
   * `setActivePreviewSession` calls this the moment a non-null session lands, seeding the
   * exact same fresh incarnation identity `establishSession` mints for its own
   * (currently unreachable) callers, over the SAME `frameTokenLedger`/`frameBroker`.
   */
  readonly noteSessionEstablished: (session: PreviewSession) => void;
  /** The paired teardown hook — see {@link noteSessionEstablished}'s own comment. */
  readonly noteSessionClosed: () => void;
}

/** A fresh 32-lowercase-hex-char stand-in host nonce (matches `hostNonceSchema`) — see this file's header NAMED GAP. */
function mintHostNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The two non-resolving-anchor query kinds never mint a `GeometryTokenV1` (§8.1: only a resolving `hit`/`pin-anchor` does). */
function mintsGeometryToken(queryKind: GeometryQueryV1["kind"]): boolean {
  return queryKind === "hit" || queryKind === "pin-anchor";
}

/**
 * Every `deps.machine.apply(...)` call in this module drives `reatomPreviewStateMachine()`,
 * whose own config fixes `illegalCode: "OPERATION_BUSY"` (§10.1's own designated code for
 * "the relevant single-operation model is not idle"). `TransitionOutcome`'s `code` field is
 * typed as the wide 31-member `CommandRejectionCode` union (shared by all seven machines),
 * so it does not itself narrow to the one literal this specific machine ever produces —
 * this shared rejection literal is that narrowing, kept in one place rather than repeated
 * at each of this file's `applied.kind === "illegal"` branches.
 */
const OPERATION_BUSY_REJECTION = { kind: "rejected", reason: { code: "OPERATION_BUSY" } } as const;

/** Builds one Kernel's preview session-commands router. A factory: two kernels — or two tests — must never share live-session state. */
export function createPreviewSessionCommands(deps: SessionCommandsDeps): PreviewSessionCommands {
  let currentSession: PreviewSession | null = null;
  let currentPreviewSessionId: string | null = null;
  let currentNonce: string | null = null;
  let lastSpec: HostSessionSpecV1 | null = null;

  /** Reserves one non-coalescible queue slot for the duration of `run`, always releasing it. */
  async function withReservedSlot(
    run: () => Promise<PreviewCommandOutcomeV1>,
  ): Promise<PreviewCommandOutcomeV1> {
    const refusal = deps.backpressure.reserve();
    if (refusal !== undefined) return { kind: "rejected", reason: { code: refusal } };
    const outcome = await run();
    deps.backpressure.release();
    return outcome;
  }

  /** Calls `hostSupervisor.preview`, resolving the machine to `live`/`failed` and (re)seeding a fresh incarnation identity on success. */
  async function establishSession(spec: HostSessionSpecV1): Promise<PreviewCommandOutcomeV1> {
    const outcome = await wrap(deps.hostSupervisor.preview(spec));
    if ("code" in outcome) {
      deps.machine.apply("kernel.preview.sessionFailed");
      currentSession = null;
      return { kind: "failed", failure: outcome };
    }

    currentSession = outcome;
    currentPreviewSessionId = uuidv7();
    currentNonce = mintHostNonce();
    deps.frameBroker.clear();
    deps.frameTokenLedger.invalidateCurrent();
    deps.machine.apply("kernel.preview.sessionReady");
    return { kind: "accepted" };
  }

  async function selectSource(spec: HostSessionSpecV1): Promise<PreviewCommandOutcomeV1> {
    lastSpec = spec;
    const action: PreviewAction =
      deps.machine.phase() === "live" ? "kernel.preview.beginSwitch" : "kernel.preview.beginStart";
    const applied = deps.machine.apply(action);
    if (applied.kind === "illegal") return OPERATION_BUSY_REJECTION;
    return withReservedSlot(() => establishSession(spec));
  }

  async function resize(size: Size): Promise<PreviewCommandOutcomeV1> {
    const applied = deps.machine.apply("kernel.preview.resize");
    if (applied.kind === "illegal") return OPERATION_BUSY_REJECTION;
    const session = currentSession;
    if (session === null) {
      console.warn("preview session-commands: resize reached a live phase with no stored session");
      return { kind: "rejected", reason: { code: "CAPABILITY_UNAVAILABLE" } };
    }
    // Coalescible (host-supervision §8: "coalescible resize ... may continue to replace an
    // already pending value") — it never reserves a non-coalescible queue slot.
    const failure = await wrap(session.resize(size));
    if (failure !== undefined) return { kind: "failed", failure };
    return { kind: "accepted" };
  }

  async function setMode(mode: InteractionModeV1): Promise<PreviewCommandOutcomeV1> {
    const applied = deps.machine.apply("kernel.preview.setMode");
    if (applied.kind === "illegal") return OPERATION_BUSY_REJECTION;
    const session = currentSession;
    if (session === null) {
      console.warn("preview session-commands: setMode reached a live phase with no stored session");
      return { kind: "rejected", reason: { code: "CAPABILITY_UNAVAILABLE" } };
    }
    return withReservedSlot(async () => {
      const failure = await wrap(session.setMode(mode));
      if (failure !== undefined) return { kind: "failed", failure };
      return { kind: "accepted" };
    });
  }

  async function setThemeCapabilities(
    theme: string,
    capabilities: TerminalCapabilitiesV1,
  ): Promise<PreviewCommandOutcomeV1> {
    const applied = deps.machine.apply("kernel.preview.setThemeCapabilities");
    if (applied.kind === "illegal") return OPERATION_BUSY_REJECTION;
    const session = currentSession;
    if (session === null) {
      console.warn(
        "preview session-commands: setThemeCapabilities reached a live phase with no stored session",
      );
      return { kind: "rejected", reason: { code: "CAPABILITY_UNAVAILABLE" } };
    }
    return withReservedSlot(async () => {
      const failure = await wrap(session.setTheme(theme, capabilities));
      if (failure !== undefined) return { kind: "failed", failure };
      return { kind: "accepted" };
    });
  }

  async function retry(): Promise<PreviewCommandOutcomeV1> {
    const applied = deps.machine.apply("kernel.preview.retryCircuit");
    if (applied.kind === "illegal") return OPERATION_BUSY_REJECTION;
    const spec = lastSpec;
    if (spec === null) {
      console.warn(
        "preview session-commands: retry reached circuit-open with no remembered spec to reissue",
      );
      return { kind: "rejected", reason: { code: "CAPABILITY_UNAVAILABLE" } };
    }
    return withReservedSlot(() => establishSession(spec));
  }

  async function close(): Promise<PreviewCommandOutcomeV1> {
    const applied = deps.machine.apply("kernel.preview.disable");
    if (applied.kind === "illegal") return OPERATION_BUSY_REJECTION;

    const session = currentSession;
    currentSession = null;
    currentPreviewSessionId = null;
    currentNonce = null;
    lastSpec = null;
    deps.frameBroker.clear();
    deps.frameTokenLedger.invalidateCurrent();
    // Stopping uses host-supervision §8's own RESERVED shutdown slot, never the ordinary
    // 256-command budget — so close() deliberately never calls `withReservedSlot`.
    if (session !== null) await wrap(session.close());
    return { kind: "accepted" };
  }

  let outstandingGeometryRequests = 0;

  async function queryGeometry(
    frameToken: FrameTokenV1,
    query: GeometryQueryV1,
  ): Promise<PreviewQueryOutcomeV1> {
    const applied = deps.machine.apply("kernel.preview.queryGeometry");
    if (applied.kind === "illegal") return OPERATION_BUSY_REJECTION;

    const verification = deps.frameTokenLedger.verifyCurrent(frameToken);
    if (!verification.ok) return { kind: "rejected", reason: { code: verification.code } };

    if (outstandingGeometryRequests >= MAX_OUTSTANDING_GEOMETRY_REQUESTS) {
      return { kind: "rejected", reason: { code: "TOO_MANY_REQUESTS" } };
    }
    const session = currentSession;
    if (session === null) {
      console.warn(
        "preview session-commands: queryGeometry reached a live phase with no stored session",
      );
      return { kind: "rejected", reason: { code: "CAPABILITY_UNAVAILABLE" } };
    }
    outstandingGeometryRequests += 1;

    const result = await wrap(session.query(frameToken, query));
    outstandingGeometryRequests -= 1;

    if ("code" in result) return { kind: "failed", failure: result };

    const geometryToken =
      result.resolvedAnchor !== null && mintsGeometryToken(query.kind)
        ? deps.geometryTokenLedger.mint({
            identity: verification.identity,
            pageSlug: result.resolvedAnchor.pageSlug,
            elementId: result.resolvedAnchor.elementId,
            fx: result.resolvedAnchor.fx,
            fy: result.resolvedAnchor.fy,
          })
        : null;

    return { kind: "resolved", result, geometryToken };
  }

  function publishFrame(frame: PreviewFrameV1): PreviewNoLiveSessionError | FrameTokenV1 {
    if (currentPreviewSessionId === null || currentNonce === null) {
      return new PreviewNoLiveSessionError({
        reason: "publishFrame called with no live preview session",
      });
    }
    deps.frameBroker.publish(frame);
    const identity: FrameIdentityV1 = {
      previewSessionId: currentPreviewSessionId,
      nonce: currentNonce,
      sourceHash: frame.sourceHash,
      frameSeq: frame.frameSeq,
    };
    return deps.frameTokenLedger.mint(identity);
  }

  function acknowledgeDisplay(frameToken: FrameTokenV1): FrameAckError | FrameIdentityV1 {
    return deps.frameTokenLedger.acknowledge(frameToken);
  }

  /**
   * `noteSessionEstablished`/`noteSessionClosed` (kernel-assembly Task 16): the external
   * counterpart to `establishSession`'s own success tail / `close`'s own teardown tail,
   * for the ONE caller outside this module that actually drives the real Kernel-tracked
   * session today — `core/kernel/model/kernel.ts`'s `setActivePreviewSession`. See
   * `PreviewSessionCommands.noteSessionEstablished`'s own doc comment (above) for the
   * full "why": `handlers/preview-export.ts`'s `selectCurrentSource`/`handleClose` still
   * call `HandlerContext.setActivePreviewSession` directly rather than THIS module's own
   * `selectPage`/`selectCurrent`/`close` (Gap A), so `establishSession`/`close` above
   * never run in production — `publishFrame`/`acknowledgeDisplay` still need a real
   * incarnation identity to mint against regardless of which path established the
   * session, so `kernel.ts` seeds one through this pair instead.
   *
   * Deliberately NOT refactored to share a helper with `establishSession`'s success tail
   * / `close`'s teardown tail: those two already carry this file's own extensive, passing
   * test coverage, and extracting a shared helper risks a transcription slip in
   * already-proven code for no benefit a caller of THIS module can observe. The bodies
   * below are an intentional literal mirror, not a re-use.
   */
  function noteSessionEstablished(session: PreviewSession): void {
    currentSession = session;
    currentPreviewSessionId = uuidv7();
    currentNonce = mintHostNonce();
    deps.frameBroker.clear();
    deps.frameTokenLedger.invalidateCurrent();
  }

  function noteSessionClosed(): void {
    currentSession = null;
    currentPreviewSessionId = null;
    currentNonce = null;
    deps.frameBroker.clear();
    deps.frameTokenLedger.invalidateCurrent();
  }

  return {
    selectPage: selectSource,
    selectCurrent: selectSource,
    selectHistorical: selectSource,
    resize,
    setMode,
    setThemeCapabilities,
    retry,
    close,
    queryGeometry,
    publishFrame,
    acknowledgeDisplay,
    currentPreviewSessionId: () => currentPreviewSessionId,
    currentSession: () => currentSession,
    noteSessionEstablished,
    noteSessionClosed,
  };
}
