import { describe, expect, test } from "bun:test"
import { context, wrap } from "@reatom/core"

import type { Clock } from "infrastructure/clock"
import { parsePageSlug } from "entities/page"
import type { PageSlug } from "entities/page"
import type { FailureDtoV1 } from "core/protocol"
import { createFakePageStore, createFakeProjectWriteCoordinator } from "core/ports/fakes"
import { reatomExportStateMachine } from "core/machines"

import type { ExportPageInputV1, ExportPageSnapshotV1, ExportSnapshotV1 } from "../types"
import { publishExport, type PublishExportInputV1 } from "./publish"

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value)
  if (parsed instanceof Error) throw parsed
  return parsed
}

function manualClock(startMs: number): Clock {
  return { now: () => new Date(startMs) }
}

const HOME: ExportPageSnapshotV1 = {
  pageSlug: slug("home"),
  sourcePath: "pages/home/page.tsx",
  manifestIndex: 0,
  minSize: { w: 80, h: 24 },
  theme: "default",
  kitApiVersion: 1,
  sourceHash: "a".repeat(64),
  bytes: new Uint8Array([1]),
}

const SNAPSHOT: ExportSnapshotV1 = { pages: [HOME], capturedAt: "2024-01-01T00:00:00.000Z" }

function currentPageInput(overrides: Partial<ExportPageInputV1> = {}): ExportPageInputV1 {
  return {
    pageSlug: HOME.pageSlug,
    sourcePath: HOME.sourcePath,
    manifestIndex: HOME.manifestIndex,
    minSize: HOME.minSize,
    theme: HOME.theme,
    kitApiVersion: HOME.kitApiVersion,
    ...overrides,
  }
}

function setup(options?: { readonly currentHash?: string }) {
  const machine = reatomExportStateMachine()
  machine.apply("kernel.export.begin")
  machine.apply("kernel.export.beginRendering") // now "rendering", the legal source for beginPublication
  const projectWrite = createFakeProjectWriteCoordinator()
  const pageReader = createFakePageStore({
    order: [HOME.pageSlug],
    sources: new Map([[HOME.pageSlug, { bytes: HOME.bytes, sourceHash: options?.currentHash ?? HOME.sourceHash }]]),
  })
  const clock = manualClock(1_700_000_000_000)
  return { machine, projectWrite, pageReader, clock }
}

function baseInput(overrides: Partial<PublishExportInputV1> = {}): PublishExportInputV1 {
  return {
    snapshot: SNAPSHOT,
    currentPages: [currentPageInput()],
    renders: [],
    ...overrides,
  }
}

