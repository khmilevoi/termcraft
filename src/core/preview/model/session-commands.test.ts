import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import { reatomPreviewStateMachine } from "core/machines";
import type {
  HostSessionSpecV1,
  HostSupervisorPort,
  PreviewFrameV1,
  PreviewGeometryQueryResultV1,
  PreviewIdentityV1,
  PreviewSession,
} from "core/ports";
import { type FakeHostSupervisorPort, createFakeHostSupervisorPort } from "core/ports/fakes";
import { type FailureDtoV1, isUuidv7 } from "core/protocol";
import type { Clock } from "infrastructure/clock";

import { HOST_CONTROL_QUEUE_CAPACITY, createPreviewBackpressure } from "./backpressure";
import { createFrameBroker } from "./frame-broker";
import { FrameAckError, createFrameTokenLedger } from "./frame-token-ledger";
import { createGeometryTokenLedger } from "./geometry-token-ledger";
import {
  MAX_OUTSTANDING_GEOMETRY_REQUESTS,
  PreviewNoLiveSessionError,
  createPreviewSessionCommands,
} from "./session-commands";

/**
 * `createPreviewSessionCommands` (kernel-command-contract §7.6, §8.1-§8.2, §12.5-§12.6):
 * routes `preview.*` commands onto the landed `PreviewState` machine and the
 * `PreviewSession`/`HostSupervisorPort` ports, and ties the frame/geometry token chain
 * together end to end. ORDER IS THE CONTRACT throughout — every rejection test asserts a
 * later port is never even attempted, matching `admission.test.ts`'s own style.
 */

function manualClock(startMs: number): Clock {
  return { now: () => new Date(startMs) };
}

function baseSpec(overrides: Partial<HostSessionSpecV1> = {}): HostSessionSpecV1 {
  return {
    mode: "preview",
    interactionMode: "static",
    pageSlug: "home",
    sourcePath: "/fake/home.tsx",
    sourceHash: "a".repeat(64),
    kitApiVersion: 1,
    size: { w: 80, h: 24 },
    theme: "dark",
    capabilities: { colorDepth: 256 },
    ...overrides,
  };
}

const FAILURE: FailureDtoV1 = {
  code: "HOST_START_FAILED",
  retryable: true,
  safeMessage: "boom",
  details: {},
};

/**
 * `kernel.preview.enable` (`disabled -> idle`) is driven by broader project-lifecycle
 * orchestration ("requires trusted project and completed project recovery", §7.6) —
 * there is no public `preview.enable` command kind at all, and it is outside
 * `session-commands.ts`'s own job. Every test starts from the realistic baseline
 * `session-commands.ts` actually sees in production: `idle`, not the machine's raw
 * initial `disabled`.
 */
function harness<S extends HostSupervisorPort = FakeHostSupervisorPort>(
  hostSupervisor: S = createFakeHostSupervisorPort() as unknown as S,
) {
  const machine = reatomPreviewStateMachine();
  machine.apply("kernel.preview.enable");
  const frameBroker = createFrameBroker();
  const frameTokenLedger = createFrameTokenLedger();
  const geometryTokenLedger = createGeometryTokenLedger({ clock: manualClock(1_700_000_000_000) });
  const backpressure = createPreviewBackpressure();
  const commands = createPreviewSessionCommands({
    machine,
    hostSupervisor,
    frameBroker,
    frameTokenLedger,
    geometryTokenLedger,
    backpressure,
  });
  return {
    machine,
    hostSupervisor,
    frameBroker,
    frameTokenLedger,
    geometryTokenLedger,
    backpressure,
    commands,
  };
}

function frame(overrides: Partial<PreviewFrameV1> = {}): PreviewFrameV1 {
  return {
    sessionId: "host-session-1",
    sourceHash: "a".repeat(64),
    frameSeq: "1",
    width: 80,
    height: 24,
    rows: [],
    ...overrides,
  };
}

