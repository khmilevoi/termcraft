import type {
  AssertConforms,
  HostSessionSpecV1,
  HostSupervisorPort,
  PreviewFrameV1,
  PreviewGeometryQueryResultV1,
  PreviewSession,
  SupervisorEventV1,
} from "core/ports";
import { geometryQueryResultV1Schema } from "core/protocol";
import type { CommandPayloadByKindV1, FailureDtoV1, GeometryQueryResultV1 } from "core/protocol";
import { log } from "infrastructure/debug-log";

import { ProtocolError } from "../protocol";
import { SupervisorError, createHostSupervisor } from "../supervisor";
import type {
  FrameCoordinates,
  GeometryQuery,
  HostSupervisorDeps,
  PreviewFrame,
  SupervisedPreviewSession,
} from "../supervisor";
import type { HostSessionSpec } from "../types";

/**
 * `createHostSupervisorAdapter`: the production `HostSupervisorPort` over `host`'s real
 * `createHostSupervisor` (adapter-ring plan, Task 5). The real `HostSupervisor.preview` is
 * synchronous (`SupervisedPreviewSession | SupervisorError`); the port's `preview` is
 * `Promise`-typed because composing a restart-managed `PreviewSession` on top of the
 * supervisor's queued/backoff start path is conceptually async even though today's
 * construction resolves immediately — this adapter awaits nothing extra, it just wraps the
 * synchronous result in a resolved promise, matching `core/ports/host-supervisor.ts`'s own
 * header note.
 *
 * KNOWN DIVERGENCES (documented, not fabricated — flagged in the WP-2 lane report):
 * - `setMode`/`retry` are FIRE-AND-FORGET on `SupervisedPreviewSession` (host logs a dropped
 *   failure internally and never surfaces it to the caller). This adapter cannot recover
 *   that disposition, so it invokes the host method and resolves `undefined` immediately —
 *   never fabricating a `FailureDtoV1` for a call that may still be failing silently inside
 *   host. A future host API that returns the awaited disposition would let this genuinely
 *   report failure instead.
 * - `resize` USED TO be in the divergence list above too, until Task 11
 *   (resize-race-diagnosis.md) found the cost of that divergence: `preview.sessionReady`
 *   fires the instant a `SupervisedPreviewSession` object exists, hundreds of ms before the
 *   host child accepts control requests, so the shell's first resize landed in that window,
 *   was refused by `session.ts`'s phase gate, and this adapter reported success anyway —
 *   `runSimpleLiveCommand` then published a `kernel.stateChanged` for a resize that never
 *   reached the wire. `SupervisedPreviewSession.resize` now returns the real disposition
 *   (buffering a pre-ready resize is itself an accepted outcome — see `supervisor.ts`'s
 *   `sessionFor`/`flushPendingResize`); this adapter awaits it and maps a genuine
 *   `SupervisorError` the same way `preview()` already does.
 * - `setTheme` has NO host implementation at all (`host/supervisor/model/preview-session.ts`'s
 *   own header: "Deferred facade methods (forwardInput, setTheme, setCapabilities, tweaks)
 *   remain intentionally absent"). This adapter returns a `HOST_PROTOCOL_FAILED` FailureDtoV1
 *   naming the gap rather than silently no-op-succeeding.
 * - ONE WRAPPER PER SUPERVISED SESSION — see {@link createHostSupervisorAdapter}'s own
 *   `wrappers` cache. This is NOT a divergence but the opposite: without it this adapter broke
 *   an invariant the Kernel depends on.
 * - `query` USED TO be in this divergence list, returning a flat `HOST_PROTOCOL_FAILED`
 *   ("resolving an opaque frameToken into a host FrameIdentity needs a Kernel-side ledger this
 *   adapter has no access to"). A live run on 2026-08-10 found what that cost: every
 *   right-click died at `kernel.queryGeometry step:"refused"`, so NO PIN COULD EVER BE PLACED.
 *   The stated reason was also half wrong — the ledger exists and already runs
 *   (`core/preview/model/session-commands.ts` calls `frameTokenLedger.verifyCurrent` before
 *   this port is ever reached); what was genuinely missing is that the Kernel cannot know the
 *   incarnation's `sessionId`/`nonce`, which the facade drops by design. Both halves now meet
 *   where each is knowable: the Kernel passes the frame coordinates it verified
 *   (`PreviewFrameCoordinatesV1`), `host/supervisor` completes the incarnation half
 *   (`FrameCoordinates`), and this adapter translates the two geometry vocabularies and
 *   resolves the pin anchor. See {@link resolveAnchor} for the one real cost that closure has.
 */

