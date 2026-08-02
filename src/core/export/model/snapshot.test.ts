import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import { reatomExportStateMachine } from "core/machines";
import {
  createFakeDesignStoreForPages,
  createFakeProjectWriteCoordinator,
  defaultFakeEntry,
} from "core/ports/fakes";
import type { FailureDtoV1 } from "core/protocol";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";
import type { Clock } from "infrastructure/clock";

import type { ExportPageInputV1 } from "../types";
import { captureExportSnapshot } from "./snapshot";

/**
 * TESTING NOTE (matching `core/turns/model/finalize.test.ts`'s own documented hazard):
 * `context.start(cb)` pops its isolated frame the instant `cb()` returns, even for an async
 * `cb`, at its first internal `await`. Every test below builds the machine/fakes and calls
 * `captureExportSnapshot` SYNCHRONOUSLY inside `context.start(() => {...})`, capturing the
 * returned promise without awaiting inside the callback, and reads `machine.phase()` only
 * through a `wrap(() => machine.phase())` reader built in that same synchronous window.
 */

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

function manualClock(startMs: number): Clock & { advance: (ms: number) => void } {
  let now = startMs;
  return { now: () => new Date(now), advance: (ms: number) => (now += ms) };
}

const HOME_INPUT: ExportPageInputV1 = {
  pageSlug: slug("home"),
  sourcePath: "pages/home/page.tsx",
  manifestIndex: 0,
  minSize: { w: 80, h: 24 },
  theme: "default",
  kitApiVersion: 1,
};

const ABOUT_INPUT: ExportPageInputV1 = {
  pageSlug: slug("about"),
  sourcePath: "pages/about/page.tsx",
  manifestIndex: 1,
  minSize: { w: 80, h: 24 },
  theme: "default",
  kitApiVersion: 1,
};

const HOME_BYTES = new Uint8Array([1, 2, 3]);
const ABOUT_BYTES = new Uint8Array([4, 5, 6]);
const HOME_HASH = "a".repeat(64);
const ABOUT_HASH = "b".repeat(64);

function setup() {
  const machine = reatomExportStateMachine();
  const projectWrite = createFakeProjectWriteCoordinator();
  const designReader = createFakeDesignStoreForPages({
    pages: [
      { pageSlug: slug("home"), bytes: HOME_BYTES, sha256: HOME_HASH },
      { pageSlug: slug("about"), bytes: ABOUT_BYTES, sha256: ABOUT_HASH },
    ],
  });
  const clock = manualClock(1_700_000_000_000);
  return { machine, projectWrite, designReader, clock };
}

describe("captureExportSnapshot", () => {
  test("rejects NO_PAGES for an empty page list without touching the machine or the mutex", async () => {
    const { call, readPhase, projectWrite } = context.start(() => {
      const { machine, projectWrite, designReader, clock } = setup();
      const call = captureExportSnapshot(
        { machine, projectWrite, designReader, clock },
        { pages: [] },
      );
      return { call, readPhase: wrap(() => machine.phase()), projectWrite };
    });

    const result = await call;

    expect(result).toEqual({ kind: "illegal", code: "NO_PAGES" });
    expect(projectWrite.calls).toEqual([]);
    expect(readPhase()).toBe("idle");
  });

  test("captures ordered pages with fresh bytes/hash, releases the permit, and reaches rendering", async () => {
    const { call, readPhase, designReader } = context.start(() => {
      const { machine, projectWrite, designReader, clock } = setup();
      const call = captureExportSnapshot(
        { machine, projectWrite, designReader, clock },
        { pages: [HOME_INPUT, ABOUT_INPUT] },
      );
      return { call, readPhase: wrap(() => machine.phase()), designReader };
    });

    const result = await call;

    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") return;
    expect(result.snapshot.pages).toEqual([
      { ...HOME_INPUT, sourceHash: HOME_HASH, bytes: HOME_BYTES },
      { ...ABOUT_INPUT, sourceHash: ABOUT_HASH, bytes: ABOUT_BYTES },
    ]);
    expect(result.snapshot.capturedAt).toBe("2023-11-14T22:13:20.000Z");
    expect(readPhase()).toBe("rendering");
    // `design/pages.json` read exactly ONCE for the whole permit-held capture, then one
    // `readTreeFile` per page's own entry. Not once per page: two reads inside one snapshot
    // could in principle disagree, and this window is supposed to be one coherent read.
    expect(designReader.calls.map((c) => c.method)).toEqual([
      "readManifest",
      "readTreeFile",
      "readTreeFile",
    ]);
  });

  test("acquires the permit before reading any page and releases it before returning", async () => {
    const { call, order } = context.start(() => {
      const { machine, projectWrite, designReader, clock } = setup();
      const order: string[] = [];
      const tracedProjectWrite = {
        ...projectWrite,
        acquire: async () => {
          order.push("acquire");
          return projectWrite.acquire();
        },
        release: (permit: Parameters<typeof projectWrite.release>[0]) => {
          order.push("release");
          projectWrite.release(permit);
        },
      };
      const tracedPageReader = {
        ...designReader,
        readTreeFile: async (relPath: string) => {
          order.push(`readTreeFile:${relPath}`);
          return designReader.readTreeFile(relPath);
        },
      };
      const call = captureExportSnapshot(
        { machine, projectWrite: tracedProjectWrite, designReader: tracedPageReader, clock },
        { pages: [HOME_INPUT, ABOUT_INPUT] },
      );
      return { call, order };
    });

    await call;

    expect(order).toEqual([
      "acquire",
      `readTreeFile:${defaultFakeEntry(slug("home"))}`,
      `readTreeFile:${defaultFakeEntry(slug("about"))}`,
      "release",
    ]);
  });

  test("rejects with OPERATION_BUSY and touches no port when the export machine is not idle", async () => {
    const { call, projectWrite, designReader } = context.start(() => {
      const machine = reatomExportStateMachine();
      machine.apply("kernel.export.begin"); // now "preparing", not "idle"
      const projectWrite = createFakeProjectWriteCoordinator();
      const designReader = createFakeDesignStoreForPages({ pages: [] });
      const clock = manualClock(1_700_000_000_000);
      const call = captureExportSnapshot(
        { machine, projectWrite, designReader, clock },
        { pages: [HOME_INPUT] },
      );
      return { call, projectWrite, designReader };
    });

    const result = await call;

    expect(result).toEqual({ kind: "illegal", code: "OPERATION_BUSY" });
    expect(projectWrite.calls).toEqual([]);
    expect(designReader.calls).toEqual([]);
  });

  test("a page read failure releases the permit, fails the machine back to idle, and reports the failure", async () => {
    const FAILURE: FailureDtoV1 = {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: "disk unreadable",
      details: {},
    };
    const { call, readPhase, projectWrite } = context.start(() => {
      const { machine, projectWrite, designReader, clock } = setup();
      designReader.failNext("readTreeFile", FAILURE);
      const call = captureExportSnapshot(
        { machine, projectWrite, designReader, clock },
        { pages: [HOME_INPUT, ABOUT_INPUT] },
      );
      return { call, readPhase: wrap(() => machine.phase()), projectWrite };
    });

    const result = await call;

    expect(result.kind).toBe("failed");
    expect(readPhase()).toBe("idle");
    expect(projectWrite.calls.map((c) => c.method)).toEqual([
      "acquire",
      "acquire-granted",
      "release",
    ]);
  });
});
