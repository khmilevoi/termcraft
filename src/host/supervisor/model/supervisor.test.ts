import { describe, expect, test } from "bun:test";

import { PROTOCOL_HARD_LIMITS, ProtocolError } from "../../protocol";
import type { ControlEnvelope, FrameIdentity, RuntimeDeclarationBundleV1 } from "../../protocol";
import type { HostSessionSpec, InteractionMode, PreviewFrame, Size } from "../../types";
import type {
  GeometryQuery,
  HostSession,
  HostSessionDeps,
  ReadyOutcome,
  StopOutcome,
  SupervisorEvent,
} from "../types";
import { createManualClock } from "./clock";
import { SupervisorError } from "./errors";
import { createPreviewRelay } from "./preview-relay";
import { createHostSupervisor } from "./supervisor";

const runtimeDeclaration: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: [],
};

function specFor(overrides: Partial<HostSessionSpec> = {}): HostSessionSpec {
  return {
    mode: "preview",
    interactionMode: "static",
    pageSlug: "dash",
    sourcePath: "/scratch/page.tsx",
    sourceHash: "a".repeat(64),
    kitApiVersion: 1,
    size: { w: 80, h: 24 },
    theme: "dark-default",
    capabilities: { colorDepth: 24 },
    ...overrides,
  };
}

/** A controllable in-memory HostSession + its captured onFatal, driven by the test. */
interface FakeIncarnation {
  readonly spec: HostSessionSpec;
  readonly sessionId: string;
  readonly nonce: string;
  readonly session: HostSession;
  crash(error: ProtocolError | SupervisorError): void;
  pushFrame(seq: string): void;
  readonly startError: ProtocolError | SupervisorError | null;
  stopped: boolean;
  startResolved: boolean;
  /**
   * Per-incarnation call recorders (adversarial review of slice 6D, item 3): the
   * composed `SupervisedPreviewSession.resize`/`setMode`/`query` must delegate to
   * WHICHEVER incarnation is current at call time, never a captured-once reference.
   * These arrays let a test prove a call landed on THIS incarnation and not another.
   */
  readonly resizeCalls: Size[];
  readonly setModeCalls: InteractionMode[];
  readonly queryCalls: { frameIdentity: FrameIdentity; query: GeometryQuery }[];
}

/**
 * A fake incarnation factory. `startFor(attempt)` (1-based across the whole
 * factory) may return a startup error for that incarnation; otherwise start()
 * resolves to a ReadyOutcome. Each incarnation captures its injected onFatal so a
 * test can crash it post-ready.
 */
