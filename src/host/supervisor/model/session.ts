import { trace } from "infrastructure/debug-log";

import {
  PROTOCOL_HARD_LIMITS,
  ProtocolError,
  decodeControlEnvelope,
  decodeFrameEnvelope,
  decodeHostHello,
  encodeClientHello,
  encodeControlEnvelope,
} from "../../protocol";
import type {
  ControlEnvelope,
  FrameEnvelope,
  FrameIdentity,
  ProtocolViolationCode,
  RuntimeDeclarationBundleV1,
} from "../../protocol";
import type { HostSessionIdentity, HostSessionSpec, InteractionMode, Size } from "../../types";
import { SupervisorError } from "./errors";
import { buildClientHello, verifyHostHello } from "./handshake";
import { mintIdentity } from "./identity";
import { buildMountBody } from "./mount-request";
import { createStderrDrain, readInbound, writeFramed } from "./transport";
import type { InboundMessage } from "./transport";
// NOTE: session.ts ALREADY imports decodeControlEnvelope + decodeFrameEnvelope from
// "../../protocol" (top import block, used by awaitReady, retained per §4h) — do NOT
// re-add them here or tsc fails with TS2300 "Duplicate identifier".
import type {
  ControlMailbox,
  ControlQueue,
  FloodMonitor,
  FrameBroker,
  GeometryQuery,
  GeometryQueryResult,
  HeartbeatWatchdog,
  HostSession,
  HostSessionDeps,
  MountPageV1,
  ReadyOutcome,
  RequestTable,
  SessionPhase,
  SpawnedChild,
  StopOutcome,
} from "../types";
import type { TimerHandle } from "./clock";
import { createControlMailbox } from "./control-mailbox";
import { createControlQueue } from "./control-queue";
import { createFloodMonitor } from "./flood-monitor";
import { createFrameBroker } from "./frame-broker";
import { createHeartbeatWatchdog } from "./heartbeat-watchdog";
import { REQUEST_TABLE_CAPACITY, createRequestTable } from "./request-table";
import {
  FIRST_FRAME_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_REASON,
  MOUNT_TIMEOUT_MS,
} from "./timeouts";

const SHUTDOWN_ACK_TIMEOUT_MS = 1_000;
const REAP_TIMEOUT_MS = 1_000;

/**
 * Create a session that drives ONE incarnation: spawn → negotiate → mount →
 * ready, then graceful/forced stop → reap (§6, §9, §10). A single serialized
 * driver owns the child, the inbound iterator, the stderr drain, and every
 * timer, with explicit teardown on every exit path (never a Reatom connect hook).
 */
