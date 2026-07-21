import { createElement } from "@opentui/react";

import {
  type ControlEnvelope,
  type FrameEnvelope,
  type FrameIdentity,
  type HostHelloV1,
  ProtocolError,
  type PublicLimits,
  decodeClientHello,
  decodeControlEnvelope,
} from "../../protocol";
import type { RenderHandle } from "../../render";
import type { HostMode, InteractionMode } from "../../types";
import type { HostSession, HostSessionDeps, MountRequestBody, ReadyBody } from "../types";

type Phase = "awaiting-hello" | "awaiting-mount" | "ready" | "closed";

/**
 * The host-side protocol driver (host-supervision §6-§7). It consumes decoded
 * control-class payloads and emits logical outbound messages through `deps.send`,
 * so it is testable without real stdio. State transitions are serialized: the
 * entry awaits each `receiveControlPayload` before feeding the next, so wire order
 * is process order (§7). A fatal `ProtocolError` past handshake emits a best-effort
 * `error` envelope, then requests exit; before handshake it only requests exit
 * (no identity to echo).
 */
export function createHostSession(deps: HostSessionDeps): HostSession {
  let phase: Phase = "awaiting-hello";
  let identity: { sessionId: string; nonce: string } | null = null;
  let messageCounter = 1n;

  let renderer: RenderHandle | null = null;
  let sourceHash: string | null = null;
  let mountedMode: HostMode | null = null;
  let frameCounter = 1n;
  let lastFrameSeq = "0";
  // The per-field minimum of client and host caps, fixed at handshake (§6). All
  // requested viewport sizes are bounded by these, so the host never renders a
  // frame the supervisor's decoder would reject. Host caps are the pre-handshake
  // default; mount/resize only run after `effectiveLimits` is set to the negotiation.
  let effectiveLimits: PublicLimits = deps.limits;

  const nextMessageId = () => {
    const id = messageCounter.toString();
    messageCounter += 1n;
    return id;
  };

  async function receiveControlPayload(payload: Uint8Array): Promise<void> {
    if (phase === "closed") return;
    if (phase === "awaiting-hello") return handleHello(payload);

    const envelope = decodeControlEnvelope(payload);
    if (envelope instanceof ProtocolError) return fail(envelope);
    const identityError = checkIdentity(envelope);
    if (identityError instanceof ProtocolError) return fail(identityError);

    if (phase === "awaiting-mount") {
      if (envelope.kind === "mount") return handleMount(envelope);
      if (envelope.kind === "shutdown") return handleShutdown(envelope);
      return fail(unknownKind(envelope.kind, phase));
    }
    // phase === "ready"
    if (envelope.kind === "resize") return handleResize(envelope);
    if (envelope.kind === "set-mode") return handleSetMode(envelope);
    if (envelope.kind === "ping") return handlePing(envelope);
    if (GEOMETRY_QUERY_KINDS.has(envelope.kind)) return handleQuery(envelope);
    if (envelope.kind === "shutdown") return handleShutdown(envelope);
    return fail(unknownKind(envelope.kind, phase));
  }

  function checkIdentity(envelope: ControlEnvelope): ProtocolError | null {
    if (identity === null)
      return new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "no negotiated identity" });
    if (envelope.sessionId !== identity.sessionId || envelope.nonce !== identity.nonce) {
      return new ProtocolError({
        code: "MALFORMED_PROTOCOL",
        reason: "envelope identity does not match the negotiated session",
      });
    }
    return null;
  }

  function unknownKind(kind: string, inPhase: Phase): ProtocolError {
    return new ProtocolError({
      code: "MALFORMED_PROTOCOL",
      reason: `kind ${JSON.stringify(kind)} is not accepted in phase ${inPhase}`,
    });
  }

  function handleHello(payload: Uint8Array): void {
    const hello = decodeClientHello(payload);
    if (hello instanceof ProtocolError) return failPreHandshake(hello);

    identity = { sessionId: hello.sessionId, nonce: hello.nonce };
    effectiveLimits = negotiateLimits(hello.limits);
    const hostHello: HostHelloV1 = {
      framingVersion: 1,
      kind: "host.hello",
      sessionId: hello.sessionId,
      nonce: hello.nonce,
      selectedFramingVersion: 1,
      selectedProtocolVersion: 1,
      runtimeDeclaration: deps.runtimeDeclaration,
      limits: effectiveLimits,
    };
    deps.send({ type: "host-hello", payload: hostHello });
    phase = "awaiting-mount";
  }

  /** Effective limits are the per-field minimum of client offer and host caps (§6). */
  function negotiateLimits(client: PublicLimits): PublicLimits {
    const cap = deps.limits;
    return {
      controlPayloadBytes: Math.min(client.controlPayloadBytes, cap.controlPayloadBytes),
      framePayloadBytes: Math.min(client.framePayloadBytes, cap.framePayloadBytes),
      maxFrameWidth: Math.min(client.maxFrameWidth, cap.maxFrameWidth),
      maxFrameHeight: Math.min(client.maxFrameHeight, cap.maxFrameHeight),
      maxFrameCells: Math.min(client.maxFrameCells, cap.maxFrameCells),
    };
  }

  /** Pre-handshake fatal: no identity to echo, so just exit (supervisor's 3s deadline). */
  function failPreHandshake(error: ProtocolError): void {
    phase = "closed";
    deps.requestExit({ code: 1, reason: String(error.reason) });
  }

  /** Post-handshake fatal: emit a best-effort typed `error`, then exit (§12). */
  function fail(error: ProtocolError): void {
    if (identity !== null) {
      deps.send({
        type: "control",
        payload: {
          protocolVersion: 1,
          kind: "error",
          sessionId: identity.sessionId,
          nonce: identity.nonce,
          messageId: nextMessageId(),
          body: { code: error.code, reason: error.reason },
        },
      });
    }
    phase = "closed";
    deps.requestExit({ code: 1, reason: String(error.reason) });
  }

  async function handleMount(envelope: ControlEnvelope): Promise<void> {
    if (envelope.requestId === undefined)
      return fail(
        new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "mount must carry a requestId" }),
      );
    const request = parseMountRequest(envelope.body);
    if (request instanceof ProtocolError) return fail(request);

    const loaded = await deps.loadPage({
      sourcePath: request.sourcePath,
      expectedSourceHash: request.expectedSourceHash,
    });
    if (loaded instanceof ProtocolError) return fail(loaded);

    const handle = await deps.createRenderer(request.size);
    renderer = handle;
    sourceHash = loaded.sourceHash;
    mountedMode = request.mode;

    handle.mount(createElement(loaded.component as never));
    await handle.render();
    const captured = handle.capture();

    const frameIdentity = sealFrameIdentity();
    // §4: only preview honors a requested interactive mode; historical/smoke/export
    // are always effectively static.
    const initialMode: InteractionMode =
      request.mode === "preview" ? request.interactionMode : "static";

    const readyBody: ReadyBody = {
      meta: loaded.meta,
      size: { w: captured.width, h: captured.height },
      interactionMode: initialMode,
      frameIdentity,
      tweaks: [],
    };
    deps.send({
      type: "control",
      payload: {
        protocolVersion: 1,
        kind: "ready",
        sessionId: identity!.sessionId,
        nonce: identity!.nonce,
        messageId: nextMessageId(),
        responseTo: envelope.requestId,
        body: readyBody as unknown as ControlEnvelope["body"],
      },
    });
    emitFrame(captured, frameIdentity);
    lastFrameSeq = frameIdentity.frameSeq;
    phase = "ready";

    // §11.3/§11.4: smoke and export are one-shot. Both exit 0 after the first
    // frame (Spike D — the entry, not this handler, calls process.exit). NOTE:
    // export's `frame` here is the documented non-conformant MVP stand-in (see
    // Scope); the conformant `capture`+layout reply is deferred to 2D.
    if (request.mode === "smoke" || request.mode === "export") {
      phase = "closed";
      deps.requestExit({ code: 0, reason: `${request.mode} one-shot complete` });
    }
  }

  function sealFrameIdentity(): FrameIdentity {
    const frameSeq = frameCounter.toString();
    frameCounter += 1n;
    return {
      sessionId: identity!.sessionId,
      nonce: identity!.nonce,
      sourceHash: sourceHash!,
      frameSeq,
    };
  }

  function emitFrame(
    captured: { width: number; height: number; rows: FrameEnvelope["rows"] },
    frameIdentity: FrameIdentity,
  ): void {
    const frame: FrameEnvelope = {
      protocolVersion: 1,
      kind: "frame",
      sessionId: frameIdentity.sessionId,
      nonce: frameIdentity.nonce,
      sourceHash: frameIdentity.sourceHash,
      frameSeq: frameIdentity.frameSeq,
      width: captured.width,
      height: captured.height,
      rows: captured.rows,
    };
    deps.send({ type: "frame", payload: frame });
  }

  function parseMountRequest(body: ControlEnvelope["body"]): ProtocolError | MountRequestBody {
    const bad = (reason: string) => new ProtocolError({ code: "MALFORMED_PROTOCOL", reason });
    const sourcePath = body.sourcePath;
    if (typeof sourcePath !== "string" || sourcePath.length === 0 || sourcePath.length > 4096)
      return bad("mount.sourcePath must be a bounded non-empty string");
    const expectedSourceHash = body.expectedSourceHash;
    if (typeof expectedSourceHash !== "string" || !/^[0-9a-f]{64}$/.test(expectedSourceHash))
      return bad("mount.expectedSourceHash must be 64 lowercase hex");
    const mode = body.mode;
    if (mode !== "preview" && mode !== "historical" && mode !== "smoke" && mode !== "export")
      return bad("mount.mode must be a host mode");
    const interactionMode = body.interactionMode;
    if (interactionMode !== "static" && interactionMode !== "interactive")
      return bad("mount.interactionMode must be static|interactive");
    const size = parseSize(body.size);
    if (size instanceof ProtocolError) return size;
    const theme = body.theme;
    if (typeof theme !== "string" || theme.length === 0 || theme.length > 64)
      return bad("mount.theme must be a bounded non-empty string");
    const capabilities = body.capabilities;
    if (capabilities === null || typeof capabilities !== "object" || Array.isArray(capabilities))
      return bad("mount.capabilities must be an object");
    const colorDepth = (capabilities as { colorDepth?: unknown }).colorDepth;
    if (typeof colorDepth !== "number" || !Number.isSafeInteger(colorDepth) || colorDepth <= 0)
      return bad("mount.capabilities.colorDepth must be a positive integer");
    const deterministic = body.deterministic;
    if (typeof deterministic !== "boolean") return bad("mount.deterministic must be a boolean");
    return {
      sourcePath,
      expectedSourceHash,
      mode,
      interactionMode,
      size,
      theme,
      capabilities: { colorDepth },
      deterministic,
    };
  }

  // The param is widened to `| undefined`: callers pass element-access expressions
  // (`body.size`) which are `JsonValue | undefined` under noUncheckedIndexedAccess,
  // whereas the bare indexed-access type is not. The first guard rejects undefined.
  function parseSize(
    value: ControlEnvelope["body"][string] | undefined,
  ): ProtocolError | { w: number; h: number } {
    const bad = (reason: string) => new ProtocolError({ code: "MALFORMED_PROTOCOL", reason });
    const tooLarge = (reason: string) => new ProtocolError({ code: "FRAME_TOO_LARGE", reason });
    if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value))
      return bad("size must be an object");
    const w = (value as { w?: unknown }).w;
    const h = (value as { h?: unknown }).h;
    if (typeof w !== "number" || !Number.isSafeInteger(w) || w <= 0)
      return bad("size.w must be a positive integer");
    if (typeof h !== "number" || !Number.isSafeInteger(h) || h <= 0)
      return bad("size.h must be a positive integer");
    // §5.3: the requested viewport must fit the negotiated frame caps, else the
    // host would render a frame its own — and the supervisor's — decoder rejects
    // with FRAME_TOO_LARGE. Check the axes first so w*h can never overflow (each
    // axis is bounded by its cap, ≤ 2048, before the product is computed).
    if (w > effectiveLimits.maxFrameWidth)
      return tooLarge(
        `size.w ${w} exceeds negotiated maxFrameWidth ${effectiveLimits.maxFrameWidth}`,
      );
    if (h > effectiveLimits.maxFrameHeight)
      return tooLarge(
        `size.h ${h} exceeds negotiated maxFrameHeight ${effectiveLimits.maxFrameHeight}`,
      );
    if (w * h > effectiveLimits.maxFrameCells)
      return tooLarge(
        `frame ${w}×${h} = ${w * h} cells exceeds negotiated maxFrameCells ${effectiveLimits.maxFrameCells}`,
      );
    return { w, h };
  }

  async function handleResize(envelope: ControlEnvelope): Promise<void> {
    if (renderer === null)
      return fail(new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "resize before mount" }));
    const size = parseSize(envelope.body.size);
    if (size instanceof ProtocolError) return fail(size);
    renderer.resize(size);
    await renderer.render();
    const captured = renderer.capture();
    const frameIdentity = sealFrameIdentity();
    emitFrame(captured, frameIdentity);
    lastFrameSeq = frameIdentity.frameSeq;
  }

  function handleSetMode(envelope: ControlEnvelope): void {
    if (envelope.requestId === undefined)
      return fail(
        new ProtocolError({
          code: "MALFORMED_PROTOCOL",
          reason: "set-mode must carry a requestId",
        }),
      );
    const requested = envelope.body.interactionMode;
    if (requested !== "static" && requested !== "interactive")
      return fail(
        new ProtocolError({
          code: "MALFORMED_PROTOCOL",
          reason: "set-mode.interactionMode must be static|interactive",
        }),
      );
    const allowed = mountedMode === "preview" || requested === "static";
    if (!allowed) {
      // The only reachable refusal in 2C is a historical mount (smoke/export are
      // one-shot and exit before `ready`). §3.2 names HISTORICAL_PREVIEW_READ_ONLY
      // as THE typed read-only refusal for a historical session.
      sendResponse(envelope.requestId, "set-mode", {
        ok: false,
        code: "HISTORICAL_PREVIEW_READ_ONLY",
        reason: `${mountedMode} mode cannot accept interactive`,
      });
      return;
    }
    sendResponse(envelope.requestId, "set-mode", { ok: true, interactionMode: requested });
  }

  function handlePing(envelope: ControlEnvelope): void {
    if (envelope.requestId === undefined)
      return fail(
        new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "ping must carry a requestId" }),
      );
    // Echo the request kind (§7 has no `pong` in the closed family); correlate by responseTo.
    sendResponse(envelope.requestId, "ping", { ok: true });
  }

  /** Blocker B1: the closed geometry-query wire kinds (§7 request family names; §7.1: the
   * Kernel-level `pin-anchor` refinement travels AS `query-hit` — the wire never sees a
   * fifth kind). */
  const GEOMETRY_QUERY_KINDS = new Set([
    "query-hit",
    "query-rect",
    "query-describe",
    "query-layout",
  ]);

  /** The identity of the frame the host has ACTUALLY sealed right now — no new seal, no
   * `frameCounter` increment (§7.1: a query reads the current sealed frame, it never mints one). */
  function currentFrameIdentity(): FrameIdentity {
    return {
      sessionId: identity!.sessionId,
      nonce: identity!.nonce,
      sourceHash: sourceHash!,
      frameSeq: lastFrameSeq,
    };
  }

  type ParsedGeometryQuery =
    | { readonly kind: "hit"; readonly x: number; readonly y: number }
    | { readonly kind: "rect" | "describe"; readonly elementId: string }
    | { readonly kind: "layout" };

  /**
   * Validates the request's carried `frameIdentity` (the Kernel resolves a `FrameToken` to
   * this identity and sends it in the host request — host-supervision §7.1) plus the
   * per-kind fields the closed query union defines (kernel-command-contract §8.2, redrawn
   * on the wire without the Kernel-only `pin-anchor` discriminator per §7.1).
   */
  function parseGeometryQueryBody(
    wireKind: string,
    body: ControlEnvelope["body"],
  ): ProtocolError | { frameIdentity: FrameIdentity; query: ParsedGeometryQuery } {
    const bad = (reason: string) =>
      new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: `${wireKind}: ${reason}` });
    const raw = body.frameIdentity;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      return bad("frameIdentity must be an object");
    const ri = raw as {
      sessionId?: unknown;
      nonce?: unknown;
      sourceHash?: unknown;
      frameSeq?: unknown;
    };
    if (
      typeof ri.sessionId !== "string" ||
      typeof ri.nonce !== "string" ||
      typeof ri.sourceHash !== "string" ||
      typeof ri.frameSeq !== "string"
    ) {
      return bad("frameIdentity.sessionId/nonce/sourceHash/frameSeq must all be strings");
    }
    const frameIdentity: FrameIdentity = {
      sessionId: ri.sessionId,
      nonce: ri.nonce,
      sourceHash: ri.sourceHash,
      frameSeq: ri.frameSeq,
    };

    if (wireKind === "query-hit") {
      const x = body.x;
      const y = body.y;
      if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0)
        return bad("x must be a non-negative integer");
      if (typeof y !== "number" || !Number.isSafeInteger(y) || y < 0)
        return bad("y must be a non-negative integer");
      return { frameIdentity, query: { kind: "hit", x, y } };
    }
    if (wireKind === "query-rect" || wireKind === "query-describe") {
      const elementId = body.elementId;
      if (typeof elementId !== "string" || elementId.length === 0)
        return bad("elementId must be a non-empty string");
      return {
        frameIdentity,
        query: { kind: wireKind === "query-rect" ? "rect" : "describe", elementId },
      };
    }
    return { frameIdentity, query: { kind: "layout" } };
  }

  /** Real geometry, resolved from the live `RenderHandle` — never fabricated (CLAUDE.md). */
  function resolveGeometry(query: ParsedGeometryQuery): Record<string, unknown> {
    if (renderer === null) return {};
    if (query.kind === "hit") return { elementId: renderer.hitTest(query.x, query.y) };
    if (query.kind === "rect") {
      const rect = renderer.rectOf(query.elementId);
      return { found: rect !== null, rect };
    }
    if (query.kind === "describe") {
      const described = renderer.describe(query.elementId);
      return { found: described !== null, kind: described?.kind ?? null };
    }
    return { tree: renderer.layoutTree() };
  }

  function handleQuery(envelope: ControlEnvelope): void {
    if (envelope.requestId === undefined)
      return fail(
        new ProtocolError({
          code: "MALFORMED_PROTOCOL",
          reason: `${envelope.kind} must carry a requestId`,
        }),
      );
    if (renderer === null)
      return fail(
        new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: `${envelope.kind} before mount` }),
      );
    const parsed = parseGeometryQueryBody(envelope.kind, envelope.body);
    if (parsed instanceof ProtocolError) return fail(parsed);

    const current = currentFrameIdentity();
    const { frameIdentity: requested } = parsed;
    const isCurrent =
      requested.sessionId === current.sessionId &&
      requested.nonce === current.nonce &&
      requested.sourceHash === current.sourceHash &&
      requested.frameSeq === current.frameSeq;
    // §7.1: "If the requested frame is no longer the host's current sealed frame, the host
    // returns STALE_FRAME without geometry" — a normal typed refusal, not a protocol violation.
    if (!isCurrent) {
      sendResponse(envelope.requestId, envelope.kind, {
        ok: false,
        code: "STALE_FRAME",
        reason: `requested frame ${requested.frameSeq} is not the current sealed frame ${current.frameSeq}`,
      });
      return;
    }

    const result = resolveGeometry(parsed.query);
    sendResponse(envelope.requestId, envelope.kind, { ok: true, frameIdentity: current, result });
  }

  function handleShutdown(envelope: ControlEnvelope): void {
    if (envelope.requestId !== undefined) {
      sendResponse(envelope.requestId, "shutdown-ack", { ok: true });
    } else {
      sendControl("shutdown-ack", { ok: true });
    }
    phase = "closed";
    deps.requestExit({ code: 0, reason: "graceful shutdown" });
  }

  function sendResponse(responseTo: string, kind: string, body: Record<string, unknown>): void {
    deps.send({
      type: "control",
      payload: {
        protocolVersion: 1,
        kind,
        sessionId: identity!.sessionId,
        nonce: identity!.nonce,
        messageId: nextMessageId(),
        responseTo,
        body: body as ControlEnvelope["body"],
      },
    });
  }

  function sendControl(kind: string, body: Record<string, unknown>): void {
    deps.send({
      type: "control",
      payload: {
        protocolVersion: 1,
        kind,
        sessionId: identity!.sessionId,
        nonce: identity!.nonce,
        messageId: nextMessageId(),
        body: body as ControlEnvelope["body"],
      },
    });
  }

  function emitHeartbeat(): void {
    if (identity === null || phase === "closed") return;
    sendControl("heartbeat", { hostTick: deps.now(), lastFrameSeq });
  }

  return { receiveControlPayload, emitHeartbeat };
}
