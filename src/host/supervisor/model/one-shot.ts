import {
  PROTOCOL_HARD_LIMITS,
  ProtocolError,
  decodeControlEnvelope,
  decodeFrameEnvelope,
  decodeHostHello,
  encodeClientHello,
  encodeControlEnvelope,
} from "../../protocol";
import type { ControlEnvelope, FrameEnvelope, ProtocolViolationCode } from "../../protocol";
import type { HostSessionSpec, PreviewFrame } from "../../types";
import type { OneShotDeps, OneShotResult } from "../types";
import { SupervisorError } from "./errors";
import { buildClientHello, verifyHostHello } from "./handshake";
import { mintIdentity } from "./identity";
import { createStderrDrain, readInbound, writeFramed } from "./transport";
import type { InboundMessage } from "./transport";

const HANDSHAKE_TIMEOUT_MS = 3_000;
/** §9: one-shot smoke/export capture deadline. */
const CAPTURE_TIMEOUT_MS = 10_000;
const REAP_TIMEOUT_MS = 1_000;

/**
 * Drive ONE one-shot `smoke`/`export` incarnation (host-supervision §4, §11.3,
 * §11.4): spawn → negotiate → mount → seal ONE full frame → the child exits 0.
 * Unlike the preview session there is NO pump, NO heartbeat watchdog, and NO
 * automatic restart — a one-shot failure is itself the result (§4), so the child
 * exiting cleanly after the frame is SUCCESS, not a crash. It deliberately mirrors
 * the negotiate/mount/await-ready sequence of `createHostSession.start()` for the
 * one-shot lifetime, without adopting its long-lived machinery. NOTE: `frame` is
 * the documented non-conformant MVP stand-in; the conformant correlated `capture`
 * + layout reply is deferred until the 2A bulk schema lands, so this frame must
 * NOT be routed to any preview stream.
 */