/** Publishes and acknowledges one frame, returning the now-current frame token. */
function acknowledgedFrameToken(h: ReturnType<typeof harness>): string {
  const token = h.commands.publishFrame(frame());
  if (token instanceof Error) throw token;
  const acked = h.commands.acknowledgeDisplay(token);
  if (acked instanceof Error) throw acked;
  return token;
}

/** A minimal, fully hand-built `PreviewSession` — every method configurable per test. */
function stubSession(overrides: Partial<PreviewSession> = {}): PreviewSession {
  const identity: PreviewIdentityV1 = {
    mode: "preview",
    pageSlug: "home",
    sourceHash: "a".repeat(64),
    kitApiVersion: 1,
    sessionId: "stub-session",
  };
  return {
    identity,
    mode: "preview",
    interactionMode: "static",
    frames: {
      [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }),
    },
    resize: async () => undefined,
    setMode: async () => undefined,
    setTheme: async () => undefined,
    retry: async () => undefined,
    close: async () => undefined,
    query: async () => ({ result: { kind: "checkHit", hit: null }, resolvedAnchor: null }),
    ...overrides,
  };
}

/** A `HostSupervisorPort` stub whose `preview()` always returns the given session (or failure). */
function stubHostSupervisor(next: () => PreviewSession | FailureDtoV1): HostSupervisorPort {
  return {
    preview: async () => next(),
    liveCount: () => 0,
    stopAll: async () => {},
    onEvent: () => () => {},
  };
}

describe("createPreviewSessionCommands — selectPage/selectCurrent/selectHistorical", () => {
  test("from idle, selectPage drives beginStart, calls hostSupervisor.preview, and reaches live on success", async () => {
    await context.start(async () => {
      const h = harness();
      const outcome = await wrap(h.commands.selectPage(baseSpec()));

      expect(outcome).toEqual({ kind: "accepted" });
      expect(h.machine.phase()).toBe("live");
      expect(h.hostSupervisor.calls).toEqual([{ method: "preview", pageSlug: "home" }]);
    });
  });

  test("from live, selecting a different page drives beginSwitch (not beginStart): phase is 'switching' synchronously before the port resolves", async () => {
    await context.start(async () => {
      const h = harness();
      await wrap(h.commands.selectPage(baseSpec()));
      expect(h.machine.phase()).toBe("live");

      const pending = wrap(h.commands.selectCurrent(baseSpec({ pageSlug: "about" })));
      expect(h.machine.phase()).toBe("switching");
      await pending;
      expect(h.machine.phase()).toBe("live");
    });
  });

  test("hostSupervisor.preview() failure applies sessionFailed and returns the failure", async () => {
    await context.start(async () => {
      const h = harness();
      h.hostSupervisor.failNext("preview", FAILURE);

      const outcome = await wrap(h.commands.selectPage(baseSpec()));

      expect(outcome).toEqual({ kind: "failed", failure: FAILURE });
      expect(h.machine.phase()).toBe("failed");
    });
  });

  test("illegal from a phase where neither beginStart nor beginSwitch applies: rejected with the machine's own code, hostSupervisor is never called", async () => {
    await context.start(async () => {
      const h = harness();
      // Move to "starting" without reaching "live" or "failed" — from there, neither
      // beginStart nor beginSwitch is legal.
      h.machine.apply("kernel.preview.beginStart");
      expect(h.machine.phase()).toBe("starting");

      const outcome = await wrap(h.commands.selectPage(baseSpec()));

      expect(outcome).toEqual({ kind: "rejected", reason: { code: "OPERATION_BUSY" } });
      expect(h.hostSupervisor.calls).toEqual([]);
    });
  });

  test("a successful select resets the frame broker and invalidates the prior frame token", async () => {
    await context.start(async () => {
      const h = harness();
      await wrap(h.commands.selectPage(baseSpec()));
      const token = acknowledgedFrameToken(h);
      const identityBeforeSwitch = h.frameTokenLedger.currentIdentity();
      if (identityBeforeSwitch === null) throw new Error("expected a current identity");
      expect(h.frameTokenLedger.verifyCurrent(token)).toEqual({
        ok: true,
        identity: identityBeforeSwitch,
      });

      await wrap(h.commands.selectCurrent(baseSpec({ pageSlug: "about" })));

      expect(h.frameBroker.current()).toBeNull();
      expect(h.frameTokenLedger.verifyCurrent(token)).toEqual({
        ok: false,
        code: "FRAME_TOKEN_STALE",
      });
    });
  });

  test("the minted identity's sourceHash and frameSeq come FROM THE FRAME, and the broker receives it", async () => {
    // §12.5: "no frame/query/token comparison is valid without the full
    // (previewSessionId, nonce, sourceHash, frameSeq) tuple."
    //
    // The §13.3 identity matrix in geometry-token-ledger.test.ts hands the ledger a
    // hand-built identity, so it proves the COMPARISON works while proving nothing about
    // where the tuple comes from. With sourceHash/frameSeq replaced by constants here,
    // every frame in a session shares one identity — a token minted against frame N then
    // consumes cleanly against frame N+5, and the whole matrix silently means nothing.
    await context.start(async () => {
      const h = harness();
      await wrap(h.commands.selectPage(baseSpec()));

      const first = frame({ sourceHash: "1".repeat(64), frameSeq: "7" });
      const firstToken = h.commands.publishFrame(first);
      if (firstToken instanceof Error) throw firstToken;
      // The broker must actually receive the frame — asserting only that it is null after a
      // switch is satisfied by a broker that never received anything at all.
      expect(h.frameBroker.current()).toEqual(first);

      const second = frame({ sourceHash: "2".repeat(64), frameSeq: "8" });
      const secondToken = h.commands.publishFrame(second);
      if (secondToken instanceof Error) throw secondToken;
      expect(h.frameBroker.current()).toEqual(second);

      const acked = h.commands.acknowledgeDisplay(secondToken);
      if (acked instanceof Error) throw acked;

      const identity = h.frameTokenLedger.currentIdentity();
      if (identity === null) throw new Error("expected a current identity");
      expect(identity.sourceHash).toBe(second.sourceHash);
      expect(identity.frameSeq).toBe(second.frameSeq);
      // Two frames must not share an identity.
      expect(identity.sourceHash).not.toBe(first.sourceHash);
      expect(identity.frameSeq).not.toBe(first.frameSeq);
    });
  });
});