function fakeFactory(opts?: {
  startFor?: (attempt: number) => ProtocolError | SupervisorError | null;
  /**
   * Overrides the `interactionMode` a `set-mode` reply echoes back (adversarial review
   * of slice 6D, item 4). Defaults to echoing the REQUESTED mode. A test scripts a
   * MISMATCHED echo (§7 "rejection/timeout/stale preserves the prior mode") to prove
   * `ks.interactionMode` updates ONLY from an accepted (matching) response, never
   * optimistically from the request alone.
   */
  setModeEcho?: (requested: InteractionMode) => InteractionMode;
}) {
  const incarnations: FakeIncarnation[] = [];
  let nonceSeq = 0;

  const createSession = (spec: HostSessionSpec, deps: HostSessionDeps): HostSession => {
    nonceSeq += 1;
    const nonce = String(nonceSeq).padStart(32, "0");
    const sessionId = deps.sessionId ?? "no-session-id";
    const attempt = incarnations.length + 1;
    const startError = opts?.startFor?.(attempt) ?? null;
    const relay = createPreviewRelay();
    let phase: HostSession["phase"] = "created";
    const identity = {
      mode: spec.mode,
      pageSlug: spec.pageSlug,
      sourceHash: spec.sourceHash,
      kitApiVersion: spec.kitApiVersion,
      sessionId,
      nonce,
    };
    const ready: ControlEnvelope = {
      protocolVersion: 1,
      kind: "ready",
      sessionId,
      nonce,
      messageId: "1",
      responseTo: "1",
      body: { size: { w: spec.size.w, h: spec.size.h }, interactionMode: spec.interactionMode },
    };
    const inc: FakeIncarnation = {
      spec,
      sessionId,
      nonce,
      startError,
      stopped: false,
      startResolved: false,
      resizeCalls: [],
      setModeCalls: [],
      queryCalls: [],
      session: {
        identity,
        get phase() {
          return phase;
        },
        async start(): Promise<ProtocolError | SupervisorError | ReadyOutcome> {
          inc.startResolved = true;
          if (startError !== null) {
            phase = "failed";
            relay.close();
            return startError;
          }
          phase = "ready";
          const outcome: ReadyOutcome = {
            identity,
            negotiatedLimits: PROTOCOL_HARD_LIMITS,
            ready,
            firstFrame: null,
          };
          return outcome;
        },
        async stop(): Promise<StopOutcome> {
          phase = "stopped";
          inc.stopped = true;
          relay.close();
          return {
            phase: "stopped",
            forced: false,
            exitCode: 0,
            signalCode: null,
            reason: "test stop",
          };
        },
        frames: relay.frames,
        async resize(size) {
          inc.resizeCalls.push(size);
          return ready;
        },
        async setMode(mode) {
          inc.setModeCalls.push(mode);
          const echoed = opts?.setModeEcho ? opts.setModeEcho(mode) : mode;
          return { ...ready, kind: "set-mode", body: { interactionMode: echoed } };
        },
        async ping() {
          return ready;
        },
        async query(frameIdentity, query) {
          inc.queryCalls.push({ frameIdentity, query });
          // `answeredByNonce` is this test's own marker (not a wire field) — it lets a
          // test prove WHICH incarnation actually answered, across a restart.
          return { ok: true, frameIdentity, result: { answeredByNonce: nonce } };
        },
      },
      crash(error) {
        phase = "failed";
        relay.close();
        deps.onFatal?.(error);
      },
      pushFrame(seq) {
        const frame: PreviewFrame = {
          sessionId,
          sourceHash: spec.sourceHash,
          frameSeq: seq,
          width: spec.size.w,
          height: spec.size.h,
          rows: Array.from({ length: spec.size.h }, () => []),
        };
        relay.publish(frame);
      },
    };
    incarnations.push(inc);
    return inc.session;
  };

  return { createSession, incarnations };
}

async function waitUntil(pred: () => boolean, label: string, tries = 500): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`waitUntil timed out: ${label}`);
}

function makeSupervisor(
  factory: ReturnType<typeof fakeFactory>,
  overrides: Partial<Parameters<typeof createHostSupervisor>[0]> = {},
) {
  const clock = createManualClock();
  const events: SupervisorEvent[] = [];
  let sidSeq = 0;
  const supervisor = createHostSupervisor({
    clock,
    runtimeDeclaration,
    spawnFor: () => ({ cmd: ["fake-host"] }),
    spawn: () => new SupervisorError({ code: "SPAWN_FAILED", reason: "unused in fake" }),
    mintSessionId: () => `sid-${(sidSeq += 1)}`,
    onEvent: (e) => events.push(e),
    createSession: factory.createSession,
    ...overrides,
  });
  return { supervisor, clock, events, factory };
}

const crash = () => new SupervisorError({ code: "CHILD_EXITED", reason: "child exited" });

