import { afterEach, describe, expect, test } from "bun:test";

import { CURRENT_KIT_API_VERSION } from "runtime";

import { PROTOCOL_HARD_LIMITS, ProtocolError } from "../../protocol";
import type { RuntimeDeclarationBundleV1 } from "../../protocol";
import type { HostSessionSpec } from "../../types";
import type { HostSession } from "../types";
import { createSystemClock } from "./clock";
import { createHostSession } from "./session";
import { createBunSpawn } from "./spawn";

const runtimeDeclaration: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: CURRENT_KIT_API_VERSION,
  supportedKitApiVersions: [CURRENT_KIT_API_VERSION],
  publicCapabilityIds: [],
};
const wrapperDir = `${import.meta.dir}/../../../../docs/spikes/04-supervisor-derisk`;
const WRAPPER_RELPATH = "host-wrapper.ts";
const wrapper = `${wrapperDir}/${WRAPPER_RELPATH}`;
const sessions: HostSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop();
});

describe("real-spawn handshake + graceful stop (integration)", () => {
  test("negotiates host.hello against the genuine 2C child, fails mount with a typed SOURCE_HASH_MISMATCH, then stops cleanly", async () => {
    const spec: HostSessionSpec = {
      mode: "preview",
      interactionMode: "static",
      pageSlug: "probe",
      // A real, readable source (the wrapper itself) paired with a deliberately-wrong
      // hash. The genuine 2C child reads the bytes, recomputes the SHA-256, and the
      // mismatch yields the typed SOURCE_HASH_MISMATCH error. That code is produced
      // ONLY at the mount stage — never during the handshake — so observing it below
      // proves the entire real path ran: Bun.spawn → framed client.hello → host.hello
      // received AND verified (negotiation) → mount sent → child read & hashed the
      // source. A real mountable fixture page that reaches "ready" is deferred to 2D-4.
      treeRoot: wrapperDir,
      entryRelPath: WRAPPER_RELPATH,
      // The SAME deliberately-wrong hash the identity carries, so the supervisor's own
      // identity-vs-inventory check (task 15, `buildMountBody`) agrees and the mismatch is
      // discovered where this test means it to be: in the child, after it reads the bytes.
      expectedFiles: [{ relPath: WRAPPER_RELPATH, sha256: "0".repeat(64) }],
      sourceHash: "0".repeat(64),
      kitApiVersion: CURRENT_KIT_API_VERSION,
      size: { w: 80, h: 24 },
      theme: "dark-default",
      capabilities: { colorDepth: 24 },
    };
    const session = createHostSession(spec, {
      spawn: createBunSpawn(),
      command: { cmd: [process.execPath, wrapper, "_host", "--stdio"] },
      clock: createSystemClock(),
      runtimeDeclaration,
      offeredLimits: PROTOCOL_HARD_LIMITS,
    });
    sessions.push(session);

    // Await the real round-trip. start() resolves to the mount-stage
    // SOURCE_HASH_MISMATCH, which is UNREACHABLE without a completed handshake. A
    // spawn/handshake/negotiation regression would instead resolve to SPAWN_FAILED /
    // HANDSHAKE_TIMEOUT / a negotiation ProtocolError — none of which is
    // SOURCE_HASH_MISMATCH — so this assertion actually distinguishes success from
    // failure (unlike a bare phase check, where every failure path lands on "failed").
    const outcome = await session.start();
    expect(outcome).toBeInstanceOf(ProtocolError);
    if (!(outcome instanceof ProtocolError))
      throw new Error(`expected a ProtocolError, got ${String(outcome)}`);
    expect(outcome.code).toBe("SOURCE_HASH_MISMATCH");
    expect(session.phase).toBe("failed");

    const stop = await session.stop();
    expect(stop.phase).toBe("stopped");
  }, 15_000);
});