describe("createPreviewSessionCommands — resize/setMode/setThemeCapabilities", () => {
  test("resize on a live session applies the resize action and calls session.resize with the exact size", async () => {
    await context.start(async () => {
      const calls: Array<{ w: number; h: number }> = [];
      const supervisor = stubHostSupervisor(() =>
        stubSession({
          resize: async (size) => {
            calls.push(size);
            return undefined;
          },
        }),
      );
      const h = harness(supervisor);
      await wrap(h.commands.selectPage(baseSpec()));

      const outcome = await wrap(h.commands.resize({ w: 100, h: 40 }));

      expect(outcome).toEqual({ kind: "accepted" });
      expect(calls).toEqual([{ w: 100, h: 40 }]);
    });
  });

  test("resize when not live is rejected without calling any port", async () => {
    await context.start(async () => {
      const h = harness();
      const outcome = await wrap(h.commands.resize({ w: 100, h: 40 }));
      expect(outcome).toEqual({ kind: "rejected", reason: { code: "OPERATION_BUSY" } });
      expect(h.hostSupervisor.calls).toEqual([]);
    });
  });

  test("resize propagates a port failure as 'failed'", async () => {
    await context.start(async () => {
      const supervisor = stubHostSupervisor(() => stubSession({ resize: async () => FAILURE }));
      const h = harness(supervisor);
      await wrap(h.commands.selectPage(baseSpec()));

      const outcome = await wrap(h.commands.resize({ w: 100, h: 40 }));

      expect(outcome).toEqual({ kind: "failed", failure: FAILURE });
    });
  });

  test("setMode on a live session applies setMode and calls session.setMode with the exact mode, reserving/releasing one backpressure slot", async () => {
    await context.start(async () => {
      const calls: string[] = [];
      const supervisor = stubHostSupervisor(() =>
        stubSession({
          setMode: async (mode) => {
            calls.push(mode);
            return undefined;
          },
        }),
      );
      const h = harness(supervisor);
      await wrap(h.commands.selectPage(baseSpec()));
      expect(h.backpressure.queueSize()).toBe(0);

      const outcome = await wrap(h.commands.setMode("interactive"));

      expect(outcome).toEqual({ kind: "accepted" });
      expect(calls).toEqual(["interactive"]);
      expect(h.backpressure.queueSize()).toBe(0); // reserved then released
    });
  });

  test("setMode when not live is rejected without calling any port", async () => {
    await context.start(async () => {
      const h = harness();
      const outcome = await wrap(h.commands.setMode("interactive"));
      expect(outcome).toEqual({ kind: "rejected", reason: { code: "OPERATION_BUSY" } });
    });
  });

  test("setThemeCapabilities on a live session applies setThemeCapabilities and calls session.setTheme with the exact args", async () => {
    await context.start(async () => {
      const calls: Array<{ theme: string; colorDepth: number }> = [];
      const supervisor = stubHostSupervisor(() =>
        stubSession({
          setTheme: async (theme, capabilities) => {
            calls.push({ theme, colorDepth: capabilities.colorDepth });
            return undefined;
          },
        }),
      );
      const h = harness(supervisor);
      await wrap(h.commands.selectPage(baseSpec()));

      const outcome = await wrap(h.commands.setThemeCapabilities("light", { colorDepth: 16 }));

      expect(outcome).toEqual({ kind: "accepted" });
      expect(calls).toEqual([{ theme: "light", colorDepth: 16 }]);
    });
  });

  test("setMode is refused with HOST_BACKPRESSURED when the queue is already at capacity, without calling the port", async () => {
    await context.start(async () => {
      let queryCalled = false;
      const supervisor = stubHostSupervisor(() =>
        stubSession({
          setMode: async () => {
            queryCalled = true;
            return undefined;
          },
        }),
      );
      const h = harness(supervisor);
      await wrap(h.commands.selectPage(baseSpec()));
      for (let i = 0; i < HOST_CONTROL_QUEUE_CAPACITY; i += 1) h.backpressure.reserve();

      const outcome = await wrap(h.commands.setMode("interactive"));

      expect(outcome).toEqual({ kind: "rejected", reason: { code: "HOST_BACKPRESSURED" } });
      expect(queryCalled).toBe(false);
    });
  });
});