describe("createHostSupervisor — restart budget + backoff + circuit (§10, §14.4)", () => {
  test("crashing four incarnations for one key backs off 250/500/1000ms then opens exactly once, no fifth spawn", async () => {
    const factory = fakeFactory();
    const { supervisor, clock, events } = makeSupervisor(factory);
    const handle = supervisor.preview(specFor());
    if (handle instanceof Error) throw handle;
    await waitUntil(() => handle.state() === "ready", "1st ready");
    expect(factory.incarnations).toHaveLength(1);

    // crash 1 → backoff 250
    factory.incarnations[0]!.crash(crash());
    await waitUntil(() => handle.state() === "backoff", "backoff after crash 1");
    expect(events.filter((e) => e.type === "backoff").at(-1)?.delayMs).toBe(250);
    clock.advance(250);
    await waitUntil(
      () => factory.incarnations.length === 2 && handle.state() === "ready",
      "2nd ready",
    );

    // crash 2 → backoff 500
    factory.incarnations[1]!.crash(crash());
    await waitUntil(() => handle.state() === "backoff", "backoff after crash 2");
    expect(events.filter((e) => e.type === "backoff").at(-1)?.delayMs).toBe(500);
    clock.advance(500);
    await waitUntil(
      () => factory.incarnations.length === 3 && handle.state() === "ready",
      "3rd ready",
    );

    // crash 3 → backoff 1000
    factory.incarnations[2]!.crash(crash());
    await waitUntil(() => handle.state() === "backoff", "backoff after crash 3");
    expect(events.filter((e) => e.type === "backoff").at(-1)?.delayMs).toBe(1000);
    clock.advance(1000);
    await waitUntil(
      () => factory.incarnations.length === 4 && handle.state() === "ready",
      "4th ready",
    );

    // crash 4 → open, no fifth
    factory.incarnations[3]!.crash(crash());
    await waitUntil(() => handle.state() === "circuit-open", "circuit opens after crash 4");
    clock.advance(10_000);
    expect(factory.incarnations).toHaveLength(4);
    const opened = events.filter((e) => e.type === "circuitOpened");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.attempts).toBe(4);
    // every incarnation shared ONE stable sessionId
    expect(new Set(factory.incarnations.map((i) => i.sessionId)).size).toBe(1);
    // fresh nonce per incarnation
    expect(new Set(factory.incarnations.map((i) => i.nonce)).size).toBe(4);
    await supervisor.stopAll();
    expect(clock.pending()).toBe(0);
  });

  test("a deterministic ProtocolError at startup opens the circuit immediately with no backoff/second spawn", async () => {
    const factory = fakeFactory({
      startFor: (n) =>
        n === 1
          ? new ProtocolError({ code: "SOURCE_HASH_MISMATCH", reason: "hash differs" })
          : null,
    });
    const { supervisor, clock, events } = makeSupervisor(factory);
    const handle = supervisor.preview(specFor());
    if (handle instanceof Error) throw handle;
    await waitUntil(() => handle.state() === "circuit-open", "immediate open");
    clock.advance(5_000);
    expect(factory.incarnations).toHaveLength(1);
    expect(events.filter((e) => e.type === "backoff")).toHaveLength(0);
    expect(events.filter((e) => e.type === "circuitOpened")).toHaveLength(1);
    await supervisor.stopAll();
  });

  test("manual retry after an open circuit starts one fresh incarnation and resets the budget", async () => {
    const factory = fakeFactory({
      startFor: (n) =>
        n === 1 ? new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "x" }) : null,
    });
    const { supervisor, clock } = makeSupervisor(factory);
    const handle = supervisor.preview(specFor());
    if (handle instanceof Error) throw handle;
    await waitUntil(() => handle.state() === "circuit-open", "open");
    handle.retry();
    await waitUntil(
      () => factory.incarnations.length === 2 && handle.state() === "ready",
      "fresh incarnation after retry",
    );
    // budget reset: a fresh crash now backs off at 250 again (attempt 1)
    factory.incarnations[1]!.crash(crash());
    await waitUntil(() => handle.state() === "backoff", "backoff after post-retry crash");
    clock.advance(250);
    await waitUntil(
      () => factory.incarnations.length === 3,
      "restart after retry uses 250 backoff",
    );
    await supervisor.stopAll();
  });
});

describe("createHostSupervisor — keys, source change, frames relay (§10, §10.1)", () => {
  test("a source change is a new key with a fresh sessionId + budget; a size change keeps the key/handle", async () => {
    const factory = fakeFactory();
    const { supervisor } = makeSupervisor(factory);
    const a = supervisor.preview(specFor());
    if (a instanceof Error) throw a;
    await waitUntil(() => a.state() === "ready", "a ready");

    // size change, same page + source hash → SAME handle, same sessionId, no new incarnation
    const aResized = supervisor.preview(specFor({ size: { w: 100, h: 30 } }));
    if (aResized instanceof Error) throw aResized;
    expect(aResized.identity.sessionId).toBe(a.identity.sessionId);
    expect(factory.incarnations).toHaveLength(1);

    // source change → new key, new sessionId, its own incarnation + budget
    const b = supervisor.preview(specFor({ sourceHash: "b".repeat(64) }));
    if (b instanceof Error) throw b;
    await waitUntil(() => b.state() === "ready", "b ready");
    expect(b.identity.sessionId).not.toBe(a.identity.sessionId);
    expect(factory.incarnations).toHaveLength(2);
    await supervisor.stopAll();
  });

  test("a frame from the live incarnation reaches the handle's stable relay and survives a restart", async () => {
    const factory = fakeFactory();
    const { supervisor, clock } = makeSupervisor(factory);
    const handle = supervisor.preview(specFor());
    if (handle instanceof Error) throw handle;
    await waitUntil(() => handle.state() === "ready", "ready");
    const iterator = handle.frames[Symbol.asyncIterator]();
    factory.incarnations[0]!.pushFrame("7");
    const first = await iterator.next();
    expect(first.value?.frameSeq).toBe("7");

    // crash + restart; a frame from the NEW incarnation still reaches the SAME iterator
    factory.incarnations[0]!.crash(crash());
    await waitUntil(() => handle.state() === "backoff", "backoff");
    clock.advance(250);
    await waitUntil(
      () => factory.incarnations.length === 2 && handle.state() === "ready",
      "restarted",
    );
    factory.incarnations[1]!.pushFrame("2");
    const second = await iterator.next();
    expect(second.value?.frameSeq).toBe("2");
    await supervisor.stopAll();
  });
});

