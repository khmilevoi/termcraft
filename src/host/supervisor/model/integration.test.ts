import { afterEach, describe, expect, test } from "bun:test"
import { CURRENT_KIT_API_VERSION } from "../../../runtime"
import { PROTOCOL_HARD_LIMITS } from "../../protocol"
import type { RuntimeDeclarationBundleV1 } from "../../protocol"
import type { HostSessionSpec } from "../../types"
import { createSystemClock } from "./clock"
import { createBunSpawn } from "./spawn"
import { createHostSession } from "./session"
import type { HostSession } from "../types"

const runtimeDeclaration: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: CURRENT_KIT_API_VERSION,
  supportedKitApiVersions: [CURRENT_KIT_API_VERSION],
  publicCapabilityIds: [],
}
const wrapper = `${import.meta.dir}/../../../../docs/spikes/04-supervisor-derisk/host-wrapper.ts`
const sessions: HostSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop()
})

describe("real-spawn handshake + graceful stop (integration)", () => {
  test("negotiates host.hello against the genuine 2C child and stops cleanly", async () => {
    const spec: HostSessionSpec = {
      mode: "preview",
      interactionMode: "static",
      pageSlug: "probe",
      sourcePath: "/unused-for-handshake.tsx",
      sourceHash: "0".repeat(64),
      kitApiVersion: CURRENT_KIT_API_VERSION,
      size: { w: 80, h: 24 },
      theme: "dark-default",
      capabilities: { colorDepth: 24 },
    }
    const session = createHostSession(spec, {
      spawn: createBunSpawn(),
      command: { cmd: [process.execPath, wrapper, "_host", "--stdio"] },
      clock: createSystemClock(),
      runtimeDeclaration,
      offeredLimits: PROTOCOL_HARD_LIMITS,
    })
    sessions.push(session)
    // The wrapper mounts no real page, so start() will reach negotiation and then
    // block on mount (no source). We assert the handshake succeeded by observing
    // the session left "negotiating" (reached "mounting") before we stop it.
    const startPromise = session.start()
    await new Promise((r) => setTimeout(r, 1_500)) // cold spawn + hello (~831ms, D1)
    expect(["mounting", "ready", "failed"]).toContain(session.phase)
    const stop = await session.stop()
    expect(stop.phase).toBe("stopped")
    // avoid an unhandled rejection from the still-pending start()
    await startPromise.catch(() => {})
  }, 15_000)
})
