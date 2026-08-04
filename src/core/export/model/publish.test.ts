import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import type { ExportAction, ExportState, StateMachine } from "core/machines";
import { reatomExportStateMachine } from "core/machines";
import {
  type FakeCallSequence,
  createFakeDesignStoreForPages,
  createFakeExportPublish,
  createFakeProjectWriteCoordinator,
  createSequence,
} from "core/ports/fakes";
import type { FailureDtoV1 } from "core/protocol";
import { computeSourceHash } from "entities/design-tree";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";
import type { Clock } from "infrastructure/clock";

import type {
  ExportPageInputV1,
  ExportPageSnapshotV1,
  ExportSnapshotV1,
  ExportTreeFileV1,
} from "../types";
import type { ExportPackageFileV1 } from "./package";
import { type PublishExportInputV1, publishExport } from "./publish";

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

function manualClock(startMs: number): Clock {
  return { now: () => new Date(startMs) };
}

/** Records every action applied to `inner`, so a test can assert exactly which edges fired — not just the final phase, since two different edges (`complete` and `failBeforeIntent`) both land on `idle`. */
function spyMachine(inner: StateMachine<ExportState, ExportAction>): {
  readonly machine: StateMachine<ExportState, ExportAction>;
  readonly actions: readonly ExportAction[];
} {
  const actions: ExportAction[] = [];
  const machine: StateMachine<ExportState, ExportAction> = {
    phase: inner.phase,
    phaseAtom: inner.phaseAtom,
    canApply: inner.canApply,
    apply: (action) => {
      actions.push(action);
      return inner.apply(action);
    },
  };
  return { machine, actions };
}

// Task 7 fix round 1: `sourceHash` below was `"a".repeat(64)`, fabricated and unrelated to
// `bytes`. `setup()`'s own `currentHash` override (further down, `"c".repeat(64)`) stays a
// deliberately DIFFERENT, hand-picked literal — that one test is specifically about "the page
// was edited after capture" (a real drift/mismatch scenario), so it must not derive from these
// same bytes.
const HOME_BYTES = new Uint8Array([1]);

const HOME: ExportPageSnapshotV1 = {
  pageSlug: slug("home"),
  treeRoot: "/proj/.termcraft/design",
  entryRelPath: "pages/home.tsx",
  expectedFiles: [{ relPath: "pages/home.tsx", sha256: "0".repeat(64) }],
  manifestIndex: 0,
  minSize: { w: 80, h: 24 },
  theme: "default",
  kitApiVersion: 1,
  // Inert for this file's assertions on purpose: `settingsStillMatch` deliberately does NOT
  // compare `closureHash` (design-tree phase 2 Task 8 changed only the RENDER KEY; §12.5's
  // revalidation vocabulary is `sourceHash` + the identity/settings list, and widening it is a
  // separate decision). A non-null placeholder, distinct from `sourceHash`.
  closureHash: "c".repeat(64),
  sourceHash: computeSourceHash(HOME_BYTES),
  bytes: HOME_BYTES,
};

/**
 * The canonical tree these snapshots were captured from. Small and fixed: nothing in this
 * file asserts on the tree itself, but a snapshot without one would describe a design whose
 * pages import files that do not exist.
 */
const TREE: readonly ExportTreeFileV1[] = [
  { relPath: "pages.json", bytes: new TextEncoder().encode('{"schemaVersion":1,"pages":[]}') },
];

const SNAPSHOT: ExportSnapshotV1 = {
  pages: [HOME],
  tree: TREE,
  capturedAt: "2024-01-01T00:00:00.000Z",
};

function currentPageInput(overrides: Partial<ExportPageInputV1> = {}): ExportPageInputV1 {
  return {
    pageSlug: HOME.pageSlug,
    treeRoot: HOME.treeRoot,
    entryRelPath: HOME.entryRelPath,
    expectedFiles: HOME.expectedFiles,
    manifestIndex: HOME.manifestIndex,
    minSize: HOME.minSize,
    theme: HOME.theme,
    kitApiVersion: HOME.kitApiVersion,
    closureHash: HOME.closureHash,
    ...overrides,
  };
}

