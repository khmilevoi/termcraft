import { describe, expect, test } from "bun:test";

import { createFakeHostSupervisorPort } from "core/ports/fakes";

import { PROTOCOL_HARD_LIMITS } from "../protocol";
import type {
  ControlEnvelope,
  FrameIdentity,
  ProtocolError,
  RuntimeDeclarationBundleV1,
} from "../protocol";
import { SupervisorError, createManualClock } from "../supervisor";
import type {
  HostSession,
  HostSessionDeps,
  HostSupervisorDeps,
  ReadyOutcome,
  StopOutcome,
} from "../supervisor";
import type { HostSessionSpec } from "../types";
import { createHostSupervisorAdapter } from "./host-supervisor";

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

/**
 * What the fake child answers a geometry query with, plus the `FrameIdentity` it was ASKED
 * about. That recorded identity is the point of the blocker-B1 tests below: the Kernel cannot
 * know the incarnation `nonce` (`host/types.ts`'s `PreviewFrame` drops it deliberately), so
 * the facade must complete it — and only a recorded, asserted identity proves it did.
 */
interface GeometryScript {
  readonly hitElementId?: string | null;
  readonly rect?: { x: number; y: number; width: number; height: number } | null;
  readonly asked?: FrameIdentity[];
}

/** A one-incarnation-per-key immediate-ready `createSession` test seam, mirroring `supervisor.test.ts`'s own fake factory. */
function fakeFactory(geometry: GeometryScript = {}) {
  let nonceSeq = 0;
  return (spec: HostSessionSpec, deps: HostSessionDeps): HostSession => {
    nonceSeq += 1;
    const nonce = String(nonceSeq).padStart(32, "0");
    const sessionId = deps.sessionId ?? "no-session-id";
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
    return {
      identity,
      phase: "ready",
      async start(): Promise<ProtocolError | SupervisorError | ReadyOutcome> {
        return { identity, negotiatedLimits: PROTOCOL_HARD_LIMITS, ready, firstFrame: null };
      },
      async stop(): Promise<StopOutcome> {
        return { phase: "stopped", forced: false, exitCode: 0, signalCode: null, reason: "test" };
      },
      frames: (async function* () {})(),
      async resize() {
        return ready;
      },
      async setMode(mode) {
        return { ...ready, body: { ...ready.body, interactionMode: mode } };
      },
      async ping() {
        return ready;
      },
      async query(frameIdentity, geometryQuery) {
        geometry.asked?.push(frameIdentity);
        // The real child's own per-kind reply records (`host/session/model/host-state-machine.ts`'s
        // `resolveGeometry`) — reproduced verbatim so the adapter's decoding is tested against
        // the shape the wire actually carries, not a convenient stand-in.
        const result =
          geometryQuery.kind === "hit"
            ? { elementId: geometry.hitElementId ?? null }
            : geometryQuery.kind === "rect"
              ? { found: geometry.rect != null, rect: geometry.rect ?? null }
              : geometryQuery.kind === "describe"
                ? { found: true, kind: "BoxRenderable" }
                : {
                    tree: {
                      id: "root",
                      kind: "BoxRenderable",
                      box: { x: 0, y: 0, width: 80, height: 24 },
                      children: [],
                    },
                  };
        return { ok: true, frameIdentity, result };
      },
      async mount() {
        return ready;
      },
    };
  };
}

function depsFor(overrides: Partial<HostSupervisorDeps> = {}): HostSupervisorDeps {
  return {
    clock: createManualClock(),
    runtimeDeclaration,
    spawnFor: () => ({ cmd: ["_host"] }),
    spawn: () => {
      throw new Error("spawn should not be called when createSession is injected");
    },
    mintSessionId: () => "session-1",
    createSession: fakeFactory(),
    // `deps.spawn` above deliberately throws — safe while ONLY the incarnation factory could
    // ever call it. The warm spare pool (design-tree phase 3 Task 6) is a second, independent
    // consumer of `deps.spawn` that this adapter-level suite does not exercise.
    spareCapacity: 0,
    ...overrides,
  };
}