export function createHostSession(spec: HostSessionSpec, deps: HostSessionDeps): HostSession {
  const offeredLimits = deps.offeredLimits ?? PROTOCOL_HARD_LIMITS;
  // The incarnation identity, split into a stable half and a mutable half (design §9.2). One
  // incarnation now serves one tree REVISION and mounts a page at a time, so only
  // sessionId/nonce/mode stay fixed for the incarnation's whole life; pageSlug/sourceHash/
  // kitApiVersion describe whichever page is CURRENTLY mounted and move on every accepted
  // `mount()`.
  const stable = mintIdentity(spec, deps.sessionId);
  let mounted = {
    pageSlug: spec.pageSlug,
    sourceHash: spec.sourceHash,
    kitApiVersion: spec.kitApiVersion,
  };
  // Every hash this incarnation has legitimately mounted. `checkFrameIdentity` accepts any of
  // them: stdout is ordered, so the previous page's last frames arrive BEFORE the switch's
  // `ready`, and killing the child over a frame it was correct to send would turn every page
  // switch into a crash. A hash that was never mounted is still a violation — that is the part
  // of the guard worth keeping.
  const mountedHashes = new Set<string>([spec.sourceHash]);
  const identityOf = (): HostSessionIdentity => ({ ...stable, ...mounted });
  // The runtime declaration the handshake actually negotiated (§6.4), kept so `mount()` can
  // re-run the kit-API membership check for a LATER page without re-negotiating the handshake.
  let negotiatedDeclaration: RuntimeDeclarationBundleV1 | null = null;
  // A mount request awaiting its correlated `ready` (design §9.2). Set by `mount()` before the
  // write, cleared by `runPump`'s pending-mount hook the moment the matching envelope arrives —
  // see that hook's comment for why the commit must happen inline, not via a `.then`.
  let pendingMount: {
    requestId: string;
    mounted: { pageSlug: string; sourceHash: string; kitApiVersion: number };
  } | null = null;
  // design §9.4's SECOND deadline: the budget from an accepted `ready` (for a REPEATED mount —
  // the very first mount is covered by `start()`'s own `awaitReady` deadline, before the pump or
  // this timer even exist) to the frame that must follow it. Owned by the pending mount: armed
  // in the pump hook the instant `broker.expect(...)` re-seeds the guard, cancelled the instant
  // an accepted frame arrives or the session tears down — see `FIRST_FRAME_TIMEOUT_MS`'s own doc
  // comment in `timeouts.ts` for why this is a conformance guard, not the primary deadline.
  let firstFrameTimer: TimerHandle | null = null;
  let phase: SessionPhase = "created";

  // Post-ready components. The watchdog escalation and the request-table timeout
  // are wired to the single fatal path (declared as hoisted functions below).
  const watchdog: HeartbeatWatchdog = (deps.createWatchdog ?? createHeartbeatWatchdog)(deps.clock, {
    onUnhealthy: (error) => onPumpFatal(error),
  });
  const requestTable: RequestTable = (deps.createRequestTable ?? createRequestTable)(deps.clock, {
    onTimeout: () => watchdog.noteRequestTimeout(),
  });
  const broker: FrameBroker = (deps.createBroker ?? createFrameBroker)({
    sessionId: stable.sessionId,
    nonce: stable.nonce,
    sourceHash: mounted.sourceHash,
  });
  // §8 rolling-second output flood detection. Metered on RAW inbound payload bytes
  // (before decode/coalescing), so a 2000-frame/s or >128 MiB/s or >1 MiB/s-stderr
  // child trips PROTOCOL_FLOOD / STDERR_FLOOD → onPumpFatal → deterministic circuit-open.
  const floodMonitor: FloodMonitor = (deps.createFloodMonitor ?? createFloodMonitor)(deps.clock);
  // §8 bounded ordered outbound queue: every post-ready request (resize/set-mode/ping/
  // query-*/shutdown) enqueues here instead of writing directly; `pumpOutbound` is the
  // sole drain. Discrete-only for now — coalescing resize/mousemove/hover is deferred
  // (see this file's header note); a full discrete queue is still the thing that makes
  // `HOST_BACKPRESSURED`/`preview.writable` real, observable outcomes (blocker wiring).
  const controlQueue: ControlQueue = createControlQueue();
  let queueBackpressured = false;
  controlQueue.onWritable(() => {
    if (!queueBackpressured) return;
    queueBackpressured = false;
    deps.onBackpressureChange?.("writable");
  });
  let outboundDraining = false;

  // §8 bounded inbound mailbox: a decoupled producer (the pump, below) / consumer (this
  // clock-scheduled drain) pair. Offering then draining in the SAME synchronous step would
  // make the mailbox unable to ever hold more than one entry, so the drain is scheduled on
  // the injected clock instead — a slow/absent consumer genuinely lets entries pile up to
  // the bound, and `CONTROL_BACKPRESSURE` becomes a reachable, testable outcome instead of
  // a permanently-vacuous code path.
  const controlMailbox: ControlMailbox = createControlMailbox();
  let mailboxDrainTimer: TimerHandle | null = null;
  function scheduleMailboxDrain(): void {
    if (mailboxDrainTimer !== null) return;
    mailboxDrainTimer = deps.clock.setTimer(0, () => {
      mailboxDrainTimer = null;
      drainMailbox();
    });
  }
  function drainMailbox(): void {
    while (true) {
      const next = controlMailbox.drain();
      if (next === null) return;
      deps.onControlEvent?.(next);
    }
  }

  let pumpTask: Promise<void> = Promise.resolve();

  let child: SpawnedChild | null = null;
  let stderrDrain: ReturnType<typeof createStderrDrain> | null = null;
  let inbound: AsyncGenerator<ProtocolError | SupervisorError | InboundMessage> | null = null;
  // Two independent monotonic decimal-uint64 sequences per (sender, nonce): the
  // envelope messageId (1,2,3,… contiguous, §5.2) and the request correlation id
  // (its own 1,2,3,…) echoed back in responseTo. Drawing both from one counter
  // makes messageId non-contiguous (2,4,…) and never "1" (review Finding #8).
  let messageCounter = 1n;
  const nextMessageId = () => {
    const value = messageCounter.toString();
    messageCounter += 1n;
    return value;
  };
  let requestCounter = 1n;
  const nextRequestId = () => {
    const value = requestCounter.toString();
    requestCounter += 1n;
    return value;
  };

  // A single-consumer pull over the inbound iterator against an ABSOLUTE deadline.
  // The timer duration is `deadlineAt - now` each call, so a loop that consumes
  // several messages (awaitReady/awaitShutdownAck) keeps ONE total bound instead of
  // re-arming the full duration per message (review Findings #3/#9). Every timeout
  // path tears the session down, so the abandoned `inbound.next()` on a timeout is
  // settled by `inbound.return()` in teardown/stop and never eaten by a later pull.
  async function nextInbound(
    deadlineAt: number,
    timeoutError: SupervisorError,
  ): Promise<ProtocolError | SupervisorError | InboundMessage> {
    if (inbound === null)
      return new SupervisorError({ code: "TRANSPORT_ERROR", reason: "no inbound iterator" });
    // `Promise.withResolvers` returns the resolver directly, so there is no closure
    // assignment inside the executor for TS 7 to narrow to `never`.
    const { promise: timeout, resolve: resolveTimeout } = Promise.withResolvers<SupervisorError>();
    const remaining = Math.max(0, deadlineAt - deps.clock.now());
    const timer = deps.clock.setTimer(remaining, () => resolveTimeout(timeoutError));
    const next = inbound.next().then((result) =>
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

  async function start(): Promise<ProtocolError | SupervisorError | ReadyOutcome> {
    if (phase !== "created") {
      return new SupervisorError({
        code: "TRANSPORT_ERROR",
        reason: `start() is only valid from "created" (was "${phase}")`,
      });
    }
    phase = "spawning";
    const spawned = deps.spawn(deps.command);
    if (spawned instanceof SupervisorError) {
      broker.close(); // end the frame iterator; there is no child/inbound/drain to reap yet
      phase = "failed";
      return spawned;
    }
    child = spawned;
    stderrDrain = createStderrDrain(spawned, {
      floodMonitor,
      onFlood: (error) => onPumpFatal(error),
    });
    inbound = readInbound(spawned);

    // --- negotiate: send client.hello, await host.hello within the handshake budget ---
    phase = "negotiating";
    const clientHello = buildClientHello({
      spec,
      identity: identityOf(),
      runtimeDeclaration: deps.runtimeDeclaration,
      offeredLimits,
    });
    const helloBytes = encodeClientHello(clientHello);
    if (helloBytes instanceof ProtocolError) return failWith(helloBytes);
    const sent = await writeFramed(spawned, helloBytes);
    if (sent instanceof SupervisorError) return failWith(sent);

    const handshakeStartedAt = deps.clock.now();
    const handshakeDeadlineAt = handshakeStartedAt + HANDSHAKE_TIMEOUT_MS;
    const helloMessage = await nextInbound(
      handshakeDeadlineAt,
      new SupervisorError({ code: "HANDSHAKE_TIMEOUT", reason: HANDSHAKE_TIMEOUT_REASON }),
    );
    // DIAGNOSTIC: the measured wait against the budget, on BOTH outcomes. A timeout that is
    // budgeted (`restart-policy.ts`) is invisible as a single event — it shows up only as four
    // spawns and a frozen app — so the number that decides it belongs in the log.
    trace("host.handshake", {
      sessionId: stable.sessionId,
      waitedMs: deps.clock.now() - handshakeStartedAt,
      budgetMs: HANDSHAKE_TIMEOUT_MS,
      outcome: helloMessage instanceof Error ? helloMessage.code : "hello",
    });
    if (helloMessage instanceof Error) return failWith(helloMessage);
    if (helloMessage.messageClass !== "control")
      return failWith(
        new ProtocolError({
          code: "MALFORMED_PROTOCOL",
          reason: "expected a control-class host.hello",
        }),
      );
    const hostHello = decodeHostHello(helloMessage.payload);
    if (hostHello instanceof ProtocolError) return failWith(hostHello);
    const negotiation = verifyHostHello(hostHello, {
      spec,
      identity: identityOf(),
      runtimeDeclaration: deps.runtimeDeclaration,
      offeredLimits,
    });
    if (negotiation instanceof ProtocolError) return failWith(negotiation);
    // Keep what the handshake proved: `mount()` re-runs this membership check for a LATER
    // page without re-negotiating (read-claim 6).
    negotiatedDeclaration = negotiation.hostHello.runtimeDeclaration;

    // --- mount: send correlated mount request, await ready within 10s ---
    phase = "mounting";
    const mountRequestId = nextRequestId();
    const mountBody = buildMountBody(spec, spec.mode === "export" || spec.mode === "smoke");
    if (mountBody instanceof ProtocolError) return failWith(mountBody);
    const mountEnvelope: ControlEnvelope = {
      protocolVersion: 1,
      kind: "mount",
      sessionId: stable.sessionId,
      nonce: stable.nonce,
      messageId: nextMessageId(),
      requestId: mountRequestId,
      body: mountBody,
    };
    const mountBytes = encodeControlEnvelope(mountEnvelope);
    if (mountBytes instanceof ProtocolError) return failWith(mountBytes);
    const mountSent = await writeFramed(spawned, mountBytes);
    if (mountSent instanceof SupervisorError) return failWith(mountSent);

    const mountDeadlineAt = deps.clock.now() + MOUNT_TIMEOUT_MS;
    const readyResult = await awaitReady(mountRequestId, mountDeadlineAt);
    if (readyResult instanceof Error) return failWith(readyResult);

    phase = "ready";
    startPump(readyResult.firstFrame);
    return {
      identity: identityOf(),
      negotiatedLimits: negotiation.negotiatedLimits,
      ready: readyResult.ready,
      firstFrame: readyResult.firstFrame,
    };
  }

  function startPump(firstFrame: FrameEnvelope): void {
    // Publish the already-captured first frame so the initial displayed frame is
    // not dropped (brief §6 Q2). The broker's guard re-validates it.
    broker.publish(firstFrame);
    watchdog.start();
    pumpTask = runPump();
  }

  // The SOLE reader of `inbound` from `ready` onward (brief invariant 1). A bare
  // for-await with no per-message deadline — liveness is the watchdog's job
  // (brief §6 Q1). Every fatal exit routes through onPumpFatal; teardown settles
  // the suspended next() via inbound.return(), so nothing leaks.
  async function runPump(): Promise<void> {
    if (inbound === null) return;
    for await (const message of inbound) {
      if (message instanceof Error) {
        onPumpFatal(message);
        return;
      }
      if (message.messageClass === "data") {
        // §8 flood metering on the RAW encoded payload, before decode/coalescing.
        const flood = floodMonitor.noteFrame(message.payload.byteLength);
        if (flood instanceof SupervisorError) {
          onPumpFatal(flood);
          return;
        }
        const frame = decodeFrameEnvelope(message.payload);
        if (frame instanceof ProtocolError) {
          onPumpFatal(frame);
          return;
        }
        // §10.1/§5.3/§12: a frame's identity + monotonic frameSeq are FATAL for the
        // live child, not a silent drop. 2D-1 awaitReady already enforced
        // checkFrameIdentity fatally; with ONE incarnation there is no cross-nonce
        // noise yet, so a mismatch is a real violation → terminate + MALFORMED_PROTOCOL.
        const frameIdentityError = checkFrameIdentity(frame);
        if (frameIdentityError instanceof ProtocolError) {
          onPumpFatal(frameIdentityError);
          return;
        }
        // Identity passed, so `frame.sourceHash` names SOME hash this incarnation legitimately
        // mounted (`mountedHashes`) — but the broker's own guard only ever expects the ONE hash
        // the pump hook above last called `broker.expect(...)` with. A "stale" verdict here is
        // therefore fatal for one of two DIFFERENT reasons (§9.2/§5.3), and the diagnosis must
        // say which: (a) the hash is legitimate but SUPERSEDED — this frame's page had its own
        // switch's `ready` already observed, so no frame naming it should still be arriving; or
        // (b) the hash IS the currently expected one and frameSeq itself regressed. Both are
        // still fatal protocol violations, not a drop; only the message differs.
        if (broker.publish(frame) === "stale") {
          const reason =
            frame.sourceHash !== mounted.sourceHash
              ? `frame for a superseded page (${frame.sourceHash}) arrived after its switch's ready`
              : `non-monotonic frameSeq ${frame.frameSeq}`;
          onPumpFatal(new ProtocolError({ code: "MALFORMED_PROTOCOL", reason }));
          return;
        }
        // design §9.4's first-frame deadline is satisfied by ANY accepted publish: the broker
        // only ever accepts a frame matching its CURRENTLY expected hash (§9.2), so "accepted"
        // here already proves this is the just-mounted page's frame, not a trailing old-page one.
        if (firstFrameTimer !== null) {
          firstFrameTimer.cancel();
          firstFrameTimer = null;
        }
        continue;
      }
      const envelope = decodeControlEnvelope(message.payload);
      if (envelope instanceof ProtocolError) {
        onPumpFatal(envelope);
        return;
      }
      const identityError = checkEnvelopeIdentity(envelope);
      if (identityError instanceof ProtocolError) {
        onPumpFatal(identityError);
        return;
      }
      // THE ONE ENVELOPE THE PUMP INSPECTS BEFORE ROUTING IT (design §9.2). A page switch's
      // `ready` is the exact wire position where the source hash the child stamps into frames
      // changes: everything before it belongs to the old page, everything after it to the new
      // one. Re-seeding here — synchronously, inside the same loop iteration that decoded it —
      // is what makes that true without a reordering window. Doing it from a `.then` on the
      // request table's promise would leave a microtask between this envelope and the frame
      // that follows it, and a frame that misses the guard is FATAL (below), not dropped.
      if (pendingMount !== null && envelope.responseTo === pendingMount.requestId) {
        if (envelope.kind === "ready") {
          mounted = pendingMount.mounted;
          mountedHashes.add(pendingMount.mounted.sourceHash);
          broker.expect(pendingMount.mounted.sourceHash);
          // Arm design §9.4's first-frame deadline HERE — the same synchronous step that just
          // re-seeded the broker's guard, so it can only ever be waiting on the page this
          // `ready` committed to. `mounted.pageSlug` is read now (not off `pendingMount`, which
          // is cleared below) so the closure captures THIS switch's page, not whatever mounts
          // next.
          const expectedSlug = mounted.pageSlug;
          firstFrameTimer = deps.clock.setTimer(FIRST_FRAME_TIMEOUT_MS, () => {
            firstFrameTimer = null;
            onPumpFatal(
              new SupervisorError({
                code: "MOUNT_TIMEOUT",
                reason: `no first frame for page "${expectedSlug}" within ${FIRST_FRAME_TIMEOUT_MS / 1_000}s`,
              }),
            );
          });
        }
        // A non-`ready` reply is the child's typed refusal — clear WITHOUT re-seeding, so the
        // guard keeps naming the page that is actually on screen.
        pendingMount = null;
      }
      if (envelope.responseTo !== undefined) {
        requestTable.resolve(envelope.responseTo, envelope);
        continue;
      }
      if (envelope.kind === "error") {
        onPumpFatal(mapHostError(envelope));
        return;
      }
      if (envelope.kind === "heartbeat") {
        watchdog.feedHeartbeat();
        continue;
      }
      // §8: every other unsolicited (non-response, non-heartbeat, non-error) control
      // envelope is a domain/lifecycle event bound for the Kernel, routed through the
      // bounded inbound mailbox rather than dispatched directly (see this file's
      // `controlMailbox` doc comment for why offer+drain must stay decoupled).
      const offered = controlMailbox.offer({ kind: envelope.kind, envelope });
      if (offered instanceof SupervisorError) {
        controlMailbox.offerTerminal({ kind: envelope.kind, envelope });
        drainMailbox(); // flush ordinary entries + the terminal one before tearing down
        onPumpFatal(offered);
        return;
      }
      scheduleMailboxDrain();
    }
    // inbound ended. If we were still ready, the child exited unexpectedly.
    if (phase === "ready")
      onPumpFatal(
        new SupervisorError({ code: "CHILD_EXITED", reason: "stdout closed while ready" }),
      );
  }

  // The single fatal entry point for the pump AND the watchdog. It always settles
  // outstanding requests with the exact error (so a concurrent stop() resolves
  // immediately with this code, not a 1 s timeout), then — only if still `ready` —
  // owns the async teardown to `failed`. If we are already stopping/stopped/failed,
  // that path owns teardown.
  function onPumpFatal(error: ProtocolError | SupervisorError): void {
    requestTable.clear(error);
    if (phase === "ready") failFromReady(error);
  }

  function failFromReady(error: ProtocolError | SupervisorError): void {
    if (phase !== "ready") return;
    phase = "failed";
    broker.close();
    watchdog.stop();
    void finalizeFatalTeardown(error);
  }

  async function finalizeFatalTeardown(error: ProtocolError | SupervisorError): Promise<void> {
    // teardown(true) kills+reaps the child and calls inbound.return(), which ends
    // the pump loop. We do NOT await pumpTask here: when this runs from inside the
    // pump the await would deadlock; inbound.return() settles it regardless.
    await teardown(true);
    if (deps.onFatal) deps.onFatal(error);
    else
      console.warn(
        "host-supervisor: post-ready fatal outcome with no onFatal sink:",
        error.message,
      );
  }

  // Await the correlated `ready` (§6.6) AND the initial full frame under ONE total
  // 10s deadline, in EITHER order — the 2C child sends `ready` first then the frame,
  // so a version that returned on `ready` alone would always yield firstFrame=null
  // (review Findings #5/#10/#13/#14). Return once BOTH have arrived. A pre-ready
  // `error` envelope is a typed startup failure preserving the child's own code.
  async function awaitReady(
    mountRequestId: string,
    deadlineAt: number,
  ): Promise<
    ProtocolError | SupervisorError | { ready: ControlEnvelope; firstFrame: FrameEnvelope }
  > {
    let ready: ControlEnvelope | null = null;
    let firstFrame: FrameEnvelope | null = null;
    const timeoutError = new SupervisorError({
      code: "MOUNT_TIMEOUT",
      reason: `no ready + first frame for page "${spec.pageSlug}" within ${MOUNT_TIMEOUT_MS / 1_000}s`,
    });
    while (true) {
      const message = await nextInbound(deadlineAt, timeoutError);
      if (message instanceof Error) return message;
      if (message.messageClass === "data") {
        const frame = decodeFrameEnvelope(message.payload);
        if (frame instanceof ProtocolError) return frame;
        const identityError = checkFrameIdentity(frame);
        if (identityError instanceof ProtocolError) return identityError;
        if (firstFrame === null) {
          firstFrame = frame;
          deps.onFrame?.(frame);
        }
        if (ready !== null) return { ready, firstFrame };
        continue;
      }
      const envelope = decodeControlEnvelope(message.payload);
      if (envelope instanceof ProtocolError) return envelope;
      const identityError = checkEnvelopeIdentity(envelope);
      if (identityError instanceof ProtocolError) return identityError;
      if (envelope.kind === "ready" && envelope.responseTo === mountRequestId) {
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

  // §12: a child `error` at mount carries a typed `body.code`. Preserve deterministic
  // protocol codes (SOURCE_HASH_MISMATCH / KIT_API_MISMATCH / MALFORMED_PROTOCOL /
  // OVERSIZED_MESSAGE / FRAME_TOO_LARGE / …) as a ProtocolError so 2D-3 opens the
  // circuit instead of mislabeling them as a restartable DESIGN_RENDER_FAILED
  // (review Findings #7/#12). An untyped/render error stays DESIGN_RENDER_FAILED.
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
      typeof rawReason === "string" ? rawReason.slice(0, 200) : "host error during mount";
    if (typeof code === "string" && PROTOCOL_ERROR_CODES.has(code)) {
      return new ProtocolError({ code: code as ProtocolViolationCode, reason });
    }
    return new SupervisorError({
      code: "DESIGN_RENDER_FAILED",
      reason: typeof code === "string" ? `${code}: ${reason}` : reason,
    });
  }

  function checkEnvelopeIdentity(envelope: ControlEnvelope): ProtocolError | null {
    if (envelope.sessionId !== stable.sessionId || envelope.nonce !== stable.nonce) {
      return new ProtocolError({
        code: "MALFORMED_PROTOCOL",
        reason: "inbound envelope identity does not match the incarnation",
      });
    }
    return null;
  }
  // §9.2: a frame naming any hash this incarnation has LEGITIMATELY mounted is accepted, not
  // just the currently mounted one — stdout is ordered, so the previous page's trailing frames
  // arrive before the switch's `ready` (see `mountedHashes`' own doc comment above).
  function checkFrameIdentity(frame: FrameEnvelope): ProtocolError | null {
    if (
      frame.sessionId !== stable.sessionId ||
      frame.nonce !== stable.nonce ||
      !mountedHashes.has(frame.sourceHash)
    ) {
      return new ProtocolError({
        code: "MALFORMED_PROTOCOL",
        reason: "inbound frame identity does not match the incarnation",
      });
    }
    return null;
  }
  function checkKitApiVersion(kitApiVersion: number): ProtocolError | null {
    if (
      negotiatedDeclaration === null ||
      !negotiatedDeclaration.supportedKitApiVersions.includes(kitApiVersion)
    ) {
      return new ProtocolError({
        code: "KIT_API_MISMATCH",
        reason: `source kit API version ${kitApiVersion} is not in the host supported set`,
      });
    }
    return null;
  }

  // The sole drain of `controlQueue` (§8): dequeues in FIFO/reserved-shutdown-priority
  // order and writes ONE envelope at a time, so writes stay ordered even though several
  // callers may enqueue concurrently. Re-entrant calls are coalesced into the single
  // in-flight loop via `outboundDraining`.
  async function pumpOutbound(): Promise<void> {
    if (outboundDraining) return;
    outboundDraining = true;
    try {
      while (true) {
        const next = controlQueue.dequeue();
        if (next === null) return;
        if (child === null) continue; // torn down mid-drain; nothing left to write to
        const bytes = encodeControlEnvelope(next.envelope);
        if (bytes instanceof ProtocolError) {
          requestTable.supersede(
            next.envelope.requestId ?? "",
            `${next.kind} encode failed [${bytes.code}]`,
          );
          continue;
        }
        const sent = await writeFramed(child, bytes);
        if (sent instanceof SupervisorError) {
          requestTable.supersede(
            next.envelope.requestId ?? "",
            `${next.kind} write failed [${sent.code}]`,
          );
        }
      }
    } finally {
      outboundDraining = false;
    }
  }

  // Extracted so `mount()` can mint its requestId BEFORE the write and register it as the
  // pump's `pendingMount` — the pump needs to recognise the reply as it arrives, not after.
  async function sendRequestWithId(
    requestId: string,
    kind: string,
    body: ControlEnvelope["body"],
    timeoutMs?: number,
  ): Promise<ControlEnvelope | ProtocolError | SupervisorError> {
    if (phase !== "ready" || child === null) {
      return new SupervisorError({
        code: "TRANSPORT_ERROR",
        reason: `${kind} requires a ready session (was "${phase}")`,
      });
    }
    // Reject before send when the table is full (§8), so no envelope is written.
    if (requestTable.size() >= REQUEST_TABLE_CAPACITY) {
      return new SupervisorError({
        code: "TOO_MANY_REQUESTS",
        reason: `request table full (${REQUEST_TABLE_CAPACITY})`,
      });
    }
    const promise = requestTable.register(requestId, kind, timeoutMs);
    const envelope: ControlEnvelope = {
      protocolVersion: 1,
      kind,
      sessionId: stable.sessionId,
      nonce: stable.nonce,
      messageId: nextMessageId(),
      requestId,
      body,
    };
    const enqueued = controlQueue.enqueue({ kind, envelope });
    if (enqueued instanceof SupervisorError) {
      requestTable.supersede(requestId, `${kind} rejected: ${enqueued.reason}`);
      return enqueued;
    }
    if (controlQueue.isBackpressured() && !queueBackpressured) {
      queueBackpressured = true;
      deps.onBackpressureChange?.("backpressured");
    }
    void pumpOutbound();
    return promise;
  }

  async function sendRequest(
    kind: string,
    body: ControlEnvelope["body"],
  ): Promise<ControlEnvelope | ProtocolError | SupervisorError> {
    return sendRequestWithId(nextRequestId(), kind, body);
  }

  const resize = (size: Size) => sendRequest("resize", { size: { w: size.w, h: size.h } });
  const setMode = (mode: InteractionMode) => sendRequest("set-mode", { interactionMode: mode });
  const ping = () => sendRequest("ping", {});

  // Blocker B1: `query-hit`/`query-rect`/`query-describe`/`query-layout` (§7 request family
  // names; §7.1's Kernel-level `pin-anchor` refinement is not a fifth wire kind — see
  // `GeometryQuery`'s doc comment). Correlated through the SAME `sendRequest` path as
  // resize/setMode/ping, so QUERY_TIMEOUT/SUPERSEDED/TOO_MANY_REQUESTS all apply unchanged.
  function wireKindFor(query: GeometryQuery): string {
    return `query-${query.kind}`;
  }
  function queryFieldsOf(query: GeometryQuery): Record<string, string | number> {
    if (query.kind === "hit") return { x: query.x, y: query.y };
    if (query.kind === "layout") return {};
    return { elementId: query.elementId };
  }
  // `requested` is the frameIdentity the CALLER asked about (§7.1). The entire geometry
  // token chain rests on the reply actually being ABOUT that frame — a child that answers
  // against a different (e.g. stale/forged) frame must not pass through as ok:true just
  // because its reply happens to be well-formed (adversarial review item 4).
  function parseGeometryReply(
    envelope: ControlEnvelope,
    requested: FrameIdentity,
  ): ProtocolError | GeometryQueryResult {
    const body = envelope.body;
    if (body.ok === false) {
      const code = body.code;
      if (code !== "STALE_FRAME") {
        return new ProtocolError({
          code: "MALFORMED_PROTOCOL",
          reason: `unexpected ${envelope.kind} refusal code ${String(code)}`,
        });
      }
      const reason = typeof body.reason === "string" ? body.reason : "stale frame";
      return { ok: false, code: "STALE_FRAME", reason };
    }
    const rawIdentity = body.frameIdentity;
    if (rawIdentity === null || typeof rawIdentity !== "object" || Array.isArray(rawIdentity)) {
      return new ProtocolError({
        code: "MALFORMED_PROTOCOL",
        reason: `${envelope.kind} reply missing frameIdentity`,
      });
    }
    const ri = rawIdentity as {
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
      return new ProtocolError({
        code: "MALFORMED_PROTOCOL",
        reason: `${envelope.kind} reply frameIdentity fields must be strings`,
      });
    }
    if (
      ri.sessionId !== requested.sessionId ||
      ri.nonce !== requested.nonce ||
      ri.sourceHash !== requested.sourceHash ||
      ri.frameSeq !== requested.frameSeq
    ) {
      return new ProtocolError({
        code: "MALFORMED_PROTOCOL",
        reason: `${envelope.kind} reply echoed a different frameIdentity than requested`,
      });
    }
    const result = body.result;
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      return new ProtocolError({
        code: "MALFORMED_PROTOCOL",
        reason: `${envelope.kind} reply missing result`,
      });
    }
    return {
      ok: true,
      frameIdentity: {
        sessionId: ri.sessionId,
        nonce: ri.nonce,
        sourceHash: ri.sourceHash,
        frameSeq: ri.frameSeq,
      },
      result: result as Record<string, unknown>,
    };
  }
  async function query(
    frameIdentity: FrameIdentity,
    geometryQuery: GeometryQuery,
  ): Promise<ProtocolError | SupervisorError | GeometryQueryResult> {
    const body: ControlEnvelope["body"] = {
      frameIdentity: {
        sessionId: frameIdentity.sessionId,
        nonce: frameIdentity.nonce,
        sourceHash: frameIdentity.sourceHash,
        frameSeq: frameIdentity.frameSeq,
      },
      ...queryFieldsOf(geometryQuery),
    };
    const result = await sendRequest(wireKindFor(geometryQuery), body);
    if (result instanceof Error) return result;
    return parseGeometryReply(result, frameIdentity);
  }

  // Mount a different page in this live incarnation (design §9.2). Only valid from `ready`;
  // the kit-API check runs (and can refuse) before anything is written to the child, same as
  // the phase check. `pendingMount` is committed by `runPump`'s inline hook the moment the
  // correlated `ready` is SEEN, not when this promise resolves — see that hook's comment.
  //
  // Callers must SERIALIZE mount calls — await one mount's promise before issuing the next.
  // `pendingMount` is a single slot, not a queue: a second `mount()` while one is still
  // outstanding is refused outright (below) rather than silently overwriting the slot, which
  // would orphan the first mount's `ready` (the pump hook would no longer recognise it, so
  // neither `mounted` nor the broker's expected hash would ever move for it) and very likely
  // fatal the incarnation on the next frame the child correctly sends.
  async function mount(
    page: MountPageV1,
  ): Promise<ProtocolError | SupervisorError | ControlEnvelope> {
    if (phase !== "ready" || child === null) {
      return new SupervisorError({
        code: "TRANSPORT_ERROR",
        reason: `mount requires a ready session (was "${phase}")`,
      });
    }
    if (pendingMount !== null) {
      return new SupervisorError({
        code: "TRANSPORT_ERROR",
        reason: `a mount is already in flight (waiting on requestId ${pendingMount.requestId})`,
      });
    }
    const kitError = checkKitApiVersion(page.kitApiVersion);
    if (kitError instanceof ProtocolError) return kitError;

    const requestId = nextRequestId();
    pendingMount = {
      requestId,
      mounted: {
        pageSlug: page.pageSlug,
        sourceHash: page.sourceHash,
        kitApiVersion: page.kitApiVersion,
      },
    };
    // `deterministic` is DERIVED the same way `start()` derives it (`:276`), not hardcoded —
    // it MUST equal `false` for every mode `mount()` is actually reachable from (only
    // `preview`/`historical` ever reach `ready` and call this twice; smoke/export are
    // one-shot), and deriving it from `spec.mode` makes that an enforced fact instead of an
    // assumed one. `buildMountBody` is reused verbatim: it is what enforces "the session's
    // identity hash agrees with the inventory's row for this entry" (`mount-request.ts`),
    // exactly as load-bearing for this mount as for the first.
    const deterministic = spec.mode === "export" || spec.mode === "smoke";
    const body = buildMountBody({ ...spec, ...page }, deterministic);
    if (body instanceof ProtocolError) {
      pendingMount = null;
      return body;
    }
    const result = await sendRequestWithId(requestId, "mount", body, MOUNT_TIMEOUT_MS);
    // design §9.4's mount deadline: the request table's own timer above already bounds "no
    // ready within budget", but its QUERY_TIMEOUT is the table's generic per-request diagnosis
    // — it names neither the page nor treats the incarnation as dead. A mount the child accepted
    // and then never answered is exactly the hang §9.4's watchdog exists for: name the page and
    // kill the incarnation, the same as every other fatal outcome, instead of leaving a live
    // `ready` session silently stuck mid-switch forever.
    if (result instanceof SupervisorError && result.code === "QUERY_TIMEOUT") {
      const timeoutError = new SupervisorError({
        code: "MOUNT_TIMEOUT",
        reason: `no ready for page "${page.pageSlug}" within ${MOUNT_TIMEOUT_MS / 1_000}s`,
      });
      onPumpFatal(timeoutError);
      return timeoutError;
    }
    return result;
  }

  // Kill + reap the child and tear down all resources; used on every failure path.
  async function failWith<E extends ProtocolError | SupervisorError>(error: E): Promise<E> {
    await teardown(true);
    phase = "failed";
    return error;
  }

  // Reap a child under a bounded §9 reap deadline (1s), then re-kill if it somehow
  // has not exited — never an unbounded `await exited` (review Finding #4). D2: a
  // second kill and a repeat `await exited` are safe/idempotent; OS kill is terminal.
  async function reapChild(target: SpawnedChild, forceKill: boolean): Promise<void> {
    if (forceKill) target.kill();
    const { promise: reapDeadline, resolve: resolveReap } = Promise.withResolvers<"reap-timeout">();
    const reapTimer = deps.clock.setTimer(REAP_TIMEOUT_MS, () => resolveReap("reap-timeout"));
    const exit = target.exited.then(() => "exited" as const);
    const reaped = await Promise.race([exit, reapDeadline]);
    reapTimer.cancel();
    if (reaped === "reap-timeout") {
      console.warn("host-supervisor: process did not reap within 1s; re-killing");
      target.kill();
      await target.exited;
    }
  }

  async function teardown(kill: boolean): Promise<void> {
    broker.close(); // ends the frame iterator on every exit path (§10.1, brief invariant 5)
    watchdog.stop(); // idempotent; no-op if never started (pre-ready)
    requestTable.clear(); // settles stragglers; no-op if empty (a post-ready fatal already cleared with the specific error)
    mailboxDrainTimer?.cancel(); // no dangling scheduled drain past teardown (clock.pending() must return to 0)
    mailboxDrainTimer = null;
    firstFrameTimer?.cancel(); // no dangling first-frame deadline past teardown (design §9.4)
    firstFrameTimer = null;
    if (child !== null) await reapChild(child, kill);
    stderrDrain?.stop();
    if (stderrDrain !== null) await stderrDrain.settled;
    await inbound?.return?.(undefined);
  }

  async function stop(): Promise<StopOutcome> {
    if (phase === "stopped") {
      return {
        phase: "stopped",
        forced: false,
        exitCode: child?.exitCode ?? null,
        signalCode: child?.signalCode ?? null,
        reason: "already stopped",
      };
    }
    if (child === null || phase !== "ready") {
      const fromPhase = phase;
      await teardown(true); // teardown() now closes the broker + clears the table + stops the watchdog
      await pumpTask;
      phase = "stopped";
      return {
        phase: "stopped",
        forced: true,
        exitCode: child?.exitCode ?? null,
        signalCode: child?.signalCode ?? null,
        reason: `forced stop from phase ${fromPhase}`,
      };
    }
    phase = "stopping";
    const activeChild = child;

    // Unlike sendRequest, a full table here would still let register() succeed
    // (it only rejects at its OWN capacity), but the shutdown's ack could never be
    // told apart from a coincidental slot reuse in a genuinely full table — and a
    // doomed, uncorrelatable graceful attempt just wastes the 1 s ack deadline
    // before falling back anyway. Check the SAME pre-send guard sendRequest uses
    // (§8) BEFORE writing anything, and force immediately if the table is full.
    if (requestTable.size() >= REQUEST_TABLE_CAPACITY) {
      console.warn("host-supervisor: request table full at stop(); forcing");
      await teardown(true);
      await pumpTask;
      phase = "stopped";
      return {
        phase: "stopped",
        forced: true,
        exitCode: activeChild.exitCode,
        signalCode: activeChild.signalCode,
        reason: "forced: request table full at shutdown",
      };
    }

    // Graceful: register the shutdown so the pump can route its ack, enqueue it into the
    // RESERVED shutdown slot (§8 — always accepted, even at capacity, and dequeued with
    // priority), then await the ack under a dedicated 1 s deadline (§9). An encode/write
    // failure inside `pumpOutbound` settles `ackPromise` via `requestTable.supersede`,
    // which the generic `ack instanceof Error` branch below already forces on — one path
    // for every "the ack never arrived" reason, not three bespoke ones.
    const shutdownRequestId = nextRequestId();
    const ackPromise = requestTable.register(shutdownRequestId, "shutdown");
    const shutdown: ControlEnvelope = {
      protocolVersion: 1,
      kind: "shutdown",
      sessionId: stable.sessionId,
      nonce: stable.nonce,
      messageId: nextMessageId(),
      requestId: shutdownRequestId,
      body: {},
    };
    controlQueue.enqueueShutdown({ kind: "shutdown", envelope: shutdown });
    void pumpOutbound();
    const forcing = await (async (): Promise<null | { reason: string }> => {
      const ack = await raceShutdownAck(ackPromise);
      if (ack instanceof Error) {
        const code =
          ack instanceof SupervisorError || ack instanceof ProtocolError ? ack.code : "UNKNOWN";
        console.warn("host-supervisor: no shutdown-ack, forcing:", ack.message);
        return { reason: `forced: no shutdown-ack [${code}]` };
      }
      activeChild.stdin.end();
      return null;
    })();

    // teardown() reaps (kill iff forced) + closes the broker + clears the table +
    // stops the watchdog + drains stderr + returns inbound. The ack was already
    // routed by the pump (or timed out via raceShutdownAck), so clearing here is safe.
    await teardown(forcing !== null);
    await pumpTask;
    phase = "stopped";
    return {
      phase: "stopped",
      forced: forcing !== null,
      exitCode: activeChild.exitCode,
      signalCode: activeChild.signalCode,
      reason: forcing?.reason ?? "graceful shutdown",
    };
  }

  // The §9 1 s shutdown-ack deadline as a dedicated timer racing the request table's
  // pump-routed ack. On timeout the table entry is left for clear() to settle.
  async function raceShutdownAck(
    ackPromise: Promise<ControlEnvelope | ProtocolError | SupervisorError>,
  ): Promise<ControlEnvelope | ProtocolError | SupervisorError> {
    let settleTimeout!: (error: SupervisorError) => void;
    const timeout = new Promise<SupervisorError>((resolve) => {
      settleTimeout = resolve;
    });
    const timer = deps.clock.setTimer(SHUTDOWN_ACK_TIMEOUT_MS, () =>
      settleTimeout(
        new SupervisorError({ code: "SHUTDOWN_TIMEOUT", reason: "no shutdown-ack within 1s" }),
      ),
    );
    const winner = await Promise.race([ackPromise, timeout]);
    timer.cancel();
    return winner;
  }

  return {
    get identity() {
      return identityOf();
    },
    get phase() {
      return phase;
    },
    start,
    stop,
    frames: broker.frames,
    resize,
    setMode,
    ping,
    query,
    mount,
  };
}