function toHostSessionSpec(spec: HostSessionSpecV1): HostSessionSpec {
  return {
    mode: spec.mode,
    interactionMode: spec.interactionMode,
    pageSlug: spec.pageSlug,
    treeRoot: spec.treeRoot,
    entryRelPath: spec.entryRelPath,
    expectedFiles: spec.expectedFiles,
    sourceHash: spec.sourceHash,
    treeRevision: spec.treeRevision,
    kitApiVersion: spec.kitApiVersion,
    size: spec.size,
    theme: spec.theme,
    capabilities: spec.capabilities,
  };
}

/**
 * Buckets host's 18-member `SupervisorErrorCode` union onto the three host-related
 * `FailureDtoV1` codes the v1 operational-failure registry actually declares
 * (`core/protocol/model/failure.ts`): `HOST_CIRCUIT_OPEN` for an open crash-loop circuit,
 * `HOST_START_FAILED` for a failure to even begin an incarnation (including `HOST_CAPACITY`
 * — global-limit/queue-full is a start failure, not a protocol fault), and
 * `HOST_PROTOCOL_FAILED` for everything else (transport/handshake/mount-level faults).
 */
function toHostFailureDto(error: SupervisorError): FailureDtoV1 {
  const details = { supervisorErrorCode: String(error.code) };
  if (error.code === "CIRCUIT_OPEN") {
    return { code: "HOST_CIRCUIT_OPEN", retryable: false, safeMessage: error.message, details };
  }
  if (
    error.code === "SPAWN_FAILED" ||
    error.code === "HANDSHAKE_TIMEOUT" ||
    error.code === "MOUNT_TIMEOUT" ||
    error.code === "HOST_CAPACITY"
  ) {
    return {
      code: "HOST_START_FAILED",
      retryable: error.code === "HOST_CAPACITY",
      safeMessage: error.message,
      details,
    };
  }
  return { code: "HOST_PROTOCOL_FAILED", retryable: true, safeMessage: error.message, details };
}

const SET_THEME_NOT_WIRED: FailureDtoV1 = {
  code: "HOST_PROTOCOL_FAILED",
  retryable: false,
  safeMessage:
    "preview.setThemeCapabilities is not wired: host has not implemented a live theme/capability override yet",
  details: {},
};

async function* toPreviewFrames(
  source: AsyncIterable<PreviewFrame>,
): AsyncGenerator<PreviewFrameV1> {
  for await (const frame of source) {
    yield {
      sessionId: frame.sessionId,
      sourceHash: frame.sourceHash,
      frameSeq: frame.frameSeq,
      width: frame.width,
      height: frame.height,
      rows: frame.rows,
    };
  }
}

// -------------------------------------------------------------------------------------
// Geometry queries — the two vocabularies this adapter translates between (blocker B1)
// -------------------------------------------------------------------------------------

type KernelGeometryQueryV1 = CommandPayloadByKindV1["preview.queryGeometry"]["query"];

/**
 * §7.1: "the Kernel-level `pin-anchor` refinement travels AS `query-hit` on the wire" — the
 * host's closed query families have no fifth member, so the two Kernel point-queries collapse
 * onto one wire kind here. Only the Kernel distinguishes them, which is why the reply is
 * decoded back against the ORIGINAL Kernel kind, not this one.
 */