describe("createHostSupervisor — global limit + HOST_CAPACITY (§13)", () => {
  test("past the global host limit new previews queue, then fail with HOST_CAPACITY when the queue is full", async () => {
    const factory = fakeFactory();
    const { supervisor } = makeSupervisor(factory, { maxGlobalHosts: 2, startQueueCapacity: 1 });
    const h1 = supervisor.preview(specFor({ pageSlug: "p1", sourceHash: "1".repeat(64) }));
    const h2 = supervisor.preview(specFor({ pageSlug: "p2", sourceHash: "2".repeat(64) }));
    if (h1 instanceof Error) throw h1;
    if (h2 instanceof Error) throw h2;
    await waitUntil(() => h1.state() === "ready" && h2.state() === "ready", "two live");
    expect(supervisor.liveCount()).toBe(2);

    // 3rd is queued (limit reached, queue has room)
    const h3 = supervisor.preview(specFor({ pageSlug: "p3", sourceHash: "3".repeat(64) }));
    if (h3 instanceof Error) throw h3;
    expect(h3.state()).toBe("queued");

    // 4th overflows the 1-deep queue → HOST_CAPACITY
    const h4 = supervisor.preview(specFor({ pageSlug: "p4", sourceHash: "4".repeat(64) }));
    expect(h4).toBeInstanceOf(SupervisorError);
    if (h4 instanceof SupervisorError) expect(h4.code).toBe("HOST_CAPACITY");

    // closing a live one drains the queue — the queued h3 starts
    await h1.close();
    await waitUntil(() => h3.state() === "ready", "queued h3 starts after a slot frees");
    await supervisor.stopAll();
  });

  test("a backing-off key keeps its slot: a crash-loop respawn never pushes the live count over the limit (§13)", async () => {
    const factory = fakeFactory();
    const { supervisor, clock } = makeSupervisor(factory, {
      maxGlobalHosts: 2,
      startQueueCapacity: 1,
    });
    const a = supervisor.preview(specFor({ pageSlug: "p1", sourceHash: "1".repeat(64) }));
    const b = supervisor.preview(specFor({ pageSlug: "p2", sourceHash: "2".repeat(64) }));
    if (a instanceof Error) throw a;
    if (b instanceof Error) throw b;
    await waitUntil(() => a.state() === "ready" && b.state() === "ready", "a,b ready");
    const c = supervisor.preview(specFor({ pageSlug: "p3", sourceHash: "3".repeat(64) }));
    if (c instanceof Error) throw c;
    expect(c.state()).toBe("queued");

    // a crashes: it backs off but KEEPS its slot — c must not steal it and overflow the limit
    factory.incarnations[0]!.crash(crash());
    await waitUntil(() => a.state() === "backoff", "a backoff");
    expect(supervisor.liveCount()).toBeLessThanOrEqual(2);
    expect(c.state()).toBe("queued"); // still queued — a's slot was NOT freed
    clock.advance(250);
    await waitUntil(() => a.state() === "ready", "a respawns into its own slot");
    expect(supervisor.liveCount()).toBeLessThanOrEqual(2); // never 3
    expect(c.state()).toBe("queued");

    // only when a truly frees its slot (circuit-open path here via close) does c start
    await a.close();
    await waitUntil(() => c.state() === "ready", "c starts after a closes");
    await supervisor.stopAll();
  });
});

