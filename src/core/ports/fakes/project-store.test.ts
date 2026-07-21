import { describe, expect, test } from "bun:test"

import { parsePageSlug } from "entities/page"
import type { PageSlug } from "entities/page"
import type { FailureDtoV1 } from "core/protocol"
import { createFakeProjectStore } from "./project-store"

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value)
  if (parsed instanceof Error) throw parsed
  return parsed
}

const FAILURE: FailureDtoV1 = { code: "PERSISTENCE_FAILED", retryable: true, safeMessage: "disk unavailable", details: {} }

describe("createFakeProjectStore", () => {
  test("readManifest() returns the constructed manifest by default", async () => {
    const store = createFakeProjectStore({ root: "C:/proj", manifest: { pages: [slug("home")] } })
    const result = await store.readManifest()
    if (result instanceof Object && "code" in result) throw new Error("unexpected failure")
    expect(result.pages).toEqual([slug("home")])
    expect(store.root).toBe("C:/proj")
    expect(store.lease).toEqual({ root: "C:/proj" })
  })

  test("readWorkspaceState() defaults to missing/uncorrupted with nullable fields unset", async () => {
    const store = createFakeProjectStore({ root: "C:/proj" })
    const result = await store.readWorkspaceState()
    if ("code" in result) throw new Error("unexpected failure")
    expect(result.missing).toBe(true)
    expect(result.corrupt).toBe(false)
    expect(result.state.activePageSlug).toBeNull()
  })

  test("writeWorkspaceState() merges a patch onto the current state and clears missing", async () => {
    const store = createFakeProjectStore({ root: "C:/proj" })
    const written = await store.writeWorkspaceState({ activePageSlug: slug("home"), model: "claude" })
    expect(written).toBeUndefined()
    const read = await store.readWorkspaceState()
    if ("code" in read) throw new Error("unexpected failure")
    expect(read.missing).toBe(false)
    expect(read.state.activePageSlug).toBe(slug("home"))
    expect(read.state.model).toBe("claude")
  })

  test("failNext() queues exactly one failure for the named method, then reverts to success", async () => {
    const store = createFakeProjectStore({ root: "C:/proj" })
    store.failNext("readManifest", FAILURE)
    const first = await store.readManifest()
    expect(first).toEqual(FAILURE)
    const second = await store.readManifest()
    expect("code" in second).toBe(false)
  })

  test("close() records the call and never fails (no FailureDtoV1 channel)", async () => {
    const store = createFakeProjectStore({ root: "C:/proj" })
    await store.close()
    expect(store.calls.map((c) => c.method)).toEqual(["close"])
  })

  test("records calls in order across methods", async () => {
    const store = createFakeProjectStore({ root: "C:/proj" })
    await store.readManifest()
    await store.writeWorkspaceState({ model: "claude" })
    await store.readWorkspaceState()
    expect(store.calls.map((c) => c.method)).toEqual(["readManifest", "writeWorkspaceState", "readWorkspaceState"])
  })
})