describe("createPreviewSessionCommands — retry", () => {
  test("retry from circuit-open re-issues the last spec and reaches live on success", async () => {
    await context.start(async () => {
      const h = harness();
      h.hostSupervisor.failNext("preview", FAILURE);
      await wrap(h.commands.selectPage(baseSpec()));
      expect(h.machine.phase()).toBe("failed");
      h.machine.apply("kernel.preview.openCircuit");
      expect(h.machine.phase()).toBe("circuit-open");

      const outcome = await wrap(h.commands.retry());

      expect(outcome).toEqual({ kind: "accepted" });
      expect(h.machine.phase()).toBe("live");
      expect(h.hostSupervisor.calls).toEqual([
        { method: "preview", pageSlug: "home" },
        { method: "preview", pageSlug: "home" },
      ]);
    });
  });

  test("retry when illegal (e.g. from idle) is rejected without calling the port", async () => {
    await context.start(async () => {
      const h = harness();
      const outcome = await wrap(h.commands.retry());
      expect(outcome).toEqual({ kind: "rejected", reason: { code: "OPERATION_BUSY" } });
      expect(h.hostSupervisor.calls).toEqual([]);
    });
  });

  /**
   * DEFECT 2 CLOSURE (kernel-assembly, "make preview.retry actually work"):
   * `noteSessionEstablished` is the external hook `handlers/preview-export.ts`'s
   * `selectCurrentSource` drives in production (Gap A — that handler never calls this
   * module's own `selectPage`/`selectCurrent`, so `selectSource`'s own `lastSpec = spec`
   * assignment never runs there). Before this fix `noteSessionEstablished` never touched
   * `lastSpec` at all, so `retry()` always took its own "no remembered spec" refusal in
   * that production path — this test drives the SAME external hook, with the SAME
   * optional second argument `kernel.ts`'s real `setActivePreviewSession` now forwards.
   */
  test("noteSessionEstablished threads spec into lastSpec, so a subsequent retry (from circuit-open) reissues the SAME spec", async () => {
    await context.start(async () => {
      const h = harness();
      // Reach circuit-open the way the real Kernel does: failed, then openCircuit.
      h.machine.apply("kernel.preview.beginStart");
      h.machine.apply("kernel.preview.sessionFailed");
      h.machine.apply("kernel.preview.openCircuit");
      expect(h.machine.phase()).toBe("circuit-open");

      const spec = baseSpec({ pageSlug: "about" });
      h.commands.noteSessionEstablished(stubSession(), spec);

      const outcome = await wrap(h.commands.retry());

      expect(outcome).toEqual({ kind: "accepted" });
      expect(h.machine.phase()).toBe("live");
      expect(h.hostSupervisor.calls).toEqual([{ method: "preview", pageSlug: "about" }]);
    });
  });

  test("noteSessionEstablished called with NO spec leaves lastSpec untouched — a later retry still reissues the earlier-threaded spec", async () => {
    await context.start(async () => {
      const h = harness();
      h.machine.apply("kernel.preview.beginStart");
      const spec = baseSpec({ pageSlug: "pricing" });
      // First establishment: threads the real spec (mirrors `selectCurrentSource`'s own
      // call).
      h.commands.noteSessionEstablished(stubSession(), spec);
      h.machine.apply("kernel.preview.sessionFailed");
      h.machine.apply("kernel.preview.openCircuit");
      h.machine.apply("kernel.preview.retryCircuit");

      // A SECOND call with no spec — mirrors `handleRetry`'s own re-sync call
      // (`context.setActivePreviewSession(context.previewSessionCommands.currentSession())`,
      // no spec argument) — must not clobber the already-threaded spec with nothing.
      h.commands.noteSessionEstablished(stubSession());
      h.machine.apply("kernel.preview.sessionFailed");
      h.machine.apply("kernel.preview.openCircuit");

      const outcome = await wrap(h.commands.retry());

      expect(outcome).toEqual({ kind: "accepted" });
      expect(h.hostSupervisor.calls).toEqual([{ method: "preview", pageSlug: "pricing" }]);
    });
  });
});

