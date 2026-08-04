import { describe, expect, test } from "bun:test";

import { createFakeHostSupervisorPort } from "core/ports/fakes";

import { PROTOCOL_HARD_LIMITS } from "../protocol";
import type { ControlEnvelope, ProtocolError, RuntimeDeclarationBundleV1 } from "../protocol";
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

/** A one-incarnation-per-key immediate-ready `createSession` test seam, mirroring `supervisor.test.ts`'s own fake factory. */
function fakeFactory() {
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
      async query() {
        return {
          ok: true,
          frameIdentity: { sessionId, nonce, sourceHash: spec.sourceHash, frameSeq: "1" },
          result: {},
        };
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

  test("setTheme() and query() report the documented not-yet-wired gap as a FailureDtoV1, never a fabricated success", async () => {
    const adapter = createHostSupervisorAdapter(depsFor());
    const session = await adapter.preview(specFor());
    if ("code" in session) throw session;
    const themeResult = await session.setTheme("light", { colorDepth: 8 });
    expect(themeResult).toBeDefined();
    if (themeResult === undefined) throw new Error("expected a FailureDtoV1");
    expect(themeResult.code).toBe("HOST_PROTOCOL_FAILED");
    const queryResult = await session.query("00000000-0000-7000-8000-000000000000", {
      kind: "layout",
    });
    if (!("code" in queryResult)) throw new Error("expected a FailureDtoV1");
    expect(queryResult.code).toBe("HOST_PROTOCOL_FAILED");
  });

  test("close() delegates to the underlying session close", async () => {
    const adapter = createHostSupervisorAdapter(depsFor());
    const session = await adapter.preview(specFor());
    if ("code" in session) throw session;
    await session.close();
    expect(adapter.liveCount()).toBe(0);
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