describe("createHostSupervisor — trust + teardown (§13)", () => {
  test("a failing trust check refuses to start a host", () => {
    const factory = fakeFactory();
    const trustError = new SupervisorError({
      code: "TRANSPORT_ERROR",
      reason: "workspace not trusted",
    });
    const { supervisor } = makeSupervisor(factory, { checkTrust: () => trustError });
    const result = supervisor.preview(specFor());
    expect(result).toBe(trustError);
    expect(factory.incarnations).toHaveLength(0);
  });

  test("stopAll stops every live incarnation, cancels timers, and returns to the shell", async () => {
    const factory = fakeFactory();
    const { supervisor, clock } = makeSupervisor(factory);
    const a = supervisor.preview(specFor({ pageSlug: "p1", sourceHash: "1".repeat(64) }));
    const b = supervisor.preview(specFor({ pageSlug: "p2", sourceHash: "2".repeat(64) }));
    if (a instanceof Error) throw a;
    if (b instanceof Error) throw b;
    await waitUntil(() => a.state() === "ready" && b.state() === "ready", "both ready");
    // put one into backoff so a pending timer exists
    factory.incarnations[0]!.crash(crash());
    await waitUntil(() => a.state() === "backoff", "backoff");
    await supervisor.stopAll();
    expect(a.state()).toBe("stopped");
    expect(b.state()).toBe("stopped");
    expect(clock.pending()).toBe(0);
    expect(
      factory.incarnations.every(
        (i) => i.stopped || i.startError !== null || i.session.phase === "failed",
      ),
    ).toBe(true);
  });
});

// --- adversarial review of slice 6D, item 3: the composed PreviewSession delegation
// (`sessionFor` in supervisor.ts) had zero coverage — no test ever called
// resize()/setMode()/query() on a SUPERVISED session, so a `query()` that returned an
// unconditional TRANSPORT_ERROR passed the whole suite. The interesting part is the
// REBINDING across restart: `resize`/`setMode`/`query` must read `ks.current` fresh on
// every call, delegating to whichever incarnation is live NOW, not the one captured when
// the session object was first built.

describe("createHostSupervisor — composed session delegation + restart rebinding (adversarial review item 3)", () => {
  test("resize/setMode/query on the composed session reach the CURRENT incarnation and rebind to the NEW one after an automatic restart", async () => {
    const factory = fakeFactory();
    const { supervisor, clock } = makeSupervisor(factory);
    const handle = supervisor.preview(specFor());
    if (handle instanceof Error) throw handle;
    await waitUntil(() => handle.state() === "ready", "1st ready");
    const first = factory.incarnations[0]!;

    // resize/setMode are fire-and-forget on the UI-facing facade (§7) — wait on the
    // fake incarnation's OWN recorded call, not on a (void) return value.
    handle.resize({ w: 111, h: 22 });
    await waitUntil(() => first.resizeCalls.length === 1, "resize reached the 1st incarnation");
    expect(first.resizeCalls[0]).toEqual({ w: 111, h: 22 });

    handle.setMode("interactive");
    await waitUntil(() => first.setModeCalls.length === 1, "setMode reached the 1st incarnation");
    expect(first.setModeCalls[0]).toBe("interactive");
    // §7: interactionMode updates ONLY from the accepted response, never optimistically.
    await waitUntil(
      () => handle.interactionMode === "interactive",
      "interactionMode updated from the accepted set-mode response",
    );

    const frameIdentity1 = {
      sessionId: handle.identity.sessionId,
      nonce: first.nonce,
      sourceHash: handle.identity.sourceHash,
      frameSeq: "1",
    };
    const query1: GeometryQuery = { kind: "layout" };
    const result1 = await handle.query(frameIdentity1, query1);
    if (result1 instanceof Error) throw result1;
    if (!result1.ok) throw new Error("expected ok:true");
    expect(result1.result.answeredByNonce).toBe(first.nonce); // answered by the 1st incarnation
    expect(first.queryCalls).toEqual([{ frameIdentity: frameIdentity1, query: query1 }]);

    // Crash + automatic restart. The composed session object stays the SAME reference
    // (blocker B4), but its delegation target must move to the fresh incarnation.
    first.crash(crash());
    await waitUntil(() => handle.state() === "backoff", "backoff");
    clock.advance(250);
    await waitUntil(
      () => factory.incarnations.length === 2 && handle.state() === "ready",
      "2nd ready",
    );
    const second = factory.incarnations[1]!;
    expect(second).not.toBe(first);

    handle.resize({ w: 5, h: 5 });
    await waitUntil(
      () => second.resizeCalls.length === 1,
      "resize now reaches the 2nd incarnation",
    );
    expect(first.resizeCalls).toHaveLength(1); // the dead 1st incarnation never got a second call

    const frameIdentity2 = {
      sessionId: handle.identity.sessionId,
      nonce: second.nonce,
      sourceHash: handle.identity.sourceHash,
      frameSeq: "1",
    };
    const result2 = await handle.query(frameIdentity2, query1);
    if (result2 instanceof Error) throw result2;
    if (!result2.ok) throw new Error("expected ok:true");
    expect(result2.result.answeredByNonce).toBe(second.nonce); // answered by the NEW incarnation
    expect(first.queryCalls).toHaveLength(1); // still only the pre-crash call
    expect(second.queryCalls).toHaveLength(1);

    // The SAME session object is what `preview()` still hands back for this key.
    const reacquired = supervisor.preview(specFor());
    if (reacquired instanceof Error) throw reacquired;
    expect(reacquired).toBe(handle);

    await supervisor.stopAll();
  });

  test("resize/setMode/query on a session with no live incarnation (backoff) are dropped/rejected, never delegated to a dead incarnation", async () => {
    const factory = fakeFactory();
    const { supervisor, clock } = makeSupervisor(factory);
    const handle = supervisor.preview(specFor());
    if (handle instanceof Error) throw handle;
    await waitUntil(() => handle.state() === "ready", "ready");
    const first = factory.incarnations[0]!;

    first.crash(crash());
    await waitUntil(() => handle.state() === "backoff", "backoff — no live incarnation right now");

    handle.resize({ w: 1, h: 1 }); // must not throw, must not touch the dead incarnation
    handle.setMode("interactive");
    const frameIdentity = {
      sessionId: handle.identity.sessionId,
      nonce: first.nonce,
      sourceHash: handle.identity.sourceHash,
      frameSeq: "1",
    };
    const result = await handle.query(frameIdentity, { kind: "layout" });
    expect(result).toBeInstanceOf(SupervisorError);
    if (result instanceof SupervisorError) expect(result.code).toBe("TRANSPORT_ERROR");
    expect(first.resizeCalls).toHaveLength(0);
    expect(first.setModeCalls).toHaveLength(0);
    expect(first.queryCalls).toHaveLength(0);

    clock.advance(250);
    await waitUntil(() => handle.state() === "ready", "restarted");
    await supervisor.stopAll();
  });
});