function toHostGeometryQuery(query: KernelGeometryQueryV1): GeometryQuery {
  if (query.kind === "hit" || query.kind === "pin-anchor") {
    return { kind: "hit", x: query.x, y: query.y };
  }
  if (query.kind === "layout") return { kind: "layout" };
  return { kind: query.kind, elementId: query.elementId };
}

/** A `ProtocolError` is a schema violation (never retryable); a `SupervisorError` reuses the shared bucketing. */
function toQueryFailureDto(error: ProtocolError | SupervisorError): FailureDtoV1 {
  if (error instanceof SupervisorError) return toHostFailureDto(error);
  return {
    code: "HOST_PROTOCOL_FAILED",
    retryable: false,
    safeMessage: error.message,
    details: { protocolViolationCode: String(error.code) },
  };
}

/**
 * §7.1's typed refusal: "If the requested frame is no longer the host's current sealed frame,
 * the host returns STALE_FRAME without geometry" — a normal outcome, not a protocol fault, and
 * genuinely retryable once the UI acknowledges the newer frame. Reported as a real failure
 * rather than decoded into a `hit: null`, which would fabricate "nothing is there" out of
 * "ask again" (CLAUDE.md: never silently substitute an invented value).
 */
function staleFrameFailure(reason: string): FailureDtoV1 {
  return {
    code: "HOST_PROTOCOL_FAILED",
    retryable: true,
    safeMessage: `the host is no longer displaying the queried frame: ${reason}`,
    details: { hostRefusal: "STALE_FRAME" },
  };
}

/**
 * The child's own per-kind reply record (`host/session/model/host-state-machine.ts`'s
 * `resolveGeometry`) reshaped into a candidate for `core/protocol`'s closed
 * `GeometryQueryResultV1` union, which is keyed by design §4.2's FUNCTION names
 * (`checkHit`/`rectOf`/`describe`/`layoutTree`) rather than the wire's request-family names.
 *
 * `describe`'s `id` is the elementId THIS REQUEST named: the wire reply carries only
 * `{found, kind}` (the child answers about the element it was asked about), while
 * `DescribedElementV1` needs `{id, kind}`. Echoing the requested id is reporting what was
 * asked, not inventing an identifier — and it is the only id in play.
 */
function toGeometryResultCandidate(
  query: KernelGeometryQueryV1,
  raw: Readonly<Record<string, unknown>>,
): unknown {
  if (query.kind === "hit" || query.kind === "pin-anchor") {
    const elementId = raw.elementId ?? null;
    return { kind: "checkHit", hit: elementId === null ? null : { id: elementId } };
  }
  if (query.kind === "rect") return { kind: "rectOf", rect: raw.rect ?? null };
  if (query.kind === "describe") {
    return {
      kind: "describe",
      element: raw.found === true ? { id: query.elementId, kind: raw.kind } : null,
    };
  }
  return { kind: "layoutTree", tree: raw.tree };
}

