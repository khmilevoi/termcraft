import { describe, expect, test } from "bun:test"

import { parsePageSlug } from "entities/page"
import type { PageSlug } from "entities/page"
import type { FailureDtoV1 } from "core/protocol"
import type { CreateTurnWorkspaceInputV1 } from "../staging"
import { createFakeStagingService } from "./staging"

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value)
  if (parsed instanceof Error) throw parsed
  return parsed
}

const FAILURE: FailureDtoV1 = { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: "workspace write failed", details: {} }

const input: CreateTurnWorkspaceInputV1 = {
  turnId: "t1",
  targetChatId: "chat-1",
  pages: [{ pageSlug: slug("home"), sourcePath: "C:/proj/pages/home/index.tsx" }],
  manifestSlice: new Uint8Array([1, 2]),
  runtimeDocs: [],
  readSet: { manifest: null, canonicalPages: [], chat: { length: 0, prefixSha256: "a".repeat(64) }, pins: [] },
}

describe("createFakeStagingService", () => {
  test("createTurnWorkspace() builds a workspace rooted at a path derived from turnId", async () => {
    const service = createFakeStagingService()
    const workspace = await service.createTurnWorkspace(input)
    if ("code" in workspace) throw new Error("unexpected failure")
    expect(workspace.turnId).toBe("t1")
    expect(workspace.root).toContain("t1")
    expect(workspace.files.length).toBeGreaterThan(0)
  })

  test("snapshotToCandidate() freezes the workspace into a candidate at a different root", async () => {
    const service = createFakeStagingService()
    const workspace = await service.createTurnWorkspace(input)
    if ("code" in workspace) throw new Error("unexpected failure")
    const candidate = await service.snapshotToCandidate(workspace)
    if ("code" in candidate) throw new Error("unexpected failure")
    expect(candidate.root).not.toBe(workspace.root)
    expect(candidate.files).toEqual(workspace.files)
  })

  test("retireWorkspace() then failing to retire twice is still safe (idempotent no-op)", async () => {
    const service = createFakeStagingService()
    const workspace = await service.createTurnWorkspace(input)
    if ("code" in workspace) throw new Error("unexpected failure")
    const first = await service.retireWorkspace(workspace)
    const second = await service.retireWorkspace(workspace)
    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
  })

  test("failNext() queues one failure for createTurnWorkspace()", async () => {
    const service = createFakeStagingService()
    service.failNext("createTurnWorkspace", FAILURE)
    const first = await service.createTurnWorkspace(input)
    expect(first).toEqual(FAILURE)
    const second = await service.createTurnWorkspace(input)
    expect("code" in second).toBe(false)
  })

  test("records calls across the whole workspace lifecycle in order", async () => {
    const service = createFakeStagingService()
    const workspace = await service.createTurnWorkspace(input)
    if ("code" in workspace) throw new Error("unexpected failure")
    await service.snapshotToCandidate(workspace)
    await service.retireWorkspace(workspace)
    expect(service.calls.map((c) => c.method)).toEqual(["createTurnWorkspace", "snapshotToCandidate", "retireWorkspace"])
  })
})
