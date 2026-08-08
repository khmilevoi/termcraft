import { describe, expect, test } from "bun:test";

import { PROTOCOL_HARD_LIMITS, ProtocolError } from "../../protocol";
import type {
  ControlEnvelope,
  FrameEnvelope,
  FrameIdentity,
  HostHelloV1,
  RuntimeDeclarationBundleV1,
} from "../../protocol";
import type { HostSessionSpec, InteractionMode, PreviewFrame, Size } from "../../types";
import type {
  GeometryQuery,
  HostSession,
  HostSessionDeps,
  MountPageV1,
  ReadyOutcome,
  SpawnCommand,
  SpawnFn,
  StopOutcome,
  SupervisorEvent,
} from "../types";
import { createManualClock } from "./clock";
import { SupervisorError } from "./errors";
import { createPreviewRelay } from "./preview-relay";
import { createScriptedChild, frameControl, frameFrame, frameHostHello } from "./scripted-child";
import type { ScriptedChild } from "./scripted-child";
import { createHostSupervisor } from "./supervisor";
import { HANDSHAKE_TIMEOUT_MS } from "./timeouts";
import { readInbound } from "./transport";

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
    treeRoot: "/scratch/design",
    entryRelPath: "pages/dash.tsx",
    expectedFiles: [{ relPath: "pages/dash.tsx", sha256: "a".repeat(64) }],
    sourceHash: "a".repeat(64),
    treeRevision: "a".repeat(64),
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
  /** Every `mount()` this incarnation received (design-tree phase 3 Task 5). */
  readonly mountCalls: MountPageV1[];
  /** Single-shot override: the next `mount()` call resolves to this instead of `ready`. */
  nextMountResult: ProtocolError | SupervisorError | null;
  /**
   * When true, `mount()` parks instead of resolving — proving `reconcileMount` never issues a
   * SECOND concurrent `mount()` while one is in flight (design-tree phase 3 Task 5;
   * `session.ts`'s real `mount()` refuses a concurrent call with `TRANSPORT_ERROR` rather than
   * queuing it). Resolve every parked call with `resolvePendingMounts()`.
   */
  deferMounts: boolean;
  resolvePendingMounts(): void;
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
    let deferMounts = false;
    const pendingMountResolvers: (() => void)[] = [];
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
      mountCalls: [],
      nextMountResult: null,
      get deferMounts() {
        return deferMounts;
      },
      set deferMounts(value: boolean) {
        deferMounts = value;
      },
      resolvePendingMounts() {
        const resolvers = pendingMountResolvers.splice(0);
        for (const resolve of resolvers) resolve();
      },
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
        async mount(page) {
          inc.mountCalls.push(page);
          if (deferMounts) {
            await new Promise<void>((resolve) => pendingMountResolvers.push(resolve));
          }
          if (inc.nextMountResult !== null) {
            const result = inc.nextMountResult;
            inc.nextMountResult = null;
            return result;
          }
          return {
            ...ready,
            body: {
              size: { w: page.size.w, h: page.size.h },
              interactionMode: page.interactionMode,
            },
          };
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
    // `deps.spawn` above always errors — fine for the fake incarnation factory, which never
    // calls it, but the warm spare pool (design-tree phase 3 Task 6) DOES call it after every
    // ready, and would otherwise log a "spawn failed" warning on every test in this file that
    // reaches ready. Tests that actually exercise the spare pool override this explicitly.
    spareCapacity: 0,
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

  test("circuitOpened carries the failing incarnation's code and message, not only the policy reason", async () => {
    // DESIGN_RENDER_FAILED is not in restart-policy.ts's deterministic set, so an
    // incarnation that always fails to start with it drives the SAME 250/500/1000ms
    // budget-exhaustion path as the first test above — proving circuitOpened carries the
    // FAILING incarnation's own code/message (from `error`), distinct from `reason` (the
    // policy's own verdict text).
    const renderFailure = new SupervisorError({
      code: "DESIGN_RENDER_FAILED",
      reason: "PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function",
    });
    const factory = fakeFactory({ startFor: () => renderFailure });
    const { supervisor, clock, events } = makeSupervisor(factory);
    const handle = supervisor.preview(specFor());
    if (handle instanceof Error) throw handle;

    await waitUntil(() => handle.state() === "backoff", "backoff after 1st failed start");
    clock.advance(250);
    await waitUntil(
      () => factory.incarnations.length === 2 && handle.state() === "backoff",
      "backoff after 2nd failed start",
    );
    clock.advance(500);
    await waitUntil(
      () => factory.incarnations.length === 3 && handle.state() === "backoff",
      "backoff after 3rd failed start",
    );
    clock.advance(1000);
    await waitUntil(
      () => factory.incarnations.length === 4 && handle.state() === "circuit-open",
      "circuit opens after 4th failed start",
    );

    const opened = events.find((e) => e.type === "circuitOpened");
    expect(opened).toBeDefined();
    expect(opened?.failureCode).toBe("DESIGN_RENDER_FAILED");
    expect(opened?.failureMessage).toBe("PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function");
    // The policy reason is still reported — the two are different facts.
    expect(opened?.reason).toContain("restart budget exhausted");

    // "populated on circuitOpened ONLY" (types.ts's contract) is what lets a consumer treat
    // the presence of failureCode as the signal that a preview stopped for good. The three
    // backoff events on the way here carry the same `error`, so nothing but the emit site's
    // own branching keeps them clean — assert it rather than trust it.
    const backoffs = events.filter((e) => e.type === "backoff");
    expect(backoffs).toHaveLength(3);
    for (const event of backoffs) {
      expect(event.failureCode).toBeUndefined();
      expect(event.failureMessage).toBeUndefined();
    }

    await supervisor.stopAll();
  });
});