function setup(options?: { readonly currentHash?: string; readonly sequence?: FakeCallSequence }) {
  const rawMachine = reatomExportStateMachine();
  rawMachine.apply("kernel.export.begin");
  rawMachine.apply("kernel.export.beginRendering"); // now "rendering", the legal source for beginPublication
  const { machine, actions } = spyMachine(rawMachine);
  const projectWrite = createFakeProjectWriteCoordinator({ sequence: options?.sequence });
  const designReader = createFakeDesignStoreForPages({
    pages: [
      {
        pageSlug: HOME.pageSlug,
        bytes: HOME.bytes,
        sha256: options?.currentHash ?? HOME.sourceHash,
      },
    ],
  });
  const clock = manualClock(1_700_000_000_000);
  const exportPublish = createFakeExportPublish({ sequence: options?.sequence });
  return { machine, actions, projectWrite, designReader, clock, exportPublish };
}

const FILES: readonly ExportPackageFileV1[] = [
  { relPath: "design-prompt.md", bytes: new TextEncoder().encode("prompt") },
];

function baseInput(overrides: Partial<PublishExportInputV1> = {}): PublishExportInputV1 {
  return {
    snapshot: SNAPSHOT,
    currentPages: [currentPageInput()],
    renders: [],
    files: FILES,
    ...overrides,
  };
}