describe("createHostSupervisorAdapter", () => {
  test("preview() resolves a PreviewSession whose identity mirrors the requested spec", async () => {
    const adapter = createHostSupervisorAdapter(depsFor());
    const spec = specFor();
    const result = await adapter.preview({
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
    });
    expect(result).not.toHaveProperty("code"); // not a FailureDtoV1
    if ("code" in result) throw result;
    expect(result.identity.pageSlug).toBe("dash");
    expect(result.identity).not.toHaveProperty("nonce");
    expect(result.mode).toBe("preview");
    expect(result.interactionMode).toBe("static");
  });

  test("preview() maps a checkTrust SupervisorError to a HOST_PROTOCOL_FAILED FailureDtoV1 by default", async () => {
    const adapter = createHostSupervisorAdapter(
      depsFor({
        checkTrust: () => new SupervisorError({ code: "TRANSPORT_ERROR", reason: "untrusted" }),
      }),
    );
    const result = await adapter.preview(specFor());
    if (!("code" in result)) throw new Error("expected a FailureDtoV1");
    expect(result.code).toBe("HOST_PROTOCOL_FAILED");
    expect(result.retryable).toBe(true);
  });

  test("preview() maps HOST_CAPACITY to HOST_START_FAILED and CIRCUIT_OPEN to HOST_CIRCUIT_OPEN", async () => {
    const capacityAdapter = createHostSupervisorAdapter(
      depsFor({ maxGlobalHosts: 0, startQueueCapacity: 0 }),
    );
    const capacityResult = await capacityAdapter.preview(specFor());
    if (!("code" in capacityResult)) throw new Error("expected a FailureDtoV1");
    expect(capacityResult.code).toBe("HOST_START_FAILED");

    // Drives the CIRCUIT_OPEN branch the same way the TRANSPORT_ERROR case above
    // drives HOST_PROTOCOL_FAILED: inject it via checkTrust rather than actually
    // exhausting the restart budget, which real supervisor.test.ts already covers.
    const circuitAdapter = createHostSupervisorAdapter(
      depsFor({
        checkTrust: () =>
          new SupervisorError({ code: "CIRCUIT_OPEN", reason: "circuit already open" }),
      }),
    );
    const circuitResult = await circuitAdapter.preview(specFor());
    if (!("code" in circuitResult)) throw new Error("expected a FailureDtoV1");
    expect(circuitResult.code).toBe("HOST_CIRCUIT_OPEN");
    expect(circuitResult.retryable).toBe(false);
  });

  test("liveCount()/stopAll() delegate to the real supervisor", async () => {
    const adapter = createHostSupervisorAdapter(depsFor());
    expect(adapter.liveCount()).toBe(0);
    const session = await adapter.preview(specFor());
    if ("code" in session) throw session;
    expect(adapter.liveCount()).toBe(1);
    await adapter.stopAll();
    expect(adapter.liveCount()).toBe(0);
  });

  test("onEvent() subscribes to lifecycle diagnostics and returns a working unsubscribe", async () => {
    const events: string[] = [];
    const adapter = createHostSupervisorAdapter(depsFor());
    const unsubscribe = adapter.onEvent((event) => events.push(event.type));
    await adapter.preview(specFor());
    expect(events).toContain("spawning");
    expect(events).toContain("ready");
    unsubscribe();
    events.length = 0;
    await adapter.preview(specFor({ pageSlug: "other" }));
    expect(events).toEqual([]);
  });

  test("a caller-supplied deps.onEvent still fires alongside the port's own subscribers", async () => {
    const seen: string[] = [];
    const adapter = createHostSupervisorAdapter(
      depsFor({ onEvent: (event) => seen.push(event.type) }),
    );
    await adapter.preview(specFor());
    expect(seen).toContain("spawning");
  });

  test("setMode/retry resolve undefined — host's underlying calls are fire-and-forget", async () => {
    const adapter = createHostSupervisorAdapter(depsFor());
    const session = await adapter.preview(specFor());
    if ("code" in session) throw session;
    await expect(session.setMode("interactive")).resolves.toBeUndefined();
    await expect(session.retry()).resolves.toBeUndefined();
  });

  test("resize() resolves undefined on a genuine accepted dispatch (Task 11: no longer fabricated)", async () => {
    const adapter = createHostSupervisorAdapter(depsFor());
    const session = await adapter.preview(specFor());
    if ("code" in session) throw session;
    await expect(session.resize({ w: 100, h: 30 })).resolves.toBeUndefined();
  });

  test("resize() surfaces a genuine host failure as a FailureDtoV1, not a fabricated success (Task 11)", async () => {
    const factory = fakeFactory();
    const adapter = createHostSupervisorAdapter(
      depsFor({
        createSession: (spec, sessionDeps) => {
          const session = factory(spec, sessionDeps);
          return {
            ...session,
            async resize() {
              return new SupervisorError({
                code: "TRANSPORT_ERROR",
                reason: "wire rejected the resize",
              });
            },
          };
        },
      }),
    );
    const session = await adapter.preview(specFor());
    if ("code" in session) throw session;
    const result = await session.resize({ w: 100, h: 30 });
    expect(result).toBeDefined();
    if (result === undefined) throw new Error("expected a FailureDtoV1");
    expect(result.code).toBe("HOST_PROTOCOL_FAILED");
  });

  test("setTheme() reports the documented not-yet-wired gap as a FailureDtoV1, never a fabricated success", async () => {
    const adapter = createHostSupervisorAdapter(depsFor());
    const session = await adapter.preview(specFor());
    if ("code" in session) throw session;
    const themeResult = await session.setTheme("light", { colorDepth: 8 });
    expect(themeResult).toBeDefined();
    if (themeResult === undefined) throw new Error("expected a FailureDtoV1");
    expect(themeResult.code).toBe("HOST_PROTOCOL_FAILED");
  });

  // BLOCKER B1's LAST MILE, and the defect it caused in a live run (2026-08-10): this adapter's
  // `query` was a stub returning `HOST_PROTOCOL_FAILED` unconditionally, so every right-click
  // died at `kernel.queryGeometry step:"refused"` and no pin could ever be placed. The wire-level
  // `query()` in `host/supervisor/model/session.ts` was already built and tested; only the
  // adapter leg was missing.
  describe("query() — the real geometry leg", () => {
    const FRAME = { sourceHash: "a".repeat(64), frameSeq: "1" } as const;

    test("resolves a hit into core's closed checkHit result", async () => {
      const adapter = createHostSupervisorAdapter(
        depsFor({ createSession: fakeFactory({ hitElementId: "btn-submit" }) }),
      );
      const session = await adapter.preview(specFor());
      if ("code" in session) throw session;

      const result = await session.query(FRAME, { kind: "hit", x: 15, y: 6 });
      if ("code" in result) throw new Error(`expected a resolved query, got ${result.safeMessage}`);
      expect(result.result).toEqual({ kind: "checkHit", hit: { id: "btn-submit" } });
    });

    test("completes the incarnation identity the Kernel cannot know (sessionId + nonce)", async () => {
      const asked: FrameIdentity[] = [];
      const adapter = createHostSupervisorAdapter(
        depsFor({ createSession: fakeFactory({ hitElementId: "btn-submit", asked }) }),
      );
      const session = await adapter.preview(specFor());
      if ("code" in session) throw session;

      await session.query(FRAME, { kind: "hit", x: 15, y: 6 });

      expect(asked[0]).toEqual({
        sessionId: "session-1",
        nonce: "1".padStart(32, "0"),
        sourceHash: FRAME.sourceHash,
        frameSeq: FRAME.frameSeq,
      });
    });

    test("resolves a pin-anchor's fractional point inside the hit element's own rect", async () => {
      const adapter = createHostSupervisorAdapter(
        depsFor({
          createSession: fakeFactory({
            hitElementId: "btn-submit",
            rect: { x: 10, y: 5, width: 20, height: 4 },
          }),
        }),
      );
      const session = await adapter.preview(specFor());
      if ("code" in session) throw session;

      const result = await session.query(FRAME, { kind: "pin-anchor", x: 15, y: 6 });
      if ("code" in result) throw new Error(`expected a resolved query, got ${result.safeMessage}`);
      expect(result.resolvedAnchor).toEqual({
        pageSlug: "dash",
        elementId: "btn-submit",
        fx: 0.25, // (15 - 10) / 20
        fy: 0.25, // (6 - 5) / 4
      });
    });

    test("resolves no anchor when the point hits nothing", async () => {
      const adapter = createHostSupervisorAdapter(
        depsFor({ createSession: fakeFactory({ hitElementId: null }) }),
      );
      const session = await adapter.preview(specFor());
      if ("code" in session) throw session;

      const result = await session.query(FRAME, { kind: "pin-anchor", x: 1, y: 1 });
      if ("code" in result) throw new Error(`expected a resolved query, got ${result.safeMessage}`);
      expect(result.result).toEqual({ kind: "checkHit", hit: null });
      expect(result.resolvedAnchor).toBeNull();
    });

    test("surfaces the host's typed STALE_FRAME refusal as a retryable failure, never a fabricated miss", async () => {
      const factory = fakeFactory();
      const adapter = createHostSupervisorAdapter(
        depsFor({
          createSession: (spec, sessionDeps) => ({
            ...factory(spec, sessionDeps),
            async query() {
              return {
                ok: false as const,
                code: "STALE_FRAME" as const,
                reason: "frame 1 is not current",
              };
            },
          }),
        }),
      );
      const session = await adapter.preview(specFor());
      if ("code" in session) throw session;

      const result = await session.query(FRAME, { kind: "hit", x: 1, y: 1 });
      if (!("code" in result)) throw new Error("expected a FailureDtoV1");
      expect(result.code).toBe("HOST_PROTOCOL_FAILED");
      expect(result.retryable).toBe(true);
      expect(result.details.hostRefusal).toBe("STALE_FRAME");
    });
  });

  test("close() delegates to the underlying session close", async () => {
    const adapter = createHostSupervisorAdapter(depsFor());
    const session = await adapter.preview(specFor());
    if ("code" in session) throw session;
    await session.close();
    expect(adapter.liveCount()).toBe(0);
  });

  // THE IDENTITY INVARIANT `core/ports/host-supervisor.ts`'s `preview` doc pins, and the defect
  // that made it worth pinning (live run 2026-08-09): this adapter used to build a fresh
  // `PreviewSession` literal per call, so `kernel.ts`'s `previous !== session` guard was
  // structurally unable to hold and every page switch closed the session it had just
  // established — dropped resize, ended frame stream, frozen pane, respawn on the next switch.
  describe("stable session identity across a page switch", () => {
    const REVISION = "b".repeat(64);

    test("two preview() calls for one live tree revision resolve the SAME object", async () => {
      const adapter = createHostSupervisorAdapter(depsFor());
      const first = await adapter.preview(specFor({ pageSlug: "dash", treeRevision: REVISION }));
      const second = await adapter.preview({
        ...specFor({ pageSlug: "calendar", treeRevision: REVISION }),
      });
      if ("code" in first || "code" in second) throw new Error("unexpected failure");
      expect(second).toBe(first);
      // Memoising the WRAPPER must not freeze what it reports: `identity` delegates to the
      // supervised session, which reads the CURRENT spec, so the switch is still visible.
      expect(second.identity.pageSlug).toBe("calendar");
    });

    test("the Kernel's establish-then-close-predecessor sequence leaves the switched-to session live", async () => {
      const adapter = createHostSupervisorAdapter(depsFor());
      const previous = await adapter.preview(specFor({ pageSlug: "dash", treeRevision: REVISION }));
      const next = await adapter.preview(specFor({ pageSlug: "calendar", treeRevision: REVISION }));
      if ("code" in previous || "code" in next) throw new Error("unexpected failure");

      // Verbatim `setActivePreviewSession`: close the displaced session, unless it IS this one.
      if (previous !== next) await previous.close();

      expect(adapter.liveCount()).toBe(1);
      // The discriminator: a closed key has no live incarnation, so `resize` comes back a
      // `FailureDtoV1` instead of the accepted `undefined` — exactly the
      // `resize(<revision>) dropped — no live incarnation` the run log recorded.
      await expect(next.resize({ w: 100, h: 30 })).resolves.toBeUndefined();
    });

    test("a different tree revision is a different session, and a retired key is not reused", async () => {
      const adapter = createHostSupervisorAdapter(depsFor());
      const first = await adapter.preview(specFor({ treeRevision: REVISION }));
      const other = await adapter.preview(specFor({ treeRevision: "c".repeat(64) }));
      if ("code" in first || "code" in other) throw new Error("unexpected failure");
      expect(other).not.toBe(first);

      // Only the LIVE window is pinned: once closed, the supervisor retires the key, so the
      // next preview() for that same revision is a genuinely new session and must not be
      // served the collected wrapper.
      await first.close();
      const reopened = await adapter.preview(specFor({ treeRevision: REVISION }));
      if ("code" in reopened) throw reopened;
      expect(reopened).not.toBe(first);
    });
  });

  test("contract: an all-clear preview() disposition matches the fake oracle's own shape", async () => {
    const fake = createFakeHostSupervisorPort();
    const real = createHostSupervisorAdapter(depsFor());
    const spec = specFor();
    const specV1 = {
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
    const fakeResult = await fake.preview(specV1);
    const realResult = await real.preview(specV1);
    expect("code" in fakeResult).toBe(false);
    expect("code" in realResult).toBe(false);
    if ("code" in fakeResult || "code" in realResult) throw new Error("unexpected failure");
    expect(realResult.identity.pageSlug).toBe(fakeResult.identity.pageSlug);
    expect(realResult.mode).toBe(fakeResult.mode);
  });
});