describe("createHostSupervisor — keys, source change, frames relay (§10, §10.1)", () => {
  /**
   * RE-KEYED ON `treeRevision` (design-tree phase 2 Task 10). The key used to be
   * `(pageSlug, sourceHash)` — the ENTRY file's own hash — so a turn that rewrote a module the
   * page merely IMPORTS matched the existing key, `preview()` handed back the SAME child, and
   * that child's module registry still held the old shared module. Nothing re-mounted, so the
   * user's edit never reached the screen. `treeRevision` covers every file in the tree, so a
   * shared-module edit is a new key exactly like an entry-file edit already was; `sourceHash`
   * stays on the spec as the mount's own verification against the entry's inventory row
   * (`mount-request.ts`), which is a different question from session identity.
   */
  test("a tree-revision change is a new key with a fresh sessionId + budget; a size change keeps the key/handle", async () => {
    const factory = fakeFactory();
    const { supervisor } = makeSupervisor(factory);
    const a = supervisor.preview(specFor());
    if (a instanceof Error) throw a;
    await waitUntil(() => a.state() === "ready", "a ready");

    // size change, same page + tree revision → SAME handle, same sessionId, no new incarnation
    const aResized = supervisor.preview(specFor({ size: { w: 100, h: 30 } }));
    if (aResized instanceof Error) throw aResized;
    expect(aResized.identity.sessionId).toBe(a.identity.sessionId);
    expect(factory.incarnations).toHaveLength(1);

    // an IDENTICAL spec reuses the one incarnation too — the key is the whole comparison
    const aAgain = supervisor.preview(specFor());
    if (aAgain instanceof Error) throw aAgain;
    expect(aAgain.identity.sessionId).toBe(a.identity.sessionId);
    expect(factory.incarnations).toHaveLength(1);

    // tree-revision change → new key, new sessionId, its own incarnation + budget
    const b = supervisor.preview(specFor({ treeRevision: "b".repeat(64) }));
    if (b instanceof Error) throw b;
    await waitUntil(() => b.state() === "ready", "b ready");
    expect(b.identity.sessionId).not.toBe(a.identity.sessionId);
    expect(factory.incarnations).toHaveLength(2);
    await supervisor.stopAll();
  });

  /**
   * THE SHARED-MODULE EDIT, at the host's own layer: the entry file is byte-identical (same
   * `sourceHash`) and only the tree moved. Under the old key this returned the LIVE child
   * unchanged — the exact half of the defect the UI-side memo fix alone could not reach.
   */
  test("a spec differing ONLY in treeRevision produces a second incarnation, never the live one", async () => {
    const factory = fakeFactory();
    const { supervisor } = makeSupervisor(factory);
    const before = supervisor.preview(specFor({ treeRevision: "1".repeat(64) }));
    if (before instanceof Error) throw before;
    await waitUntil(() => before.state() === "ready", "before ready");

    const after = supervisor.preview(specFor({ treeRevision: "2".repeat(64) }));
    if (after instanceof Error) throw after;
    await waitUntil(() => after.state() === "ready", "after ready");

    expect(after.identity.sourceHash).toBe(before.identity.sourceHash);
    expect(after.identity.sessionId).not.toBe(before.identity.sessionId);
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

describe("createHostSupervisor — one incarnation per tree revision, in-process page switch (design-tree §9.2, phase 3 Task 5)", () => {
  test("two pages of one revision share ONE incarnation and one sessionId", async () => {
    const factory = fakeFactory();
    const { supervisor } = makeSupervisor(factory);
    const a = supervisor.preview(specFor({ pageSlug: "a" }));
    const b = supervisor.preview(specFor({ pageSlug: "b" }));
    if (a instanceof Error) throw a;
    if (b instanceof Error) throw b;
    expect(b).toBe(a); // the same facade object
    await waitUntil(() => a.state() === "ready", "ready");
    expect(supervisor.liveCount()).toBe(1);
    expect(factory.incarnations).toHaveLength(1);
    await supervisor.stopAll();
  });

  test("a page switch on a ready incarnation issues a mount, never a spawn", async () => {
    const factory = fakeFactory();
    const { supervisor } = makeSupervisor(factory);
    const handle = supervisor.preview(specFor({ pageSlug: "a" }));
    if (handle instanceof Error) throw handle;
    await waitUntil(() => handle.state() === "ready", "a ready");

    const switched = supervisor.preview(specFor({ pageSlug: "b" }));
    if (switched instanceof Error) throw switched;
    await waitUntil(() => factory.incarnations[0]!.mountCalls.length === 1, "mount issued");
    expect(factory.incarnations[0]!.mountCalls.map((m) => m.pageSlug)).toEqual(["b"]);
    expect(factory.incarnations).toHaveLength(1); // no second spawn
    await supervisor.stopAll();
  });

  test("a page switch requested BEFORE ready is reconciled once the incarnation is ready", async () => {
    const factory = fakeFactory();
    const { supervisor } = makeSupervisor(factory);
    const a = supervisor.preview(specFor({ pageSlug: "a" })); // starting
    if (a instanceof Error) throw a;
    const b = supervisor.preview(specFor({ pageSlug: "b" })); // still starting, same key
    if (b instanceof Error) throw b;
    expect(b).toBe(a);

    await waitUntil(() => a.state() === "ready", "ready");
    await waitUntil(() => factory.incarnations[0]!.mountCalls.length === 1, "switch reconciled");
    // the incarnation's own start() mounted "a" (whatever `ks.spec` said when it was spawned);
    // the ONLY mount() call recorded is the reconciling one, for "b".
    expect(factory.incarnations[0]!.mountCalls.map((m) => m.pageSlug)).toEqual(["b"]);
    expect(factory.incarnations).toHaveLength(1);
    await supervisor.stopAll();
  });

  test("re-selecting the page already mounted issues no mount at all", async () => {
    const factory = fakeFactory();
    const { supervisor } = makeSupervisor(factory);
    const handle = supervisor.preview(specFor({ pageSlug: "a", size: { w: 80, h: 24 } }));
    if (handle instanceof Error) throw handle;
    await waitUntil(() => handle.state() === "ready", "ready");

    const again = supervisor.preview(specFor({ pageSlug: "a", size: { w: 100, h: 30 } }));
    if (again instanceof Error) throw again;
    await new Promise((resolve) => setTimeout(resolve, 0)); // let any fire-and-forget settle
    expect(factory.incarnations[0]!.mountCalls).toEqual([]); // a size change is a resize, not a re-mount
    await supervisor.stopAll();
  });

  test("a page switch requested while one is already in flight does not double-mount; the last request wins", async () => {
    const factory = fakeFactory();
    const { supervisor } = makeSupervisor(factory);
    const handle = supervisor.preview(specFor({ pageSlug: "a" }));
    if (handle instanceof Error) throw handle;
    await waitUntil(() => handle.state() === "ready", "a ready");

    factory.incarnations[0]!.deferMounts = true;
    const toB = supervisor.preview(specFor({ pageSlug: "b" }));
    if (toB instanceof Error) throw toB;
    await waitUntil(() => factory.incarnations[0]!.mountCalls.length === 1, "mount to b issued");

    // A third page requested while the switch to "b" is still parked. `session.ts`'s real
    // mount() refuses a concurrent call with TRANSPORT_ERROR rather than queuing it, so this
    // must NOT issue a second concurrent mount() — that refusal would otherwise be misread as
    // an incarnation failure.
    const toC = supervisor.preview(specFor({ pageSlug: "c" }));
    if (toC instanceof Error) throw toC;
    expect(factory.incarnations[0]!.mountCalls).toHaveLength(1); // still only "b"'s

    factory.incarnations[0]!.resolvePendingMounts();
    // The mount to "b" resolves; reconcileMount notices the spec has since moved to "c" and
    // issues the correcting mount on its own — no second spawn, no fatal.
    await waitUntil(() => factory.incarnations[0]!.mountCalls.length === 2, "mount to c issued");
    expect(factory.incarnations[0]!.mountCalls.map((m) => m.pageSlug)).toEqual(["b", "c"]);
    expect(factory.incarnations).toHaveLength(1);
    expect(handle.state()).toBe("ready");
    await supervisor.stopAll();
  });

  test("a mount failure fails the incarnation and names the page that was mounting", async () => {
    const factory = fakeFactory();
    const { supervisor, events } = makeSupervisor(factory);
    const handle = supervisor.preview(specFor({ pageSlug: "a" }));
    if (handle instanceof Error) throw handle;
    await waitUntil(() => handle.state() === "ready", "a ready");

    factory.incarnations[0]!.nextMountResult = new SupervisorError({
      code: "DESIGN_RENDER_FAILED",
      reason: "boom",
    });
    const switched = supervisor.preview(specFor({ pageSlug: "b" }));
    if (switched instanceof Error) throw switched;
    await waitUntil(() => handle.state() === "backoff", "mount failure enters the budgeted path");
    expect(events.at(-1)).toMatchObject({ type: "backoff", pageSlug: "b" });
    await supervisor.stopAll();
  });

  test("the restart budget belongs to (revision, page), not to the revision", async () => {
    const factory = fakeFactory({
      startFor: (n) =>
        n <= 3 ? new SupervisorError({ code: "CHILD_EXITED", reason: "boom" }) : null,
    });
    const { supervisor, clock, events } = makeSupervisor(factory);
    const handle = supervisor.preview(specFor({ pageSlug: "a" }));
    if (handle instanceof Error) throw handle;

    // "a"'s 1st failure → backoff 250 (attempt 1 of restartKeyOf("R a")).
    await waitUntil(() => handle.state() === "backoff", "backoff after a's 1st failure");

    // switch to page "b" of the SAME revision WHILE "a" is backing off, before its respawn.
    const switched = supervisor.preview(specFor({ pageSlug: "b" }));
    if (switched instanceof Error) throw switched;
    clock.advance(250);

    // The respawn mounts "b" (specAtSpawn follows `ks.spec`, already switched) and fails too.
    // If the restart budget were shared per REVISION (the pre-Task-5 shape), this would be
    // counted as the key's SECOND failure and back off at 500ms. Because the budget is keyed by
    // `(revision, page)`, this is "b"'s OWN FIRST failure, so it backs off at 250ms again.
    await waitUntil(
      () => factory.incarnations.length === 2 && handle.state() === "backoff",
      "backoff after b's 1st failure",
    );
    expect(events.filter((e) => e.type === "backoff").at(-1)).toMatchObject({
      pageSlug: "b",
      delayMs: 250,
    });
    await supervisor.stopAll();
  });

  test("switching pages while the circuit is open, then retrying, starts the NEW page with a fresh budget", async () => {
    const factory = fakeFactory({
      startFor: (n) =>
        n <= 4 ? new SupervisorError({ code: "CHILD_EXITED", reason: "boom" }) : null,
    });
    const { supervisor, clock } = makeSupervisor(factory);
    const handle = supervisor.preview(specFor({ pageSlug: "a" }));
    if (handle instanceof Error) throw handle;

    await waitUntil(() => handle.state() === "backoff", "1st failure");
    clock.advance(250);
    await waitUntil(
      () => factory.incarnations.length === 2 && handle.state() === "backoff",
      "2nd failure",
    );
    clock.advance(500);
    await waitUntil(
      () => factory.incarnations.length === 3 && handle.state() === "backoff",
      "3rd failure",
    );
    clock.advance(1000);
    await waitUntil(
      () => factory.incarnations.length === 4 && handle.state() === "circuit-open",
      "a's circuit opens on the 4th failure",
    );

    // The user gives up on "a" and switches to "b" while the circuit is still open. `preview`
    // folds the new page into `ks.spec`; `reconcileMount` defers because the key is not ready.
    const switched = supervisor.preview(specFor({ pageSlug: "b" }));
    if (switched instanceof Error) throw switched;
    expect(switched).toBe(handle); // same key, same facade

    switched.retry();
    // "b" has never failed, so its restart key's budget is untouched by "a"'s exhaustion — the
    // retry starts a genuinely fresh incarnation for "b", not a resumption of "a"'s failed one.
    await waitUntil(
      () => factory.incarnations.length === 5 && handle.state() === "ready",
      "retry starts the NEW page, not a's exhausted incarnation",
    );
    await supervisor.stopAll();
  });
});

describe("createHostSupervisor — global limit + HOST_CAPACITY (§13)", () => {
  test("past the global host limit new previews queue, then fail with HOST_CAPACITY when the queue is full", async () => {
    const factory = fakeFactory();
    const { supervisor } = makeSupervisor(factory, { maxGlobalHosts: 2, startQueueCapacity: 1 });
    // Since design-tree phase 3 Task 5 the session key is `treeRevision` ALONE (§9.2): four
    // DIFFERENT revisions are what buys four candidate incarnations here, not four pageSlugs of
    // one revision, which would now share a single incarnation.
    const h1 = supervisor.preview(specFor({ treeRevision: "1".repeat(64) }));
    const h2 = supervisor.preview(specFor({ treeRevision: "2".repeat(64) }));
    if (h1 instanceof Error) throw h1;
    if (h2 instanceof Error) throw h2;
    await waitUntil(() => h1.state() === "ready" && h2.state() === "ready", "two live");
    expect(supervisor.liveCount()).toBe(2);

    // 3rd is queued (limit reached, queue has room)
    const h3 = supervisor.preview(specFor({ treeRevision: "3".repeat(64) }));
    if (h3 instanceof Error) throw h3;
    expect(h3.state()).toBe("queued");

    // 4th overflows the 1-deep queue → HOST_CAPACITY
    const h4 = supervisor.preview(specFor({ treeRevision: "4".repeat(64) }));
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
    // Three DIFFERENT tree revisions (§9.2, Task 5) — the session key is `treeRevision` alone.
    const a = supervisor.preview(specFor({ treeRevision: "1".repeat(64) }));
    const b = supervisor.preview(specFor({ treeRevision: "2".repeat(64) }));
    if (a instanceof Error) throw a;
    if (b instanceof Error) throw b;
    await waitUntil(() => a.state() === "ready" && b.state() === "ready", "a,b ready");
    const c = supervisor.preview(specFor({ treeRevision: "3".repeat(64) }));
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
    // Two DIFFERENT tree revisions (§9.2, Task 5) — proves stopAll iterates every KEY, not just
    // the one incarnation a shared-revision pair would collapse to.
    const a = supervisor.preview(specFor({ treeRevision: "1".repeat(64) }));
    const b = supervisor.preview(specFor({ treeRevision: "2".repeat(64) }));
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

// --- Task 11 (resize-race-diagnosis.md): `preview.sessionReady` (and the mirror's
// `phase: "ready"`, and the capability guard's `live`) fires the instant
// `hostSupervisor.preview()` returns a session object — while `ks.state` is still
// "starting" and the real incarnation is negotiating/mounting, 661ms before the child
// can accept control requests in the captured run. A resize requested in that window
// reached `sessionFor`'s old fire-and-forget `resize()`, which called straight into the
// not-yet-ready `HostSession`; `session.ts`'s `sendRequest` phase gate ("resize requires
// a ready session") refused it before it ever reached `controlQueue`, and the refusal was
// swallowed (fire-and-forget). These tests use a REAL `createHostSession` (no fake
// `createSession` override) driven by a scripted child the test answers manually, so the
// phase gate exercised is the genuine one from `session.ts`, not a hand-rolled stand-in —
// only that makes the RED failure below prove the diagnosed defect rather than a fake's
// leniency.

/**
 * A child that answers `client.hello`/`mount` only when the test explicitly tells it to
 * (`replyHello`/`replyReady`), so the incarnation parks in "negotiating"/"mounting" for as
 * long as the test needs — the same technique `session.test.ts`'s HANDSHAKE_TIMEOUT/
 * MOUNT_TIMEOUT tests use, just driven manually instead of by a timeout. Every `resize`
 * control envelope that reaches the wire is recorded (and acked), so a test can assert
 * exactly how many resizes were dispatched, and with what size. The `mount` request's
 * OWN `body.size` is recorded too (`mountedSize()`) — fix round 2's fold test asserts
 * against this, not against a resize envelope, because the fold changes the MOUNT
 * geometry, not a post-mount control request.
 */
function parkingChild(spec: HostSessionSpec): {
  child: ScriptedChild;
  identity: () => { sessionId: string; nonce: string } | null;
  hasMountRequest: () => boolean;
  mountedSize: () => Size | null;
  replyHello: () => void;
  replyReady: () => void;
  resizeWrites: () => Size[];
} {
  const child = createScriptedChild();
  let id: { sessionId: string; nonce: string } | null = null;
  let mountRequestId: string | null = null;
  let mountedSize: Size | null = null;
  const resizeWrites: Size[] = [];
  let messageId = 1n;
  const nextId = () => (messageId++).toString();

  child.onWrite = (bytes) => {
    void (async () => {
      // reuse readInbound over a throwaway child carrying just these bytes, exactly as
      // session.test.ts's own respondingChild and preview-test-host.ts's livePreviewChild do.
      const carrier = createScriptedChild();
      carrier.emit(bytes);
      carrier.endStdout();
      for await (const message of readInbound(carrier)) {
        if (message instanceof Error) return;
        if (message.messageClass !== "control") return;
        const raw = JSON.parse(new TextDecoder().decode(message.payload)) as ControlEnvelope & {
          kind: string;
        };
        if (raw.kind === "client.hello" && id === null) {
          id = { sessionId: raw.sessionId, nonce: raw.nonce };
          return;
        }
        if (raw.kind === "mount") {
          mountRequestId = raw.requestId ?? null;
          mountedSize = raw.body.size as unknown as Size;
          return;
        }
        if (raw.kind === "resize" && id !== null) {
          resizeWrites.push(raw.body.size as unknown as Size);
          const ack: ControlEnvelope = {
            protocolVersion: 1,
            kind: "resize",
            sessionId: id.sessionId,
            nonce: id.nonce,
            messageId: nextId(),
            responseTo: raw.requestId,
            body: { size: raw.body.size! },
          };
          const framed = frameControl(ack);
          if (!(framed instanceof ProtocolError)) child.emit(framed);
          return;
        }
        if (raw.kind === "shutdown" && id !== null) {
          // stopAll()/close() drive a graceful shutdown from "ready" (session.ts's
          // stop()) — ack it and exit, exactly as livePreviewChild does, or a test's
          // stopAll() would hang on the manual clock's un-advanced 1s ack deadline.
          const ack: ControlEnvelope = {
            protocolVersion: 1,
            kind: "shutdown-ack",
            sessionId: id.sessionId,
            nonce: id.nonce,
            messageId: nextId(),
            responseTo: raw.requestId,
            body: { ok: true },
          };
          const framed = frameControl(ack);
          if (!(framed instanceof ProtocolError)) child.emit(framed);
          child.simulateExit({ code: 0 });
        }
      }
    })();
  };

  return {
    child,
    identity: () => id,
    hasMountRequest: () => mountRequestId !== null,
    mountedSize: () => mountedSize,
    replyHello: () => {
      if (id === null) throw new Error("parkingChild: client.hello not received yet");
      const hostHello: HostHelloV1 = {
        framingVersion: 1,
        kind: "host.hello",
        sessionId: id.sessionId,
        nonce: id.nonce,
        selectedFramingVersion: 1,
        selectedProtocolVersion: 1,
        runtimeDeclaration,
        limits: PROTOCOL_HARD_LIMITS,
      };
      const framed = frameHostHello(hostHello);
      if (framed instanceof ProtocolError) throw framed;
      child.emit(framed);
    },
    replyReady: () => {
      if (id === null || mountRequestId === null) {
        throw new Error("parkingChild: mount not received yet");
      }
      const ready: ControlEnvelope = {
        protocolVersion: 1,
        kind: "ready",
        sessionId: id.sessionId,
        nonce: id.nonce,
        messageId: nextId(),
        responseTo: mountRequestId,
        body: { size: { w: spec.size.w, h: spec.size.h }, interactionMode: spec.interactionMode },
      };
      const readyFramed = frameControl(ready);
      if (readyFramed instanceof ProtocolError) throw readyFramed;
      child.emit(readyFramed);
      // awaitReady (session.ts) waits for BOTH `ready` AND the first data-class frame
      // under one deadline — the real 2C child always sends ready then the frame, so the
      // test double must too, or the incarnation never reaches "ready" (hangs instead).
      const frame: FrameEnvelope = {
        protocolVersion: 1,
        kind: "frame",
        sessionId: id.sessionId,
        nonce: id.nonce,
        sourceHash: spec.sourceHash,
        frameSeq: "1",
        width: spec.size.w,
        height: spec.size.h,
        rows: Array.from({ length: spec.size.h }, () => []),
      };
      const frameFramed = frameFrame(frame);
      if (frameFramed instanceof ProtocolError) throw frameFramed;
      child.emit(frameFramed);
    },
    resizeWrites: () => resizeWrites,
  };
}

describe("createHostSupervisor — pre-ready resize is buffered, not dropped (Task 11)", () => {
  test("a resize requested while starting (negotiating/mounting) is buffered and flushed exactly once when ready", async () => {
    const spec = specFor();
    const host = parkingChild(spec);
    const clock = createManualClock();
    const supervisor = createHostSupervisor({
      clock,
      runtimeDeclaration,
      spawnFor: () => ({ cmd: ["fake-host"] }),
      spawn: () => host.child,
      mintSessionId: () => "sid-1",
      // This fixture's `spawn` always hands back the SAME scripted child (there is only one
      // "process" in play), so a spare-pool replenish() after ready would adopt the live
      // incarnation's own child as an "idle" spare — unrelated to what this test covers.
      spareCapacity: 0,
    });

    const handle = supervisor.preview(spec);
    if (handle instanceof Error) throw handle;
    expect(handle.state()).toBe("starting");

    await waitUntil(() => host.identity() !== null, "client.hello reached the child");

    // The diagnosed race window: the incarnation is negotiating, ks.state is still
    // "starting". Before the fix this reached the real (refusing) session and was lost.
    const pending = handle.resize({ w: 86, h: 30 });
    expect(handle.state()).toBe("starting");
    expect(host.resizeWrites()).toHaveLength(0); // nothing hit the wire yet

    host.replyHello();
    await waitUntil(() => host.hasMountRequest(), "mount reached the child");
    host.replyReady();
    await waitUntil(() => handle.state() === "ready", "ready");

    expect(await pending).toBeUndefined(); // buffering is an accepted disposition, not a failure
    expect(host.resizeWrites()).toEqual([{ w: 86, h: 30 }]);
    await supervisor.stopAll();
  });

  test("several resizes requested before ready coalesce to exactly one flushed envelope, carrying the LAST size", async () => {
    const spec = specFor();
    const host = parkingChild(spec);
    const clock = createManualClock();
    const supervisor = createHostSupervisor({
      clock,
      runtimeDeclaration,
      spawnFor: () => ({ cmd: ["fake-host"] }),
      spawn: () => host.child,
      mintSessionId: () => "sid-1",
      // This fixture's `spawn` always hands back the SAME scripted child (there is only one
      // "process" in play), so a spare-pool replenish() after ready would adopt the live
      // incarnation's own child as an "idle" spare — unrelated to what this test covers.
      spareCapacity: 0,
    });

    const handle = supervisor.preview(spec);
    if (handle instanceof Error) throw handle;
    await waitUntil(() => host.identity() !== null, "client.hello reached the child");

    void handle.resize({ w: 60, h: 20 });
    void handle.resize({ w: 74, h: 24 });
    const last = handle.resize({ w: 86, h: 30 });
    expect(host.resizeWrites()).toHaveLength(0);

    host.replyHello();
    await waitUntil(() => host.hasMountRequest(), "mount reached the child");
    host.replyReady();
    await waitUntil(() => handle.state() === "ready", "ready");

    expect(await last).toBeUndefined();
    expect(host.resizeWrites()).toEqual([{ w: 86, h: 30 }]); // last-wins, exactly one envelope
    await supervisor.stopAll();
  });

  // Fix round 2 (reviewer-confirmed gap) split what was one test into two DELIBERATELY
  // different pins on the SAME scenario (a resize buffered while negotiating, then the
  // incarnation dies before ready) — they can look contradictory at a glance, so state the
  // split plainly: the FIRST pins that the buffered size is never replayed as a stale
  // CONTROL REQUEST against the successor (no resize envelope ever reaches either child's
  // wire); the SECOND pins that the size is NOT simply thrown away either — it is folded
  // into the successor's own MOUNT request, so the child mounts at the right size directly.
  // "Never replayed as a command" and "still reaches the successor as mount geometry" are
  // both true at once; neither test's assertions overlap with the other's.
  test("a resize buffered before an incarnation dies is never replayed as a stale control request into the next incarnation", async () => {
    const spec = specFor();
    const first = parkingChild(spec);
    const second = parkingChild(spec);
    let attempt = 0;
    const clock = createManualClock();
    const supervisor = createHostSupervisor({
      clock,
      runtimeDeclaration,
      spawnFor: () => ({ cmd: ["fake-host"] }),
      spawn: () => {
        attempt += 1;
        return attempt === 1 ? first.child : second.child;
      },
      mintSessionId: () => "sid-1",
      // Only two scripted children exist here; a spare-pool replenish() after ready would
      // call `spawn` a third time and adopt the live incarnation's own `second.child` as an
      // "idle" spare — unrelated to what this test covers.
      spareCapacity: 0,
    });

    const handle = supervisor.preview(spec);
    if (handle instanceof Error) throw handle;
    await waitUntil(() => first.identity() !== null, "1st client.hello reached the child");

    handle.resize({ w: 999, h: 999 }); // buffered while the 1st incarnation is still negotiating

    // Never reply hello — the handshake budget times out, killing the 1st incarnation via
    // the REAL session.ts path (the same technique session.test.ts's own timeout tests use).
    await waitUntil(() => clock.pending() >= 1, "handshake timer armed");
    clock.advance(HANDSHAKE_TIMEOUT_MS);
    await waitUntil(() => handle.state() === "backoff", "1st incarnation died, backing off");

    clock.advance(250); // fires the backoff timer, spawning the 2nd incarnation
    await waitUntil(() => second.identity() !== null, "2nd client.hello reached the child");
    second.replyHello();
    await waitUntil(() => second.hasMountRequest(), "2nd incarnation mounting");
    second.replyReady();
    await waitUntil(() => handle.state() === "ready", "2nd incarnation ready");

    // No resize CONTROL REQUEST was ever sent to either incarnation's wire — the buffered
    // value did not survive as a queued/replayed command (see the next test for where the
    // requested size actually went: folded into the mount, not into a resize envelope).
    expect(second.resizeWrites()).toHaveLength(0);
    expect(first.resizeWrites()).toHaveLength(0);
    await supervisor.stopAll();
  });

  test("a resize buffered before an incarnation dies is folded into the successor's MOUNT size, not silently discarded", async () => {
    const spec = specFor();
    const first = parkingChild(spec);
    const second = parkingChild(spec);
    let attempt = 0;
    const clock = createManualClock();
    const supervisor = createHostSupervisor({
      clock,
      runtimeDeclaration,
      spawnFor: () => ({ cmd: ["fake-host"] }),
      spawn: () => {
        attempt += 1;
        return attempt === 1 ? first.child : second.child;
      },
      mintSessionId: () => "sid-1",
      // Only two scripted children exist here; a spare-pool replenish() after ready would
      // call `spawn` a third time and adopt the live incarnation's own `second.child` as an
      // "idle" spare — unrelated to what this test covers.
      spareCapacity: 0,
    });

    const handle = supervisor.preview(spec);
    if (handle instanceof Error) throw handle;
    await waitUntil(() => first.identity() !== null, "1st client.hello reached the child");

    // Buffered while the 1st incarnation is still negotiating — deliberately distinct from
    // specFor()'s own size ({ w: 80, h: 24 }), so a successor that mounts at the OLD spec
    // size (the original defect, reached via a restart instead of the startup race) is
    // unmistakably different from one that mounts at this size.
    handle.resize({ w: 140, h: 40 });

    // Never reply hello — the handshake budget times out, killing the 1st incarnation via
    // the REAL session.ts path (same technique as the sibling test above).
    await waitUntil(() => clock.pending() >= 1, "handshake timer armed");
    clock.advance(HANDSHAKE_TIMEOUT_MS);
    await waitUntil(() => handle.state() === "backoff", "1st incarnation died, backing off");

    clock.advance(250); // fires the backoff timer, spawning the 2nd incarnation
    await waitUntil(() => second.identity() !== null, "2nd client.hello reached the child");
    second.replyHello();
    await waitUntil(() => second.hasMountRequest(), "2nd incarnation mounting");

    // The fold: the successor's OWN mount request already carries the buffered size —
    // this is mount geometry, not a resize command (the sibling test above proves no
    // resize control request was ever sent).
    expect(second.mountedSize()).toEqual({ w: 140, h: 40 });

    second.replyReady();
    await waitUntil(() => handle.state() === "ready", "2nd incarnation ready");
    await supervisor.stopAll();
  });
});

// --- design-tree phase 3 Task 6: the warm spare pool ---
//
// `fakeFactory`'s `createSession` never touches `deps.spawn`/`deps.command` — the fake
// `HostSession` it returns is built directly, so the spare pool's adoption path (which lives
// entirely in `sessionDepsFor`'s `spawn` wrapper) is invisible to every test above. This
// factory is the opposite: it calls `deps.spawn(deps.command)` at the top of `start()`, exactly
// where the real `createHostSession` does, so a test here can prove whether that call actually
// reached the spare pool or the underlying `spawn`.

function spawnAwareFactory() {
  const spawnedFor: unknown[] = [];
  let nonceSeq = 0;

  const createSession = (spec: HostSessionSpec, deps: HostSessionDeps): HostSession => {
    const spawned = deps.spawn(deps.command);
    spawnedFor.push(spawned);
    nonceSeq += 1;
    const sessionId = deps.sessionId ?? "no-session-id";
    const nonce = String(nonceSeq).padStart(32, "0");
    const identity = {
      mode: spec.mode,
      pageSlug: spec.pageSlug,
      sourceHash: spec.sourceHash,
      kitApiVersion: spec.kitApiVersion,
      sessionId,
      nonce,
    };
    let phase: HostSession["phase"] = "created";
    const relay = createPreviewRelay();
    const ready: ControlEnvelope = {
      protocolVersion: 1,
      kind: "ready",
      sessionId,
      nonce,
      messageId: "1",
      responseTo: "1",
      body: { size: { w: spec.size.w, h: spec.size.h }, interactionMode: spec.interactionMode },
    };
    return {
      identity,
      get phase() {
        return phase;
      },
      async start(): Promise<ProtocolError | SupervisorError | ReadyOutcome> {
        if (spawned instanceof Error) {
          phase = "failed";
          relay.close();
          return spawned;
        }
        phase = "ready";
        return { identity, negotiatedLimits: PROTOCOL_HARD_LIMITS, ready, firstFrame: null };
      },
      async stop(): Promise<StopOutcome> {
        phase = "stopped";
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
      async resize() {
        return ready;
      },
      async setMode(mode) {
        return { ...ready, kind: "set-mode", body: { interactionMode: mode } };
      },
      async ping() {
        return ready;
      },
      async query(frameIdentity) {
        return { ok: true, frameIdentity, result: {} };
      },
      async mount() {
        return ready;
      },
    };
  };

  return { createSession, spawnedFor };
}

/** A `SpawnFn` returning a fresh, never-exiting fake child every call — tracks every command. */
function trackingSpawn(): { spawn: SpawnFn; calls: SpawnCommand[] } {
  const calls: SpawnCommand[] = [];
  const spawn: SpawnFn = (command) => {
    calls.push(command);
    return {
      stdin: { write: () => {}, flush: () => {}, end: () => {} },
      stdout: (async function* () {})(),
      stderr: (async function* () {})(),
      exited: new Promise<number>(() => {}), // an idle/live child never exits on its own here
      exitCode: null,
      signalCode: null,
      kill() {},
    };
  };
  return { spawn, calls };
}

describe("createHostSupervisor — warm spare pool (design §9.3, phase 3 Task 6)", () => {
  test("the first incarnation spawns cold; the second adopts the spare", async () => {
    const factory = spawnAwareFactory();
    const tracker = trackingSpawn();
    let sidSeq = 0;
    const clock = createManualClock();
    const supervisor = createHostSupervisor({
      clock,
      runtimeDeclaration,
      spawnFor: () => ({ cmd: ["fake-host"] }),
      spawn: tracker.spawn,
      mintSessionId: () => `sid-${(sidSeq += 1)}`,
      createSession: factory.createSession,
      spareCapacity: 1,
    });

    const a = supervisor.preview(specFor({ treeRevision: "1".repeat(64) }));
    if (a instanceof Error) throw a;
    await waitUntil(() => a.state() === "ready", "a ready");
    // 1 cold spawn (a's own incarnation) + 1 spare replenished right after.
    await waitUntil(() => tracker.calls.length === 2, "spare replenished after a's ready");

    const b = supervisor.preview(specFor({ treeRevision: "2".repeat(64) }));
    if (b instanceof Error) throw b;
    await waitUntil(() => b.state() === "ready", "b ready — adopted the spare");
    // The adoption itself spawned NOTHING: b's own incarnation took the already-spawned spare.
    // Only the replenish AFTER b's ready adds a third call.
    await waitUntil(() => tracker.calls.length === 3, "spare replenished again after b's ready");
    await supervisor.stopAll();
  });

  test("liveCount counts the spare", async () => {
    const factory = spawnAwareFactory();
    const tracker = trackingSpawn();
    let sidSeq = 0;
    const clock = createManualClock();
    const supervisor = createHostSupervisor({
      clock,
      runtimeDeclaration,
      spawnFor: () => ({ cmd: ["fake-host"] }),
      spawn: tracker.spawn,
      mintSessionId: () => `sid-${(sidSeq += 1)}`,
      createSession: factory.createSession,
      spareCapacity: 1,
    });

    const a = supervisor.preview(specFor({ treeRevision: "1".repeat(64) }));
    if (a instanceof Error) throw a;
    await waitUntil(() => a.state() === "ready", "a ready");
    await waitUntil(() => supervisor.liveCount() === 2, "1 incarnation + 1 spare"); // §13's cap sees the spare too
    await supervisor.stopAll();
  });

  test("no spare is held at the global cap", async () => {
    const factory = spawnAwareFactory();
    const tracker = trackingSpawn();
    let sidSeq = 0;
    const clock = createManualClock();
    const supervisor = createHostSupervisor({
      clock,
      runtimeDeclaration,
      spawnFor: () => ({ cmd: ["fake-host"] }),
      spawn: tracker.spawn,
      mintSessionId: () => `sid-${(sidSeq += 1)}`,
      createSession: factory.createSession,
      spareCapacity: 1,
      maxGlobalHosts: 2,
    });

    const a = supervisor.preview(specFor({ treeRevision: "1".repeat(64) }));
    if (a instanceof Error) throw a;
    await waitUntil(() => a.state() === "ready", "a ready");
    const b = supervisor.preview(specFor({ treeRevision: "2".repeat(64) }));
    if (b instanceof Error) throw b;
    await waitUntil(() => b.state() === "ready", "b ready — adopted the spare, at the cap now");
    // Two incarnations already saturate the cap of 2 — replenish must not grow a third process.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(supervisor.liveCount()).toBe(2);
    await supervisor.stopAll();
  });

  test("stopAll drains the pool", async () => {
    const factory = spawnAwareFactory();
    const tracker = trackingSpawn();
    let sidSeq = 0;
    const clock = createManualClock();
    const supervisor = createHostSupervisor({
      clock,
      runtimeDeclaration,
      spawnFor: () => ({ cmd: ["fake-host"] }),
      spawn: tracker.spawn,
      mintSessionId: () => `sid-${(sidSeq += 1)}`,
      createSession: factory.createSession,
      spareCapacity: 1,
    });

    const a = supervisor.preview(specFor({ treeRevision: "1".repeat(64) }));
    if (a instanceof Error) throw a;
    await waitUntil(() => a.state() === "ready", "a ready");
    await waitUntil(() => tracker.calls.length === 2, "spare replenished");
    await supervisor.stopAll();
    expect(supervisor.liveCount()).toBe(0);
  });
});