export async function runOneShotSession(
  spec: HostSessionSpec,
  deps: OneShotDeps,
): Promise<ProtocolError | SupervisorError | OneShotResult> {
  if (spec.mode !== "smoke" && spec.mode !== "export") {
    return new SupervisorError({
      code: "TRANSPORT_ERROR",
      reason: `runOneShotSession requires a smoke/export mode (was "${spec.mode}")`,
    });
  }
  const offeredLimits = deps.offeredLimits ?? PROTOCOL_HARD_LIMITS;
  const identity = mintIdentity(spec, deps.sessionId);
  const spawned = deps.spawn(deps.command);
  if (spawned instanceof SupervisorError) return spawned;
  const child = spawned;
  const stderrDrain = createStderrDrain(child);
  const inbound = readInbound(child);

  // Reap under the §9 1 s deadline, then re-kill if still alive — never an unbounded
  // await. Then stop the stderr drain and return the inbound iterator so nothing leaks.
  async function teardown(kill: boolean): Promise<void> {
    if (kill) child.kill();
    const { promise: reapDeadline, resolve: resolveReap } = Promise.withResolvers<"reap-timeout">();
    const reapTimer = deps.clock.setTimer(REAP_TIMEOUT_MS, () => resolveReap("reap-timeout"));
    const reaped = await Promise.race([child.exited.then(() => "exited" as const), reapDeadline]);
    reapTimer.cancel();
    if (reaped === "reap-timeout") {
      child.kill();
      await child.exited;
    }
    stderrDrain.stop();
    await stderrDrain.settled;
    await inbound.return?.(undefined);
  }

  async function fail<E extends ProtocolError | SupervisorError>(error: E): Promise<E> {
    await teardown(true);
    return error;
  }

  // A single pull against an ABSOLUTE deadline (mirrors session.ts nextInbound): the
  // remaining time is `deadlineAt - now`, so a multi-message await keeps ONE bound.
  async function nextInbound(
    deadlineAt: number,
    timeoutError: SupervisorError,
  ): Promise<ProtocolError | SupervisorError | InboundMessage> {
    const { promise: timeout, resolve: resolveTimeout } = Promise.withResolvers<SupervisorError>();
    const remaining = Math.max(0, deadlineAt - deps.clock.now());
    const timer = deps.clock.setTimer(remaining, () => resolveTimeout(timeoutError));
    const next = inbound
      .next()
      .then((result) =>
        result.done
          ? new SupervisorError({
              code: "CHILD_EXITED",
              reason: "stdout closed before the expected message",
            })
          : result.value,
      );
    const winner = await Promise.race([next, timeout]);
    timer.cancel();
    return winner;
  }

  // --- negotiate: client.hello → host.hello within 3 s ---
  const helloBytes = encodeClientHello(
    buildClientHello({
      spec,
      identity,
      runtimeDeclaration: deps.runtimeDeclaration,
      offeredLimits,
    }),
  );
  if (helloBytes instanceof ProtocolError) return fail(helloBytes);
  const sent = await writeFramed(child, helloBytes);
  if (sent instanceof SupervisorError) return fail(sent);
  const helloDeadline = deps.clock.now() + HANDSHAKE_TIMEOUT_MS;
  const helloMessage = await nextInbound(
    helloDeadline,
    new SupervisorError({ code: "HANDSHAKE_TIMEOUT", reason: "no host.hello within 3s" }),
  );
  if (helloMessage instanceof Error) return fail(helloMessage);
  if (helloMessage.messageClass !== "control")
    return fail(
      new ProtocolError({
        code: "MALFORMED_PROTOCOL",
        reason: "expected a control-class host.hello",
      }),
    );
  const hostHello = decodeHostHello(helloMessage.payload);
  if (hostHello instanceof ProtocolError) return fail(hostHello);
  const negotiation = verifyHostHello(hostHello, {
    spec,
    identity,
    runtimeDeclaration: deps.runtimeDeclaration,
    offeredLimits,
  });
  if (negotiation instanceof ProtocolError) return fail(negotiation);

  // --- mount: send the correlated mount, seal ready + one frame within 10 s ---
  const mountRequestId = "1";
  const mount: ControlEnvelope = {
    protocolVersion: 1,
    kind: "mount",
    sessionId: identity.sessionId,
    nonce: identity.nonce,
    messageId: "1",
    requestId: mountRequestId,
    body: {
      sourcePath: spec.sourcePath,
      expectedSourceHash: spec.sourceHash,
      mode: spec.mode,
      interactionMode: spec.interactionMode,
      size: { w: spec.size.w, h: spec.size.h },
      theme: spec.theme,
      capabilities: { colorDepth: spec.capabilities.colorDepth },
      deterministic: true, // §11.4: smoke/export are always deterministic
    },
  };
  const mountBytes = encodeControlEnvelope(mount);
  if (mountBytes instanceof ProtocolError) return fail(mountBytes);
  const mountSent = await writeFramed(child, mountBytes);
  if (mountSent instanceof SupervisorError) return fail(mountSent);

  const captureDeadline = deps.clock.now() + CAPTURE_TIMEOUT_MS;
  const sealed = await awaitReadyFrame(mountRequestId, captureDeadline);
  if (sealed instanceof Error) return fail(sealed);

  // Success: the frame is sealed. Reap the self-exiting one-shot child (no kill) so
  // nothing leaks, then return the typed result — no restart, no preview stream.
  await teardown(false);
  const { nonce: _nonce, ...previewIdentity } = identity;
  return {
    identity: previewIdentity,
    frame: toPreviewFrame(sealed.firstFrame),
    ready: sealed.ready,
    negotiatedLimits: negotiation.negotiatedLimits,
    exitCode: child.exitCode,
  };

  // Await the correlated `ready` AND the sealed frame under ONE 10 s capture deadline,
  // in EITHER order (the child sends ready then the frame). A pre-ready `error`
  // envelope is a typed one-shot failure preserving the child's own code.
  async function awaitReadyFrame(
    requestId: string,
    deadlineAt: number,
  ): Promise<
    ProtocolError | SupervisorError | { ready: ControlEnvelope; firstFrame: FrameEnvelope }
  > {
    let ready: ControlEnvelope | null = null;
    let firstFrame: FrameEnvelope | null = null;
    const timeoutError = new SupervisorError({
      code: "MOUNT_TIMEOUT",
      reason: "no ready + sealed frame within 10s",
    });
    while (true) {
      const message = await nextInbound(deadlineAt, timeoutError);
      if (message instanceof Error) return message;
      if (message.messageClass === "data") {
        const frame = decodeFrameEnvelope(message.payload);
        if (frame instanceof ProtocolError) return frame;
        const identityError = checkFrameIdentity(frame);
        if (identityError instanceof ProtocolError) return identityError;
        if (firstFrame === null) firstFrame = frame;
        if (ready !== null) return { ready, firstFrame };
        continue;
      }
      const envelope = decodeControlEnvelope(message.payload);
      if (envelope instanceof ProtocolError) return envelope;
      const identityError = checkEnvelopeIdentity(envelope);
      if (identityError instanceof ProtocolError) return identityError;
      if (envelope.kind === "ready" && envelope.responseTo === requestId) {
        ready = envelope;
        if (firstFrame !== null) return { ready, firstFrame };
        continue;
      }
      if (envelope.kind === "error") return mapHostError(envelope);
      if (envelope.kind === "heartbeat") continue;
      return new ProtocolError({
        code: "MALFORMED_PROTOCOL",
        reason: `unexpected ${envelope.kind} before ready`,
      });
    }
  }

  function checkEnvelopeIdentity(envelope: ControlEnvelope): ProtocolError | null {
    if (envelope.sessionId !== identity.sessionId || envelope.nonce !== identity.nonce) {
      return new ProtocolError({
        code: "MALFORMED_PROTOCOL",
        reason: "inbound envelope identity does not match the incarnation",
      });
    }
    return null;
  }
  function checkFrameIdentity(frame: FrameEnvelope): ProtocolError | null {
    if (
      frame.sessionId !== identity.sessionId ||
      frame.nonce !== identity.nonce ||
      frame.sourceHash !== identity.sourceHash
    ) {
      return new ProtocolError({
        code: "MALFORMED_PROTOCOL",
        reason: "inbound frame identity does not match the incarnation",
      });
    }
    return null;
  }
}