/** Validated through `core/protocol`'s own exported schema — no hand-rolled field checks. */
function decodeGeometryResult(
  query: KernelGeometryQueryV1,
  raw: Readonly<Record<string, unknown>>,
): ProtocolError | GeometryQueryResultV1 {
  const parsed = geometryQueryResultV1Schema.safeParse(toGeometryResultCandidate(query, raw));
  if (!parsed.success) {
    return new ProtocolError({
      code: "MALFORMED_PROTOCOL",
      reason: `query-${query.kind} reply did not decode: ${parsed.error.issues[0]?.message ?? "unknown issue"}`,
    });
  }
  return parsed.data;
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The SECOND round trip a resolving point-query costs, and why it is not avoidable here:
 * §8.1 binds a geometry token to `(FrameIdentityV1, pageSlug, elementId, fx, fy)`, but the
 * wire's `query-hit` reply carries only the element id — the fractional point is defined
 * relative to that element's own rectangle, which only `query-rect` returns. So a resolving
 * hit is followed by a `rect` query for the very element it just resolved.
 *
 * A failure to resolve the rect is NOT a failure of the query: the hit result is real and is
 * still returned, only without an anchor (so no geometry token is minted, so no pin can be
 * placed on it). Logged rather than propagated, per errore rule 21.
 */
async function resolveAnchor(
  supervised: SupervisedPreviewSession,
  frame: FrameCoordinates,
  point: Readonly<{ x: number; y: number }>,
  elementId: string,
): Promise<PreviewGeometryQueryResultV1["resolvedAnchor"]> {
  const rectQuery: KernelGeometryQueryV1 = { kind: "rect", elementId };
  const reply = await supervised.query(frame, toHostGeometryQuery(rectQuery));
  if (reply instanceof Error) {
    log.warn(
      `host/adapters/host-supervisor: no anchor for "${elementId}" — its rect query failed: ${reply.message}`,
    );
    return null;
  }
  if (!reply.ok) {
    log.warn(
      `host/adapters/host-supervisor: no anchor for "${elementId}" — its rect query was refused: ${reply.reason}`,
    );
    return null;
  }
  const decoded = decodeGeometryResult(rectQuery, reply.result);
  if (decoded instanceof ProtocolError) {
    log.warn(
      `host/adapters/host-supervisor: no anchor for "${elementId}" — its rect reply did not decode: ${decoded.message}`,
    );
    return null;
  }
  if (decoded.kind !== "rectOf" || decoded.rect === null) return null;

  const { x, y, width, height } = decoded.rect;
  if (width <= 0 || height <= 0) return null;
  const fx = (point.x - x) / width;
  const fy = (point.y - y) / height;
  // §8.1's "exact page, element, and FINITE fractional point" — defensive, since the schema
  // already fixed every input as a non-negative integer and both extents are positive here.
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;

  return {
    pageSlug: supervised.identity.pageSlug,
    elementId,
    fx: clampFraction(fx),
    fy: clampFraction(fy),
  };
}

function toPreviewSession(supervised: SupervisedPreviewSession): PreviewSession {
  return {
    get identity() {
      return supervised.identity;
    },
    get mode() {
      return supervised.mode;
    },
    get interactionMode() {
      return supervised.interactionMode;
    },
    frames: toPreviewFrames(supervised.frames),
    async resize(size) {
      // Task 11: genuinely awaited — no longer fire-and-forget (see this file's header
      // note). A buffered pre-ready resize resolves `undefined` (accepted, not a failure);
      // a real `SupervisorError` is mapped the same way `preview()`'s failures are.
      const failure = await supervised.resize(size);
      if (failure instanceof SupervisorError) return toHostFailureDto(failure);
      return undefined;
    },
    async setMode(mode) {
      supervised.setMode(mode); // fire-and-forget — see this file's header note
      return undefined;
    },
    async setTheme(_theme, _capabilities) {
      return SET_THEME_NOT_WIRED;
    },
    async retry() {
      supervised.retry(); // fire-and-forget — see this file's header note
      return undefined;
    },
    async close() {
      await supervised.close();
    },
    async query(frame, query): Promise<FailureDtoV1 | PreviewGeometryQueryResultV1> {
      const reply = await supervised.query(frame, toHostGeometryQuery(query));
      if (reply instanceof Error) return toQueryFailureDto(reply);
      if (!reply.ok) return staleFrameFailure(reply.reason);

      const decoded = decodeGeometryResult(query, reply.result);
      if (decoded instanceof ProtocolError) return toQueryFailureDto(decoded);

      // An anchor exists only for a RESOLVING point query — `checkHit` is produced by exactly
      // the two Kernel kinds that carry a point (§8.1), which is what makes this narrowing total.
      if (decoded.kind !== "checkHit" || decoded.hit === null) {
        return { result: decoded, resolvedAnchor: null };
      }
      if (query.kind !== "hit" && query.kind !== "pin-anchor") {
        return { result: decoded, resolvedAnchor: null };
      }
      return {
        result: decoded,
        resolvedAnchor: await resolveAnchor(supervised, frame, query, decoded.hit.id),
      };
    },
  };
}

export function createHostSupervisorAdapter(deps: HostSupervisorDeps): HostSupervisorPort {
  const listeners = new Set<(event: SupervisorEventV1) => void>();
  const supervisor = createHostSupervisor({
    ...deps,
    onEvent: (event) => {
      deps.onEvent?.(event);
      for (const listener of listeners) listener(event);
    },
  });

  /**
   * ONE `PreviewSession` WRAPPER PER SUPERVISED SESSION — the identity invariant this adapter
   * must not break (defect found in a live run, 2026-08-09: every page switch tore down the
   * preview it had just established).
   *
   * `HostSupervisor.preview` returns the SAME `SupervisedPreviewSession` object whenever the key
   * is unchanged and still live (`host/supervisor/model/supervisor.ts`'s `sessionFor` cache) —
   * and since the key became `treeRevision` alone (design-tree phase 3 Task 5), a PAGE SWITCH is
   * exactly that case: same session, `mount()` on the live child. `core/kernel/model/kernel.ts`'s
   * `setActivePreviewSession` reads that as object identity — `if (previous !== session) previous
   * .close()` — precisely so it never closes the session it is establishing.
   *
   * Building a fresh object literal per call (what `toPreviewSession` does, and what this
   * function used to hand back unmemoised) made that guard structurally unable to hold: two
   * distinct wrappers around ONE `KeyState`, so every switch closed the underlying session.
   * `close()` nulls `current` before it moves `state` off `"ready"`, so the resize that follows
   * logged `resize(<revision>) dropped — no live incarnation (state "ready")`; `relay.close()`
   * ended the frame stream; the in-flight `mount()` reached a child already being killed. The
   * pane kept the previous page's last frame — "switching pages does nothing" — and the next
   * switch paid a full respawn instead of Task 5's ~66ms mount.
   *
   * A `WeakMap` and not a `Map`: the supervisor DELETES a closed key (`supervisor.ts`'s `close`),
   * so a later `preview()` for the same revision legitimately builds a fresh
   * `SupervisedPreviewSession` and belongs in a fresh wrapper. Keying on the object itself means
   * a retired entry is collected with the session it wrapped — no eviction hook to keep in step.
   *
   * It also keeps `toPreviewFrames` to ONE generator per session: `PreviewRelay.frames` is
   * single-consumer by contract and THROWS on a second concurrent reader
   * (`host/supervisor/model/preview-relay.ts`), which a wrapper-per-call only avoided by
   * happening to close the predecessor first.
   */
  const wrappers = new WeakMap<SupervisedPreviewSession, PreviewSession>();

  function wrapperFor(supervised: SupervisedPreviewSession): PreviewSession {
    const existing = wrappers.get(supervised);
    if (existing !== undefined) return existing;
    const session = toPreviewSession(supervised);
    wrappers.set(supervised, session);
    return session;
  }

  async function preview(spec: HostSessionSpecV1): Promise<FailureDtoV1 | PreviewSession> {
    const result = supervisor.preview(toHostSessionSpec(spec));
    if (result instanceof SupervisorError) return toHostFailureDto(result);
    return wrapperFor(result);
  }

  function liveCount(): number {
    return supervisor.liveCount();
  }

  async function stopAll(): Promise<void> {
    await supervisor.stopAll();
  }

  function onEvent(listener: (event: SupervisorEventV1) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { preview, liveCount, stopAll, onEvent };
}

type _Conforms = AssertConforms<HostSupervisorPort, ReturnType<typeof createHostSupervisorAdapter>>;
