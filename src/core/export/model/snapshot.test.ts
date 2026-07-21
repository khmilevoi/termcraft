import { describe, expect, test } from "bun:test"
import { context, wrap } from "@reatom/core"

import type { Clock } from "infrastructure/clock"
import { parsePageSlug } from "entities/page"
import type { PageSlug } from "entities/page"
import type { FailureDtoV1 } from "core/protocol"
import { createFakePageStore, createFakeProjectWriteCoordinator } from "core/ports/fakes"
import { reatomExportStateMachine } from "core/machines"

import type { ExportPageInputV1 } from "../types"
import { captureExportSnapshot } from "./snapshot"

/**
 * TESTING NOTE (matching `core/turns/model/finalize.test.ts`'s own documented hazard):
 * `context.start(cb)` pops its isolated frame the instant `cb()` returns, even for an async
 * `cb`, at its first internal `await`. Every test below builds the machine/fakes and calls
 * `captureExportSnapshot` SYNCHRONOUSLY inside `context.start(() => {...})`, capturing the
 * returned promise without awaiting inside the callback, and reads `machine.phase()` only
 * through a `wrap(() => machine.phase())` reader built in that same synchronous window.
 */

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value)
  if (parsed instanceof Error) throw parsed
  return parsed
}

function manualClock(startMs: number): Clock & { advance: (ms: number) => void } {
  let now = startMs
  return { now: () => new Date(now), advance: (ms: number) => (now += ms) }
}

const HOME_INPUT: ExportPageInputV1 = {
  pageSlug: slug("home"),
  sourcePath: "pages/home/page.tsx",
  manifestIndex: 0,
  minSize: { w: 80, h: 24 },
  theme: "default",
  kitApiVersion: 1,
}

const ABOUT_INPUT: ExportPageInputV1 = {
  pageSlug: slug("about"),
  sourcePath: "pages/about/page.tsx",
  manifestIndex: 1,
  minSize: { w: 80, h: 24 },
  theme: "default",
  kitApiVersion: 1,
}

const HOME_BYTES = new Uint8Array([1, 2, 3])
const ABOUT_BYTES = new Uint8Array([4, 5, 6])
const HOME_HASH = "a".repeat(64)
const ABOUT_HASH = "b".repeat(64)

function setup() {
  const machine = reatomExportStateMachine()
  const projectWrite = createFakeProjectWriteCoordinator()
  const pageReader = createFakePageStore({
    order: [slug("home"), slug("about")],
    sources: new Map([
      [slug("home"), { bytes: HOME_BYTES, sourceHash: HOME_HASH }],
      [slug("about"), { bytes: ABOUT_BYTES, sourceHash: ABOUT_HASH }],
    ]),
  })
  const clock = manualClock(1_700_000_000_000)
  return { machine, projectWrite, pageReader, clock }
}

describe("captureExportSnapshot", () => {
  test("rejects NO_PAGES for an empty page list without touching the machine or the mutex", async () => {
    const { call, readPhase, projectWrite } = context.start(() => {
      const { machine, projectWrite, pageReader, clock } = setup()
      const call = captureExportSnapshot({ machine, projectWrite, pageReader, clock }, { pages: [] })
      return { call, readPhase: wrap(() => machine.phase()), projectWrite }
    })

    const result = await call

    expect(result).toEqual({ kind: "illegal", code: "NO_PAGES" })
    expect(projectWrite.calls).toEqual([])
    expect(readPhase()).toBe("idle")
  })

  test("captures ordered pages with fresh bytes/hash, releases the permit, and reaches rendering", async () => {
    const { call, readPhase, projectWrite, pageReader } = context.start(() => {
      const { machine, projectWrite, pageReader, clock } = setup()
      const call = captureExportSnapshot(
        { machine, projectWrite, pageReader, clock },
        { pages: [HOME_INPUT, ABOUT_INPUT] },
      )
      return { call, readPhase: wrap(() => machine.phase()), projectWrite, pageReader }
    })

    const result = await call

    expect(result.kind).toBe("captured")
    if (result.kind !== "captured") return
    expect(result.snapshot.pages).toEqual([
      { ...HOME_INPUT, sourceHash: HOME_HASH, bytes: HOME_BYTES },
      { ...ABOUT_INPUT, sourceHash: ABOUT_HASH, bytes: ABOUT_BYTES },
    ])
    expect(result.snapshot.capturedAt).toBe("2023-11-14T22:13:20.000Z")
    expect(readPhase()).toBe("rendering")
    expect(pageReader.calls.map((c) => c.method)).toEqual(["readSource", "readSource"])
  })

  test("acquires the permit before reading any page and releases it before returning", async () => {
    const { call, order } = context.start(() => {
      const { machine, projectWrite, pageReader, clock } = setup()
      const order: string[] = []
      const tracedProjectWrite = {
        ...projectWrite,
        acquire: async () => {
          order.push("acquire")
          return projectWrite.acquire()
        },
        release: (permit: Parameters<typeof projectWrite.release>[0]) => {
          order.push("release")
          projectWrite.release(permit)
        },
      }
      const tracedPageReader = {
        ...pageReader,
        readSource: async (pageSlug: PageSlug) => {
          order.push(`readSource:${pageSlug}`)
          return pageReader.readSource(pageSlug)
        },
      }
      const call = captureExportSnapshot(
        { machine, projectWrite: tracedProjectWrite, pageReader: tracedPageReader, clock },
        { pages: [HOME_INPUT, ABOUT_INPUT] },
      )
      return { call, order }
    })

    await call

    expect(order).toEqual(["acquire", "readSource:home", "readSource:about", "release"])
  })

  test("rejects with OPERATION_BUSY and touches no port when the export machine is not idle", async () => {
    const { call, projectWrite, pageReader } = context.start(() => {
      const machine = reatomExportStateMachine()
      machine.apply("kernel.export.begin") // now "preparing", not "idle"
      const projectWrite = createFakeProjectWriteCoordinator()
      const pageReader = createFakePageStore({ order: [], sources: new Map() })
      const clock = manualClock(1_700_000_000_000)
      const call = captureExportSnapshot({ machine, projectWrite, pageReader, clock }, { pages: [HOME_INPUT] })
      return { call, projectWrite, pageReader }
    })

    const result = await call

    expect(result).toEqual({ kind: "illegal", code: "OPERATION_BUSY" })
    expect(projectWrite.calls).toEqual([])
    expect(pageReader.calls).toEqual([])
  })

  test("a page read failure releases the permit, fails the machine back to idle, and reports the failure", async () => {
    const FAILURE: FailureDtoV1 = { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: "disk unreadable", details: {} }
    const { call, readPhase, projectWrite } = context.start(() => {
      const { machine, projectWrite, pageReader, clock } = setup()
      pageReader.failNext("readSource", FAILURE)
      const call = captureExportSnapshot({ machine, projectWrite, pageReader, clock }, { pages: [HOME_INPUT, ABOUT_INPUT] })
      return { call, readPhase: wrap(() => machine.phase()), projectWrite }
    })

    const result = await call

    expect(result.kind).toBe("failed")
    expect(readPhase()).toBe("idle")
    expect(projectWrite.calls.map((c) => c.method)).toEqual(["acquire", "acquire-granted", "release"])
  })
})
