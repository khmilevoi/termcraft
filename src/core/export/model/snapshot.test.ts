import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import { reatomExportStateMachine } from "core/machines";
import {
  createFakeDesignStoreForPages,
  createFakeProjectWriteCoordinator,
  defaultFakeEntry,
} from "core/ports/fakes";
import type { FailureDtoV1 } from "core/protocol";
import {
  PAGES_MANIFEST_RELPATH,
  computeClosureHash,
  computeSourceHash,
} from "entities/design-tree";
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

const HOME_BYTES = new Uint8Array([1, 2, 3]);
const ABOUT_BYTES = new Uint8Array([4, 5, 6]);
// Task 7 fix round 1: was `"a"`/`"b".repeat(64)` — fabricated, unrelated to `HOME_BYTES`/
// `ABOUT_BYTES` above despite the direct round-trip assertion below (`sourceHash: HOME_HASH`)
// depending on it matching what the fake actually reports for those exact bytes.
const HOME_HASH = computeSourceHash(HOME_BYTES);
const ABOUT_HASH = computeSourceHash(ABOUT_BYTES);

/**
 * A single-file closure hash computed the way `readCanonicalTreeIndex` computes it (design-tree
 * phase 2 Task 8) — never a hand-picked literal. `closureHash` is CALLER-RESOLVED input here
 * (`resolveExportPageInputs` fills it from the tree index): this file's job is to prove
 * `captureExportSnapshot` carries it through into the snapshot untouched, alongside every other
 * caller-resolved setting.
 */
function singleFileClosureHash(relPath: string, sha256: string): string {
  const hash = computeClosureHash({
    files: [relPath],
    sha256Of: (candidate) => (candidate === relPath ? sha256 : null),
  });
  if (hash === null) throw new Error(`singleFileClosureHash: unexpected null for "${relPath}"`);
  return hash;
}

const HOME_INPUT: ExportPageInputV1 = {
  pageSlug: slug("home"),
  treeRoot: "/proj/.termcraft/design",
  entryRelPath: "pages/home.tsx",
  expectedFiles: [{ relPath: "pages/home.tsx", sha256: "0".repeat(64) }],
  manifestIndex: 0,
  minSize: { w: 80, h: 24 },
  theme: "default",
  kitApiVersion: 1,
  closureHash: singleFileClosureHash("pages/home.tsx", HOME_HASH),
};

const ABOUT_INPUT: ExportPageInputV1 = {
  pageSlug: slug("about"),
  treeRoot: "/proj/.termcraft/design",
  entryRelPath: "pages/about.tsx",
  expectedFiles: [{ relPath: "pages/about.tsx", sha256: "0".repeat(64) }],
  manifestIndex: 1,
  minSize: { w: 80, h: 24 },
  theme: "default",
  kitApiVersion: 1,
  // An UNPROVABLE closure, carried through as `null` rather than smoothed over: the snapshot
  // must report exactly what the tree index reported, and `render-jobs.ts` turns it into a
  // forced cache miss.
  closureHash: null,
};

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
    // Spelled out because the spreads above would hide it: the caller-resolved `closureHash`
    // reaches the snapshot verbatim, INCLUDING an honest `null` (design-tree phase 2 Task 8).
    // `sourceHash` stays the entry file's own live hash and is never conflated with it.
    expect(result.snapshot.pages.map((page) => page.closureHash)).toEqual([
      HOME_INPUT.closureHash,
      null,
    ]);
    expect(result.snapshot.capturedAt).toBe("2023-11-14T22:13:20.000Z");
    expect(readPhase()).toBe("rendering");
    // `design/pages.json` read exactly ONCE for the whole permit-held capture, then one
    // `readTreeFile` per page's own entry. Not once per page: two reads inside one snapshot
    // could in principle disagree, and this window is supposed to be one coherent read.
    // Then the WHOLE tree (task 16, design §11): one `listTree` and one `readTreeFile` per
    // tree file — the fake's tree here is `pages.json` plus both entries.
    expect(designReader.calls.map((c) => c.method)).toEqual([
      "readManifest",
      "readTreeFile",
      "readTreeFile",
      "listTree",
      "readTreeFile",
      "readTreeFile",
      "readTreeFile",
    ]);
  });

  test("captures the WHOLE canonical tree, not one file per page (design §11)", async () => {
    const { call } = context.start(() => {
      const { machine, projectWrite, designReader, clock } = setup();
      const call = captureExportSnapshot(
        { machine, projectWrite, designReader, clock },
        { pages: [HOME_INPUT, ABOUT_INPUT] },
      );
      return { call };
    });

    const result = await call;
    if (result.kind !== "captured") throw new Error(`expected captured, got ${result.kind}`);
    // `pages.json` is in the tree and is no page's entry — the proof that this is the tree's
    // own inventory rather than a per-page derivation.
    expect([...result.snapshot.tree].map((file) => file.relPath).sort()).toEqual(
      [
        PAGES_MANIFEST_RELPATH,
        defaultFakeEntry(slug("about")),
        defaultFakeEntry(slug("home")),
      ].sort(),
    );
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

    // Every read — the two page entries AND the whole-tree capture — happens INSIDE the one
    // permit window. A tree file read after `release` could belong to a different revision
    // than the entry that imports it (task 16).
    expect(order[0]).toBe("acquire");
    expect(order[order.length - 1]).toBe("release");
    expect(order).toContain(`readTreeFile:${defaultFakeEntry(slug("home"))}`);
    expect(order).toContain(`readTreeFile:${defaultFakeEntry(slug("about"))}`);
    expect(order).toContain(`readTreeFile:${PAGES_MANIFEST_RELPATH}`);
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