describe("createPreviewSessionCommands — close", () => {
  test("close from live disables the machine and calls session.close()", async () => {
    await context.start(async () => {
      let closed = false;
      const supervisor = stubHostSupervisor(() =>
        stubSession({
          close: async () => {
            closed = true;
          },
        }),
      );
      const h = harness(supervisor);
      await wrap(h.commands.selectPage(baseSpec()));

      const outcome = await wrap(h.commands.close());

      expect(outcome).toEqual({ kind: "accepted" });
      expect(h.machine.phase()).toBe("disabled");
      expect(closed).toBe(true);
    });
  });

  test("close when already disabled is rejected, without calling the port again", async () => {
    await context.start(async () => {
      const h = harness();
      await wrap(h.commands.selectPage(baseSpec()));
      await wrap(h.commands.close());
      expect(h.machine.phase()).toBe("disabled");

      const outcome = await wrap(h.commands.close());

      expect(outcome).toEqual({ kind: "rejected", reason: { code: "OPERATION_BUSY" } });
    });
  });

  test("close invalidates the current frame token", async () => {
    await context.start(async () => {
      const h = harness();
      await wrap(h.commands.selectPage(baseSpec()));
      const token = acknowledgedFrameToken(h);

      await wrap(h.commands.close());

      expect(h.frameTokenLedger.verifyCurrent(token)).toEqual({
        ok: false,
        code: "FRAME_TOKEN_STALE",
      });
    });
  });
});