describe("publishExport", () => {
  test("on a matching snapshot it reacquires, revalidates, records intent, and completes to idle", async () => {
    const { call, readPhase, projectWrite, designReader } = context.start(() => {
      const { machine, projectWrite, designReader, clock, exportPublish } = setup();
      const call = publishExport(
        { machine, projectWrite, designReader, clock, exportPublish },
        baseInput(),
      );
      return { call, readPhase: wrap(() => machine.phase()), projectWrite, designReader };
    });

    const result = await call;

    expect(result.kind).toBe("published");
    if (result.kind !== "published") return;
    expect(result.intent.pageCount).toBe(1);
    expect(typeof result.intent.generationId).toBe("string");
    expect(readPhase()).toBe("idle");
    expect(projectWrite.calls.map((c) => c.method)).toEqual([
      "acquire",
      "acquire-granted",
      "release",
    ]);
    expect(designReader.calls.map((c) => c.method)).toEqual(["readManifest", "readTreeFile"]);
  });

  test("rejects with OPERATION_BUSY and touches no port when the export machine is not in rendering", async () => {
    const { call, projectWrite, designReader } = context.start(() => {
      const machine = reatomExportStateMachine(); // stays "idle" — beginPublication is illegal from idle
      const projectWrite = createFakeProjectWriteCoordinator();
      const designReader = createFakeDesignStoreForPages({ pages: [] });
      const clock = manualClock(1_700_000_000_000);
      const exportPublish = createFakeExportPublish();
      const call = publishExport(
        { machine, projectWrite, designReader, clock, exportPublish },
        baseInput(),
      );
      return { call, projectWrite, designReader };
    });

    const result = await call;

    expect(result).toEqual({ kind: "illegal", code: "OPERATION_BUSY" });
    expect(projectWrite.calls).toEqual([]);
    expect(designReader.calls).toEqual([]);
  });

  test("refuses wholesale, before ever reacquiring, when a render failed", async () => {
    const FAILURE: FailureDtoV1 = {
      code: "EXPORT_RENDER_FAILED",
      retryable: true,
      safeMessage: "renderer crashed",
      details: {},
    };
    const { call, projectWrite } = context.start(() => {
      const { machine, projectWrite, designReader, clock, exportPublish } = setup();
      const call = publishExport(
        { machine, projectWrite, designReader, clock, exportPublish },
        baseInput({ renders: [{ pageSlug: HOME.pageSlug, outcome: FAILURE }] }),
      );
      return { call, projectWrite };
    });

    const result = await call;

    expect(result).toEqual({ kind: "failed", failure: FAILURE });
    expect(projectWrite.calls).toEqual([]);
  });

  test("a page-list/settings mismatch is stale: releases, fails before intent, and reports EXPORT_SNAPSHOT_STALE", async () => {
    const { call, readPhase, projectWrite } = context.start(() => {
      const { machine, projectWrite, designReader, clock, exportPublish } = setup();
      const call = publishExport(
        { machine, projectWrite, designReader, clock, exportPublish },
        baseInput({ currentPages: [currentPageInput({ theme: "dark" })] }), // theme drifted since capture
      );
      return { call, readPhase: wrap(() => machine.phase()), projectWrite };
    });

    const result = await call;

    expect(result.kind).toBe("stale");
    if (result.kind !== "stale") return;
    expect(result.failure.code).toBe("EXPORT_SNAPSHOT_STALE");
    expect(readPhase()).toBe("idle");
    expect(projectWrite.calls.map((c) => c.method)).toEqual([
      "acquire",
      "acquire-granted",
      "release",
    ]);
  });

  test("a live source-hash drift since capture is stale: releases, fails before intent, and reports EXPORT_SNAPSHOT_STALE", async () => {
    const { call, readPhase, projectWrite } = context.start(() => {
      const { machine, projectWrite, designReader, clock, exportPublish } = setup({
        currentHash: "c".repeat(64),
      }); // page edited after capture
      const call = publishExport(
        { machine, projectWrite, designReader, clock, exportPublish },
        baseInput(),
      );
      return { call, readPhase: wrap(() => machine.phase()), projectWrite };
    });

    const result = await call;

    expect(result.kind).toBe("stale");
    if (result.kind !== "stale") return;
    expect(result.failure.code).toBe("EXPORT_SNAPSHOT_STALE");
    expect(readPhase()).toBe("idle");
    expect(projectWrite.calls.map((c) => c.method)).toEqual([
      "acquire",
      "acquire-granted",
      "release",
    ]);
  });

  test("a page-count mismatch (a page removed since capture) is stale", async () => {
    const { call } = context.start(() => {
      const { machine, projectWrite, designReader, clock, exportPublish } = setup();
      const call = publishExport(
        { machine, projectWrite, designReader, clock, exportPublish },
        baseInput({ currentPages: [] }),
      );
      return { call };
    });

    const result = await call;

    expect(result.kind).toBe("stale");
  });

  test("a revalidation read failure releases, fails before intent, and passes the failure through", async () => {
    const FAILURE: FailureDtoV1 = {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: "disk unreadable",
      details: {},
    };
    const { call, readPhase, projectWrite } = context.start(() => {
      const { machine, projectWrite, designReader, clock, exportPublish } = setup();
      designReader.failNext("readTreeFile", FAILURE);
      const call = publishExport(
        { machine, projectWrite, designReader, clock, exportPublish },
        baseInput(),
      );
      return { call, readPhase: wrap(() => machine.phase()), projectWrite };
    });

    const result = await call;

    expect(result).toEqual({ kind: "failed", failure: FAILURE });
    expect(readPhase()).toBe("idle");
    expect(projectWrite.calls.map((c) => c.method)).toEqual([
      "acquire",
      "acquire-granted",
      "release",
    ]);
  });

  test("writes the publication through the export-publish port exactly once, under the permit, and completes to idle", async () => {
    // One SHARED sequence across both fakes: `projectWrite.calls` and `exportPublish.calls`
    // are two independent arrays, so checking each one's own method order separately cannot
    // prove `publish()` happened WHILE the permit was still held — a regression that
    // released the permit before calling `publish()` would leave each array's own order
    // unchanged. Merging both logs by `seq` and asserting the combined order is what
    // actually catches a release-before-publish regression.
    const sequence = createSequence();
    const { call, readPhase, projectWrite, exportPublish } = context.start(() => {
      const { machine, projectWrite, designReader, clock, exportPublish } = setup({ sequence });
      const call = publishExport(
        { machine, projectWrite, designReader, clock, exportPublish },
        baseInput(),
      );
      return { call, readPhase: wrap(() => machine.phase()), projectWrite, exportPublish };
    });

    const result = await call;

    expect(result.kind).toBe("published");
    if (result.kind !== "published") return;
    // WP-5 Task B3: `publishExport` also reads the current pointer (D-Q5) before building
    // the plan — a genuine second call on this same fake, not a `publish()`.
    expect(exportPublish.calls.map((c) => c.method)).toEqual(["readPointer", "publish"]);
    const publishCall = exportPublish.calls.find((c) => c.method === "publish");
    if (publishCall?.method !== "publish") throw new Error("fixture bug: expected a publish call");
    expect(publishCall.plan.generationId).toBe(result.intent.generationId);
    expect(publishCall.plan.pageCount).toBe(result.intent.pageCount);
    expect(publishCall.plan.createdAt).toBe(result.intent.recordedAt);
    expect(publishCall.plan.operations.length).toBeGreaterThan(0);
    expect(publishCall.plan.payloads.size).toBeGreaterThan(0);
    expect(readPhase()).toBe("idle");
    expect(projectWrite.calls.map((c) => c.method)).toEqual([
      "acquire",
      "acquire-granted",
      "release",
    ]);
    // The permit is released exactly once — after both port calls, not before them. Proved
    // by merging both fakes' own ordered logs and reading the combined method sequence.
    const combined = [...projectWrite.calls, ...exportPublish.calls].sort((a, b) => a.seq - b.seq);
    expect(combined.map((entry) => entry.method)).toEqual([
      "acquire",
      "acquire-granted",
      "readPointer",
      "publish",
      "release",
    ]);
  });

  test("a corrupt existing pointer (readPointer failure) releases, fails before intent, and returns the failure — never reaches publish()", async () => {
    const READ_FAILURE: FailureDtoV1 = {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: "export/current.json is corrupt",
      details: {},
    };
    const { call, readPhase, projectWrite, exportPublish, actions } = context.start(() => {
      const { machine, actions, projectWrite, designReader, clock, exportPublish } = setup();
      exportPublish.failNextRead(READ_FAILURE);
      const call = publishExport(
        { machine, projectWrite, designReader, clock, exportPublish },
        baseInput(),
      );
      return { call, readPhase: wrap(() => machine.phase()), projectWrite, exportPublish, actions };
    });

    const result = await call;

    expect(result).toEqual({ kind: "failed", failure: READ_FAILURE });
    expect(readPhase()).toBe("idle");
    expect(actions).toContain("kernel.export.failBeforeIntent");
    expect(exportPublish.calls.map((c) => c.method)).toEqual(["readPointer"]);
    expect(projectWrite.calls.map((c) => c.method)).toEqual([
      "acquire",
      "acquire-granted",
      "release",
    ]);
  });

  test("builds a non-empty plan from the assembled files, keyed by the newly minted generationId", async () => {
    const { call } = context.start(() => {
      const { machine, projectWrite, designReader, clock, exportPublish } = setup();
      const call = publishExport(
        { machine, projectWrite, designReader, clock, exportPublish },
        baseInput({
          files: [
            { relPath: "design-prompt.md", bytes: new TextEncoder().encode("prompt") },
            { relPath: "layout/home.json", bytes: new TextEncoder().encode('{"80x24":{}}') },
          ],
        }),
      );
      return { call };
    });

    const result = await call;

    expect(result.kind).toBe("published");
    if (result.kind !== "published") return;
    expect(result.intent.generationId.length).toBeGreaterThan(0);
  });

  test("does not complete the machine when the export-publish port fails; releases, fails before intent, and returns the failure", async () => {
    const FAILURE: FailureDtoV1 = {
      code: "EXPORT_PUBLICATION_FAILED",
      retryable: false,
      safeMessage: "transaction journal write failed",
      details: {},
    };
    const { call, readPhase, projectWrite, actions } = context.start(() => {
      const { machine, actions, projectWrite, designReader, clock, exportPublish } = setup();
      exportPublish.failNext(FAILURE);
      const call = publishExport(
        { machine, projectWrite, designReader, clock, exportPublish },
        baseInput(),
      );
      return { call, readPhase: wrap(() => machine.phase()), projectWrite, actions };
    });

    const result = await call;

    expect(result).toEqual({ kind: "failed", failure: FAILURE });
    expect(readPhase()).toBe("idle");
    expect(actions).not.toContain("kernel.export.complete");
    expect(actions).toContain("kernel.export.failBeforeIntent");
    expect(projectWrite.calls.map((c) => c.method)).toEqual([
      "acquire",
      "acquire-granted",
      "release",
    ]);
  });

  test("classifies an EXPORT_SNAPSHOT_STALE failure from the port as stale, not failed", async () => {
    const FAILURE: FailureDtoV1 = {
      code: "EXPORT_SNAPSHOT_STALE",
      retryable: true,
      safeMessage: "store-side precondition drifted before commit",
      details: {},
    };
    const { call, actions } = context.start(() => {
      const { machine, actions, projectWrite, designReader, clock, exportPublish } = setup();
      exportPublish.failNext(FAILURE);
      const call = publishExport(
        { machine, projectWrite, designReader, clock, exportPublish },
        baseInput(),
      );
      return { call, actions };
    });

    const result = await call;

    expect(result).toEqual({ kind: "stale", failure: FAILURE });
    expect(actions).not.toContain("kernel.export.complete");
  });
});
