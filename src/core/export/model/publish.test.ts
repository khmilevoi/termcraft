import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import type { ExportAction, ExportState, StateMachine } from "core/machines";
import { reatomExportStateMachine } from "core/machines";
import {
  createFakeExportPublish,
  createFakePageStore,
  createFakeProjectWriteCoordinator,
} from "core/ports/fakes";
import type { FailureDtoV1 } from "core/protocol";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";
import type { Clock } from "infrastructure/clock";

import type { ExportPageInputV1, ExportPageSnapshotV1, ExportSnapshotV1 } from "../types";
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

const HOME: ExportPageSnapshotV1 = {
  pageSlug: slug("home"),
  sourcePath: "pages/home/page.tsx",
  manifestIndex: 0,
  minSize: { w: 80, h: 24 },
  theme: "default",
  kitApiVersion: 1,
  sourceHash: "a".repeat(64),
  bytes: new Uint8Array([1]),
};

const SNAPSHOT: ExportSnapshotV1 = { pages: [HOME], capturedAt: "2024-01-01T00:00:00.000Z" };

function currentPageInput(overrides: Partial<ExportPageInputV1> = {}): ExportPageInputV1 {
  return {
    pageSlug: HOME.pageSlug,
    sourcePath: HOME.sourcePath,
    manifestIndex: HOME.manifestIndex,
    minSize: HOME.minSize,
    theme: HOME.theme,
    kitApiVersion: HOME.kitApiVersion,
    ...overrides,
  };
}

function setup(options?: { readonly currentHash?: string }) {
  const rawMachine = reatomExportStateMachine();
  rawMachine.apply("kernel.export.begin");
  rawMachine.apply("kernel.export.beginRendering"); // now "rendering", the legal source for beginPublication
  const { machine, actions } = spyMachine(rawMachine);
  const projectWrite = createFakeProjectWriteCoordinator();
  const pageReader = createFakePageStore({
    order: [HOME.pageSlug],
    sources: new Map([
      [HOME.pageSlug, { bytes: HOME.bytes, sourceHash: options?.currentHash ?? HOME.sourceHash }],
    ]),
  });
  const clock = manualClock(1_700_000_000_000);
  const exportPublish = createFakeExportPublish();
  return { machine, actions, projectWrite, pageReader, clock, exportPublish };
}

function baseInput(overrides: Partial<PublishExportInputV1> = {}): PublishExportInputV1 {
  return {
    snapshot: SNAPSHOT,
    currentPages: [currentPageInput()],
    renders: [],
    ...overrides,
  };
}

describe("publishExport", () => {
  test("on a matching snapshot it reacquires, revalidates, records intent, and completes to idle", async () => {
    const { call, readPhase, projectWrite, pageReader } = context.start(() => {
      const { machine, projectWrite, pageReader, clock, exportPublish } = setup();
      const call = publishExport(
        { machine, projectWrite, pageReader, clock, exportPublish },
        baseInput(),
      );
      return { call, readPhase: wrap(() => machine.phase()), projectWrite, pageReader };
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
    expect(pageReader.calls.map((c) => c.method)).toEqual(["readSource"]);
  });

  test("rejects with OPERATION_BUSY and touches no port when the export machine is not in rendering", async () => {
    const { call, projectWrite, pageReader } = context.start(() => {
      const machine = reatomExportStateMachine(); // stays "idle" — beginPublication is illegal from idle
      const projectWrite = createFakeProjectWriteCoordinator();
      const pageReader = createFakePageStore({ order: [], sources: new Map() });
      const clock = manualClock(1_700_000_000_000);
      const exportPublish = createFakeExportPublish();
      const call = publishExport(
        { machine, projectWrite, pageReader, clock, exportPublish },
        baseInput(),
      );
      return { call, projectWrite, pageReader };
    });

    const result = await call;

    expect(result).toEqual({ kind: "illegal", code: "OPERATION_BUSY" });
    expect(projectWrite.calls).toEqual([]);
    expect(pageReader.calls).toEqual([]);
  });

  test("refuses wholesale, before ever reacquiring, when a render failed", async () => {
    const FAILURE: FailureDtoV1 = {
      code: "EXPORT_RENDER_FAILED",
      retryable: true,
      safeMessage: "renderer crashed",
      details: {},
    };
    const { call, projectWrite } = context.start(() => {
      const { machine, projectWrite, pageReader, clock, exportPublish } = setup();
      const call = publishExport(
        { machine, projectWrite, pageReader, clock, exportPublish },
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
      const { machine, projectWrite, pageReader, clock, exportPublish } = setup();
      const call = publishExport(
        { machine, projectWrite, pageReader, clock, exportPublish },
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
      const { machine, projectWrite, pageReader, clock, exportPublish } = setup({
        currentHash: "c".repeat(64),
      }); // page edited after capture
      const call = publishExport(
        { machine, projectWrite, pageReader, clock, exportPublish },
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
      const { machine, projectWrite, pageReader, clock, exportPublish } = setup();
      const call = publishExport(
        { machine, projectWrite, pageReader, clock, exportPublish },
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
      const { machine, projectWrite, pageReader, clock, exportPublish } = setup();
      pageReader.failNext("readSource", FAILURE);
      const call = publishExport(
        { machine, projectWrite, pageReader, clock, exportPublish },
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
    const { call, readPhase, projectWrite, exportPublish } = context.start(() => {
      const { machine, projectWrite, pageReader, clock, exportPublish } = setup();
      const call = publishExport(
        { machine, projectWrite, pageReader, clock, exportPublish },
        baseInput(),
      );
      return { call, readPhase: wrap(() => machine.phase()), projectWrite, exportPublish };
    });

    const result = await call;

    expect(result.kind).toBe("published");
    if (result.kind !== "published") return;
    expect(exportPublish.calls.length).toBe(1);
    expect(exportPublish.calls[0]?.plan.generationId).toBe(result.intent.generationId);
    expect(exportPublish.calls[0]?.plan.pageCount).toBe(result.intent.pageCount);
    expect(exportPublish.calls[0]?.plan.createdAt).toBe(result.intent.recordedAt);
    expect(readPhase()).toBe("idle");
    // The permit is released exactly once — after the port call, not before it.
    expect(projectWrite.calls.map((c) => c.method)).toEqual([
      "acquire",
      "acquire-granted",
      "release",
    ]);
  });

  test("does not complete the machine when the export-publish port fails; releases, fails before intent, and returns the failure", async () => {
    const FAILURE: FailureDtoV1 = {
      code: "EXPORT_PUBLICATION_FAILED",
      retryable: false,
      safeMessage: "transaction journal write failed",
      details: {},
    };
    const { call, readPhase, projectWrite, actions } = context.start(() => {
      const { machine, actions, projectWrite, pageReader, clock, exportPublish } = setup();
      exportPublish.failNext(FAILURE);
      const call = publishExport(
        { machine, projectWrite, pageReader, clock, exportPublish },
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
      const { machine, actions, projectWrite, pageReader, clock, exportPublish } = setup();
      exportPublish.failNext(FAILURE);
      const call = publishExport(
        { machine, projectWrite, pageReader, clock, exportPublish },
        baseInput(),
      );
      return { call, actions };
    });

    const result = await call;

    expect(result).toEqual({ kind: "stale", failure: FAILURE });
    expect(actions).not.toContain("kernel.export.complete");
  });
});