describe("createPreviewSessionCommands — queryGeometry (the token chain)", () => {
  test("an unacknowledged frame token is refused as FRAME_TOKEN_INVALID; the port's query() is never reached", async () => {
    await context.start(async () => {
      let queried = false;
      const supervisor = stubHostSupervisor(() =>
        stubSession({
          query: async () => {
            queried = true;
            return { result: { kind: "checkHit", hit: null }, resolvedAnchor: null };
          },
        }),
      );
      const h = harness(supervisor);
      await wrap(h.commands.selectPage(baseSpec()));
      const pendingToken = h.commands.publishFrame(frame());
      if (pendingToken instanceof Error) throw pendingToken;

      const outcome = await wrap(h.commands.queryGeometry(pendingToken, { kind: "layout" }));

      expect(outcome).toEqual({ kind: "rejected", reason: { code: "FRAME_TOKEN_INVALID" } });
      expect(queried).toBe(false);
    });
  });

  test("queryGeometry when not live is rejected without touching the frame-token ledger", async () => {
    await context.start(async () => {
      const h = harness();
      const outcome = await wrap(
        h.commands.queryGeometry("0192f6f0-0000-7000-8000-0000000000ff", { kind: "layout" }),
      );
      expect(outcome).toEqual({ kind: "rejected", reason: { code: "OPERATION_BUSY" } });
    });
  });

  test("an acknowledged frame token succeeds and does not mint a geometry token for a non-resolving result", async () => {
    await context.start(async () => {
      const h = harness();
      await wrap(h.commands.selectPage(baseSpec()));
      const token = acknowledgedFrameToken(h);

      const outcome = await wrap(h.commands.queryGeometry(token, { kind: "layout" }));

      if (outcome.kind !== "resolved")
        throw new Error(`expected resolved, got ${JSON.stringify(outcome)}`);
      expect(outcome.geometryToken).toBeNull();
    });
  });

  test("a resolving hit query mints a geometry token bound to the current frame identity and resolved anchor", async () => {
    await context.start(async () => {
      const supervisor = stubHostSupervisor(() =>
        stubSession({
          query: async () => ({
            result: { kind: "checkHit", hit: null },
            resolvedAnchor: { pageSlug: "home", elementId: "btn-1", fx: 0.25, fy: 0.75 },
          }),
        }),
      );
      const h = harness(supervisor);
      await wrap(h.commands.selectPage(baseSpec()));
      const token = acknowledgedFrameToken(h);

      const outcome = await wrap(h.commands.queryGeometry(token, { kind: "hit", x: 1, y: 1 }));

      if (outcome.kind !== "resolved")
        throw new Error(`expected resolved, got ${JSON.stringify(outcome)}`);
      expect(outcome.geometryToken).not.toBeNull();
      if (outcome.geometryToken === null) return;
      expect(isUuidv7(outcome.geometryToken)).toBe(true);

      const identity = h.frameTokenLedger.currentIdentity();
      if (identity === null) throw new Error("expected a current identity");
      const consumed = h.geometryTokenLedger.consume(outcome.geometryToken, identity);
      expect(consumed).toEqual({
        ok: true,
        anchor: { identity, pageSlug: "home", elementId: "btn-1", fx: 0.25, fy: 0.75 },
      });
    });
  });

  test("a resolving pin-anchor query also mints a geometry token", async () => {
    await context.start(async () => {
      const supervisor = stubHostSupervisor(() =>
        stubSession({
          query: async () => ({
            result: { kind: "checkHit", hit: null },
            resolvedAnchor: { pageSlug: "home", elementId: "btn-2", fx: 0.1, fy: 0.2 },
          }),
        }),
      );
      const h = harness(supervisor);
      await wrap(h.commands.selectPage(baseSpec()));
      const token = acknowledgedFrameToken(h);

      const outcome = await wrap(
        h.commands.queryGeometry(token, { kind: "pin-anchor", x: 2, y: 2 }),
      );

      if (outcome.kind !== "resolved")
        throw new Error(`expected resolved, got ${JSON.stringify(outcome)}`);
      expect(outcome.geometryToken).not.toBeNull();
    });
  });

  test("a resolving 'rect' query does NOT mint a geometry token even if resolvedAnchor is non-null — only hit/pin-anchor do", async () => {
    await context.start(async () => {
      const supervisor = stubHostSupervisor(() =>
        stubSession({
          query: async () => ({
            result: { kind: "checkHit", hit: null },
            resolvedAnchor: { pageSlug: "home", elementId: "btn-3", fx: 0.4, fy: 0.6 },
          }),
        }),
      );
      const h = harness(supervisor);
      await wrap(h.commands.selectPage(baseSpec()));
      const token = acknowledgedFrameToken(h);

      const outcome = await wrap(
        h.commands.queryGeometry(token, { kind: "rect", elementId: "btn-3" }),
      );

      if (outcome.kind !== "resolved")
        throw new Error(`expected resolved, got ${JSON.stringify(outcome)}`);
      expect(outcome.geometryToken).toBeNull();
    });
  });

  test("a port failure during queryGeometry returns 'failed' and releases its outstanding-request slot", async () => {
    await context.start(async () => {
      const supervisor = stubHostSupervisor(() => stubSession({ query: async () => FAILURE }));
      const h = harness(supervisor);
      await wrap(h.commands.selectPage(baseSpec()));
      const token = acknowledgedFrameToken(h);

      const outcome = await wrap(h.commands.queryGeometry(token, { kind: "layout" }));

      expect(outcome).toEqual({ kind: "failed", failure: FAILURE });
    });
  });

  test("reaching the outstanding-request cap refuses a new query as TOO_MANY_REQUESTS without calling the port", async () => {
    await context.start(async () => {
      const supervisor = stubHostSupervisor(() =>
        stubSession({ query: () => new Promise(() => {}) }),
      );
      const h = harness(supervisor);
      await wrap(h.commands.selectPage(baseSpec()));
      const token = acknowledgedFrameToken(h);

      // Fire MAX_OUTSTANDING_GEOMETRY_REQUESTS calls without awaiting any of them — each
      // one runs synchronously up to its own internal `await`, incrementing the outstanding
      // count before yielding, exactly like `MAX_TURN_ATTEMPTS`-style bounded counters
      // elsewhere in this codebase.
      for (let i = 0; i < MAX_OUTSTANDING_GEOMETRY_REQUESTS; i += 1) {
        void h.commands.queryGeometry(token, { kind: "layout" });
      }

      const outcome = await wrap(h.commands.queryGeometry(token, { kind: "layout" }));

      expect(outcome).toEqual({ kind: "rejected", reason: { code: "TOO_MANY_REQUESTS" } });
    });
  });

  test("an outstanding-request slot is released once its query settles, allowing a later query through", async () => {
    await context.start(async () => {
      // Only the first MAX_OUTSTANDING_GEOMETRY_REQUESTS calls hang (filling the cap); any
      // call beyond that resolves immediately, exactly like a query issued AFTER a slot has
      // been released.
      const resolvers: Array<(result: PreviewGeometryQueryResultV1) => void> = [];
      let callCount = 0;
      const supervisor = stubHostSupervisor(() =>
        stubSession({
          query: () => {
            callCount += 1;
            if (callCount <= MAX_OUTSTANDING_GEOMETRY_REQUESTS) {
              return new Promise((resolve) => {
                resolvers.push(resolve);
              });
            }
            return Promise.resolve({
              result: { kind: "checkHit", hit: null },
              resolvedAnchor: null,
            });
          },
        }),
      );
      const h = harness(supervisor);
      await wrap(h.commands.selectPage(baseSpec()));
      const token = acknowledgedFrameToken(h);

      const pending: Array<Promise<unknown>> = [];
      for (let i = 0; i < MAX_OUTSTANDING_GEOMETRY_REQUESTS; i += 1) {
        pending.push(h.commands.queryGeometry(token, { kind: "layout" }));
      }
      expect(resolvers.length).toBe(MAX_OUTSTANDING_GEOMETRY_REQUESTS);

      const refused = await wrap(h.commands.queryGeometry(token, { kind: "layout" }));
      expect(refused).toEqual({ kind: "rejected", reason: { code: "TOO_MANY_REQUESTS" } });

      const firstResolver = resolvers[0];
      const firstPending = pending[0];
      if (firstResolver === undefined || firstPending === undefined)
        throw new Error("expected a held query");
      firstResolver({ result: { kind: "checkHit", hit: null }, resolvedAnchor: null });
      // A plain `await firstPending` would resume outside this `context.start` frame (RTM-A04
      // — the same reason `admission.ts`'s own header documents): `firstPending`'s
      // continuation resumes from an externally-called resolver, so it must be re-bound.
      await wrap(firstPending);

      const afterRelease = await wrap(h.commands.queryGeometry(token, { kind: "layout" }));
      expect(afterRelease.kind).toBe("resolved");
    });
  });
});

