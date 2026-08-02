import { describe, expect, test } from "bun:test";

import { PROTOCOL_HARD_LIMITS } from "../../protocol";
import type { ProtocolError, RuntimeDeclarationBundleV1 } from "../../protocol";
import type { HostSessionSpec } from "../../types";
import type { HostSessionDeps } from "../types";
import { createManualClock } from "./clock";
import { SupervisorError } from "./errors";
import { createPreviewSession } from "./preview-session";
import { livePreviewChild } from "./preview-test-host";
import type { ScriptedChild } from "./scripted-child";

const runtimeDeclaration: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: [],
};
const spec: HostSessionSpec = {
  mode: "preview",
  interactionMode: "static",
  pageSlug: "dash",
  treeRoot: "/scratch/design",
  entryRelPath: "pages/dash.tsx",
  expectedFiles: [{ relPath: "pages/dash.tsx", sha256: "a".repeat(64) }],
  sourceHash: "a".repeat(64),
  kitApiVersion: 1,
  size: { w: 80, h: 24 },
  theme: "dark-default",
  capabilities: { colorDepth: 24 },
};

// livePreviewChild is imported at the top from ./preview-test-host (a shared test
// double created in T5 Step 3, also consumed by session.test.ts).

function deps(child: ScriptedChild, clock = createManualClock()): HostSessionDeps {
  return {
    spawn: () => child,
    command: { cmd: ["_host", "--stdio"] },
    clock,
    runtimeDeclaration,
    offeredLimits: PROTOCOL_HARD_LIMITS,
  };
}

describe("createPreviewSession facade (2D-2)", () => {
  test("identity omits the nonce and mode is the host mode", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration);
    const session = createPreviewSession(spec, deps(child));
    // frames start once ready; give the internal start() a tick.
    const iterator = session.frames[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.frameSeq).toBe("1");
    expect(session.identity).not.toHaveProperty("nonce");
    expect(session.identity.sessionId.length).toBeGreaterThan(0);
    expect(session.mode).toBe("preview");
    await session.close();
  });

  test("setMode changes interactionMode only on an accepted matching response (§7)", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration);
    const session = createPreviewSession(spec, deps(child));
    await session.frames[Symbol.asyncIterator]().next(); // ensure ready
    expect(session.interactionMode).toBe("static");
    session.setMode("interactive");
    // The child echoes interactionMode:"interactive"; wait for the accepted response to land.
    for (let i = 0; i < 2_000 && session.interactionMode !== "interactive"; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(session.interactionMode).toBe("interactive");
    await session.close();
  });

  test("a rejected/mismatched set-mode response preserves the prior interactionMode (§7)", async () => {
    // The ready response always echoes "static" (see preview-test-host), so the
    // effective mode after ready is "static" regardless of spec. Request the SAME
    // mode ("static") but have the host echo a NON-matching "interactive" for every
    // set-mode reply. This makes request === prior mode and echo !== request, so the
    // §7 match-guard (`if (result.body.interactionMode === next) interactionMode = next`)
    // is the only thing standing between "static" and "interactive": a regression to
    // unconditional assignment (`interactionMode = result.body.interactionMode`) would
    // flip the value to "interactive" and fail the assertion below; the guarded code
    // leaves it at "static".
    const child = livePreviewChild(spec, runtimeDeclaration, { setModeEcho: "interactive" });
    const session = createPreviewSession(spec, deps(child));
    await session.frames[Symbol.asyncIterator]().next();
    expect(session.interactionMode).toBe("static"); // effective mode after ready
    session.setMode("static"); // request the current mode; host echoes non-matching "interactive"
    await new Promise((r) => setTimeout(r, 20));
    expect(session.interactionMode).toBe("static"); // unchanged — echo did not match the request
    await session.close();
  });

  test("close() stops the session and ends the frame iterator (§10.1)", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration);
    const session = createPreviewSession(spec, deps(child));
    const iterator = session.frames[Symbol.asyncIterator]();
    await iterator.next(); // consume the first frame
    await session.close();
    const after = await iterator.next();
    expect(after.done).toBe(true);
  });

  test("retry() is a no-op stub in 2D-2 (real restart lands in 2D-3)", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration);
    const session = createPreviewSession(spec, deps(child));
    await session.frames[Symbol.asyncIterator]().next();
    expect(() => session.retry()).not.toThrow();
    await session.close();
  });

  test("interactionMode is sourced from the accepted ready response, not the requested spec (§6.6/§7)", async () => {
    // Request "interactive", but livePreviewChild's ready echoes the effective "static".
    // The facade must report the ACCEPTED "static" — proving the value comes from the
    // response, not the spec (a spec-seeded value would wrongly stay "interactive").
    const interactiveSpec: HostSessionSpec = { ...spec, interactionMode: "interactive" };
    const child = livePreviewChild(interactiveSpec, runtimeDeclaration);
    const session = createPreviewSession(interactiveSpec, deps(child));
    await session.frames[Symbol.asyncIterator]().next(); // ready has landed
    expect(session.interactionMode).toBe("static");
    await session.close();
  });

  test("a pre-ready startup failure ends the frames iterator instead of hanging (§10.1, brief invariant 5)", async () => {
    // spawn returns a typed failure → start() fails before ready. teardown / the
    // spawn-failure broker.close must end the iterator so a consumer parked on frames
    // gets done:true, and the error is surfaced via onFatal (never swallowed).
    const fatals: (SupervisorError | ProtocolError)[] = [];
    const failing: HostSessionDeps = {
      spawn: () => new SupervisorError({ code: "SPAWN_FAILED", reason: "boom" }),
      command: { cmd: ["_host", "--stdio"] },
      clock: createManualClock(),
      runtimeDeclaration,
      offeredLimits: PROTOCOL_HARD_LIMITS,
      onFatal: (e) => fatals.push(e),
    };
    const session = createPreviewSession(spec, failing);
    const done = await session.frames[Symbol.asyncIterator]().next();
    expect(done.done).toBe(true); // iterator ended, did not hang
    for (let i = 0; i < 2_000 && fatals.length === 0; i += 1)
      await new Promise((r) => setTimeout(r, 0));
    expect(fatals[0] instanceof SupervisorError && fatals[0].code).toBe("SPAWN_FAILED");
  });
});