describe("publishExport", () => {
  test("on a matching snapshot it reacquires, revalidates, records intent, and completes to idle", async () => {
    const { call, readPhase, projectWrite, pageReader } = context.start(() => {
      const { machine, projectWrite, pageReader, clock } = setup()
      const call = publishExport({ machine, projectWrite, pageReader, clock }, baseInput())
      return { call, readPhase: wrap(() => machine.phase()), projectWrite, pageReader }
    })

    const result = await call

    expect(result.kind).toBe("published")
    if (result.kind !== "published") return
    expect(result.intent.pageCount).toBe(1)
    expect(typeof result.intent.generationId).toBe("string")
    expect(readPhase()).toBe("idle")
    expect(projectWrite.calls.map((c) => c.method)).toEqual(["acquire", "acquire-granted", "release"])
    expect(pageReader.calls.map((c) => c.method)).toEqual(["readSource"])
  })

  test("rejects with OPERATION_BUSY and touches no port when the export machine is not in rendering", async () => {
    const { call, projectWrite, pageReader } = context.start(() => {
      const machine = reatomExportStateMachine() // stays "idle" — beginPublication is illegal from idle
      const projectWrite = createFakeProjectWriteCoordinator()
      const pageReader = createFakePageStore({ order: [], sources: new Map() })
      const clock = manualClock(1_700_000_000_000)
      const call = publishExport({ machine, projectWrite, pageReader, clock }, baseInput())
      return { call, projectWrite, pageReader }
    })

    const result = await call

    expect(result).toEqual({ kind: "illegal", code: "OPERATION_BUSY" })
    expect(projectWrite.calls).toEqual([])
    expect(pageReader.calls).toEqual([])
  })

  test("refuses wholesale, before ever reacquiring, when a render failed", async () => {
    const FAILURE: FailureDtoV1 = { code: "EXPORT_RENDER_FAILED", retryable: true, safeMessage: "renderer crashed", details: {} }
    const { call, projectWrite } = context.start(() => {
      const { machine, projectWrite, pageReader, clock } = setup()
      const call = publishExport(
        { machine, projectWrite, pageReader, clock },
        baseInput({ renders: [{ pageSlug: HOME.pageSlug, outcome: FAILURE }] }),
      )
      return { call, projectWrite }
    })

    const result = await call

    expect(result).toEqual({ kind: "failed", failure: FAILURE })
    expect(projectWrite.calls).toEqual([])
  })

  test("a page-list/settings mismatch is stale: releases, fails before intent, and reports EXPORT_SNAPSHOT_STALE", async () => {
    const { call, readPhase, projectWrite } = context.start(() => {
      const { machine, projectWrite, pageReader, clock } = setup()
      const call = publishExport(
        { machine, projectWrite, pageReader, clock },
        baseInput({ currentPages: [currentPageInput({ theme: "dark" })] }), // theme drifted since capture
      )
      return { call, readPhase: wrap(() => machine.phase()), projectWrite }
    })

    const result = await call

    expect(result.kind).toBe("stale")
    if (result.kind !== "stale") return
    expect(result.failure.code).toBe("EXPORT_SNAPSHOT_STALE")
    expect(readPhase()).toBe("idle")
    expect(projectWrite.calls.map((c) => c.method)).toEqual(["acquire", "acquire-granted", "release"])
  })

  test("a live source-hash drift since capture is stale: releases, fails before intent, and reports EXPORT_SNAPSHOT_STALE", async () => {
    const { call, readPhase, projectWrite } = context.start(() => {
      const { machine, projectWrite, pageReader, clock } = setup({ currentHash: "c".repeat(64) }) // page edited after capture
      const call = publishExport({ machine, projectWrite, pageReader, clock }, baseInput())
      return { call, readPhase: wrap(() => machine.phase()), projectWrite }
    })

    const result = await call

    expect(result.kind).toBe("stale")
    if (result.kind !== "stale") return
    expect(result.failure.code).toBe("EXPORT_SNAPSHOT_STALE")
    expect(readPhase()).toBe("idle")
  })

  test("a page-count mismatch (a page removed since capture) is stale", async () => {
    const { call } = context.start(() => {
      const { machine, projectWrite, pageReader, clock } = setup()
      const call = publishExport({ machine, projectWrite, pageReader, clock }, baseInput({ currentPages: [] }))
      return { call }
    })

    const result = await call

    expect(result.kind).toBe("stale")
  })

  test("a revalidation read failure releases, fails before intent, and passes the failure through", async () => {
    const FAILURE: FailureDtoV1 = { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: "disk unreadable", details: {} }
    const { call, readPhase, projectWrite } = context.start(() => {
      const { machine, projectWrite, pageReader, clock } = setup()
      pageReader.failNext("readSource", FAILURE)
      const call = publishExport({ machine, projectWrite, pageReader, clock }, baseInput())
      return { call, readPhase: wrap(() => machine.phase()), projectWrite }
    })

    const result = await call

    expect(result).toEqual({ kind: "failed", failure: FAILURE })
    expect(readPhase()).toBe("idle")
    expect(projectWrite.calls.map((c) => c.method)).toEqual(["acquire", "acquire-granted", "release"])
  })
})