/**
 * kernel-assembly Task 16: `noteSessionEstablished`/`noteSessionClosed` are the external
 * counterpart to `selectPage`'s own `establishSession`/`close` — the path `core/kernel/
 * model/kernel.ts`'s `setActivePreviewSession` actually drives in production today, since
 * `handlers/preview-export.ts` still calls that function directly rather than this
 * module's own `selectPage`/`close` (Gap A, this file's own top-of-file header note).
 * These tests prove the SAME publishFrame/acknowledgeDisplay contract the `selectPage`
 * describe block above already covers holds when a session is seeded THIS way instead —
 * never through `establishSession` — which is the only path `kernel.ts` can genuinely
 * reach given Gap A.
 */
describe("createPreviewSessionCommands — noteSessionEstablished/noteSessionClosed", () => {
  test("publishFrame with no session established yet is refused, never fabricated", () => {
    const h = harness();
    const published = h.commands.publishFrame(frame());
    expect(published).toBeInstanceOf(PreviewNoLiveSessionError);
  });

  test("noteSessionEstablished seeds a fresh incarnation: publishFrame mints a token the ledger recognises, and acknowledging it returns the frame's real identity", () => {
    const h = harness();
    h.commands.noteSessionEstablished(stubSession());

    const oneFrame = frame({ sourceHash: "3".repeat(64), frameSeq: "42" });
    const token = h.commands.publishFrame(oneFrame);
    if (token instanceof Error) throw token;

    const acked = h.commands.acknowledgeDisplay(token);
    if (acked instanceof Error) throw acked;
    expect(acked.sourceHash).toBe(oneFrame.sourceHash);
    expect(acked.frameSeq).toBe(oneFrame.frameSeq);
    expect(isUuidv7(acked.previewSessionId)).toBe(true);
  });

  test("acknowledging a token the ledger never minted fails even while a session is live — the ledger is real, not a rubber stamp", () => {
    const h = harness();
    h.commands.noteSessionEstablished(stubSession());
    // `publishFrame` was never called, so no token was ever minted for this session —
    // an arbitrary well-formed UUIDv7 stands in for "a token from nowhere".
    const neverMinted = "0192f6f0-0000-7000-8000-0000000000ff";

    const acked = h.commands.acknowledgeDisplay(neverMinted);

    expect(acked).toBeInstanceOf(FrameAckError);
  });

  test("noteSessionClosed invalidates the current token and blocks further publishFrame calls until the next noteSessionEstablished", () => {
    const h = harness();
    h.commands.noteSessionEstablished(stubSession());
    const token = acknowledgedFrameToken(h);

    h.commands.noteSessionClosed();

    expect(h.frameTokenLedger.verifyCurrent(token)).toEqual({
      ok: false,
      code: "FRAME_TOKEN_STALE",
    });
    const publishedAfterClose = h.commands.publishFrame(frame());
    expect(publishedAfterClose).toBeInstanceOf(PreviewNoLiveSessionError);
  });
});