/** Preserve deterministic protocol codes; otherwise the child's error is a one-shot render failure (§12). */
const PROTOCOL_ERROR_CODES = new Set<string>([
  "MALFORMED_PROTOCOL",
  "OVERSIZED_MESSAGE",
  "FRAME_TOO_LARGE",
  "PROTOCOL_NEGOTIATION_FAILED",
  "RUNTIME_INTEGRITY_MISMATCH",
  "KIT_API_MISMATCH",
  "SOURCE_HASH_MISMATCH",
]);
function mapHostError(envelope: ControlEnvelope): ProtocolError | SupervisorError {
  const code = envelope.body.code;
  const rawReason = envelope.body.reason;
  const reason =
    typeof rawReason === "string" ? rawReason.slice(0, 200) : "host error during one-shot mount";
  if (typeof code === "string" && PROTOCOL_ERROR_CODES.has(code)) {
    return new ProtocolError({ code: code as ProtocolViolationCode, reason });
  }
  return new SupervisorError({
    code: "DESIGN_RENDER_FAILED",
    reason: typeof code === "string" ? `${code}: ${reason}` : reason,
  });
}

function toPreviewFrame(frame: FrameEnvelope): PreviewFrame {
  return {
    sessionId: frame.sessionId,
    sourceHash: frame.sourceHash,
    frameSeq: frame.frameSeq,
    width: frame.width,
    height: frame.height,
    rows: frame.rows,
  };
}