// --- adversarial review of slice 6D, item 4: `sessionFor`'s `setMode` handler carries
// its own comment promising `interactionMode` is "updated only from an ACCEPTED
// ready/set-mode response ... never optimistically" — but no test ever scripted a
// set-mode reply that DISAGREES with the requested mode. Replacing the guarded
// `if (result.body.interactionMode === next) ks.interactionMode = next` with an
// unconditional assignment passed the whole suite before this test existed.

describe("createHostSupervisor — interactionMode updates only from an accepted response (adversarial review item 4)", () => {
  test("a set-mode reply that echoes a MISMATCHED mode does not update interactionMode", async () => {
    // The fake always echoes back "static" — i.e. every set-mode request is answered
    // as if rejected/stale, regardless of what was requested (§7).
    const factory = fakeFactory({ setModeEcho: () => "static" });
    const { supervisor } = makeSupervisor(factory);
    const handle = supervisor.preview(specFor({ interactionMode: "static" }));
    if (handle instanceof Error) throw handle;
    await waitUntil(() => handle.state() === "ready", "ready");
    const first = factory.incarnations[0]!;
    expect(handle.interactionMode).toBe("static");

    handle.setMode("interactive");
    await waitUntil(() => first.setModeCalls.length === 1, "setMode reached the incarnation");
    expect(first.setModeCalls[0]).toBe("interactive"); // the REQUEST carried the new mode...
    // ...but let the fire-and-forget `.then()` settle before asserting the effect —
    // it runs on a microtask after `current.setMode(next)` resolves.
    await Promise.resolve();
    await Promise.resolve();
    expect(handle.interactionMode).toBe("static"); // ...the MISMATCHED reply must not adopt it
    await supervisor.stopAll();
  });

  test("a set-mode reply that echoes the REQUESTED mode does update interactionMode (control case)", async () => {
    const factory = fakeFactory(); // default: echoes back whatever was requested
    const { supervisor } = makeSupervisor(factory);
    const handle = supervisor.preview(specFor({ interactionMode: "static" }));
    if (handle instanceof Error) throw handle;
    await waitUntil(() => handle.state() === "ready", "ready");
    expect(handle.interactionMode).toBe("static");

    handle.setMode("interactive");
    await waitUntil(
      () => handle.interactionMode === "interactive",
      "interactionMode updated from the accepted set-mode response",
    );
    await supervisor.stopAll();
  });
});
