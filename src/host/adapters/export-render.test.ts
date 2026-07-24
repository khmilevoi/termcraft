import { describe, expect, test } from "bun:test";

import type { ExportRenderTaskV1 } from "core/ports";
import { createFakeExportRenderPort } from "core/ports/fakes";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";

import { createManualClock } from "../supervisor";
import type { HostSessionSpec } from "../types";
import { createExportRenderAdapter } from "./export-render";
import { TEST_RUNTIME_DECLARATION, createOneShotChild } from "./scripted-one-shot";

const parsedDashSlug = parsePageSlug("dash");
if (parsedDashSlug instanceof Error) throw parsedDashSlug;
const DASH_SLUG: PageSlug = parsedDashSlug;

const specForTask: HostSessionSpec = {
  mode: "export",
  interactionMode: "static",
  pageSlug: DASH_SLUG,
  sourcePath: "/scratch/dash.tsx",
  sourceHash: "a".repeat(64),
  kitApiVersion: 1,
  size: { w: 80, h: 24 },
  theme: "dark-default",
  capabilities: { colorDepth: 24 },
};

function taskFor(overrides: Partial<ExportRenderTaskV1> = {}): ExportRenderTaskV1 {
  return {
    pageSlug: DASH_SLUG,
    sourcePath: specForTask.sourcePath,
    sourceHash: specForTask.sourceHash,
    kitApiVersion: specForTask.kitApiVersion,
    size: specForTask.size,
    theme: specForTask.theme,
    manifestIndex: 0,
    ...overrides,
  };
}

describe("createExportRenderAdapter", () => {
  test("poolBounds derive from resolveExportWorkerCount + the §11.4 fixed multiplier", () => {
    const adapter = createExportRenderAdapter({
      spawn: () => createOneShotChild(specForTask),
      command: { cmd: ["_host"] },
      clock: createManualClock(),
      cpuCount: 8,
    });
    expect(adapter.poolBounds).toEqual({ minWorkers: 1, maxWorkers: 4, readyQueueMultiplier: 2 });
  });

  test("poolBounds respects a machine-local workers override, clamped 1-8", () => {
    const adapter = createExportRenderAdapter({
      spawn: () => createOneShotChild(specForTask),
      command: { cmd: ["_host"] },
      clock: createManualClock(),
      cpuCount: 8,
      workers: 12,
    });
    expect(adapter.poolBounds.maxWorkers).toBe(8);
  });

  test("runtimeDeclaration defaults to EMBEDDED_RUNTIME_DECLARATION and is overridable", () => {
    const adapter = createExportRenderAdapter({
      spawn: () => createOneShotChild(specForTask),
      command: { cmd: ["_host"] },
      clock: createManualClock(),
      runtimeDeclaration: TEST_RUNTIME_DECLARATION,
    });
    expect(adapter.runtimeDeclaration).toEqual(TEST_RUNTIME_DECLARATION);
  });

  test("renderOne() drives a real one-shot export session and maps the sealed frame to opaque bytes", async () => {
    const adapter = createExportRenderAdapter({
      spawn: () => createOneShotChild(specForTask),
      command: { cmd: ["_host"] },
      clock: createManualClock(),
      runtimeDeclaration: TEST_RUNTIME_DECLARATION,
      cpuCount: 2,
    });
    const result = await adapter.renderOne(taskFor({ manifestIndex: 3 }));
    if ("code" in result) throw result;
    expect(result.manifestIndex).toBe(3);
    expect(result.styledFrame.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(result.textFrame)).toContain("ok");
    // Layout is documented as unavailable until host's one-shot capture gains a real
    // layout-tree reply (see this adapter's header note) — a faithful empty marker,
    // never fabricated layout data.
    expect(result.layout.length).toBe(0);
  });

  test("renderOne() maps a one-shot mount failure to an EXPORT_RENDER_FAILED FailureDtoV1", async () => {
    const adapter = createExportRenderAdapter({
      spawn: () => createOneShotChild(specForTask, { mountErrorCode: "SOURCE_HASH_MISMATCH" }),
      command: { cmd: ["_host"] },
      clock: createManualClock(),
      runtimeDeclaration: TEST_RUNTIME_DECLARATION,
    });
    const result = await adapter.renderOne(taskFor());
    if (!("code" in result)) throw new Error("expected a FailureDtoV1");
    expect(result.code).toBe("EXPORT_RENDER_FAILED");
    expect(result.retryable).toBe(false);
  });

  test("contract: a successful renderOne() disposition shares the fake oracle's manifestIndex-carrying shape", async () => {
    const fake = createFakeExportRenderPort();
    const real = createExportRenderAdapter({
      spawn: () => createOneShotChild(specForTask),
      command: { cmd: ["_host"] },
      clock: createManualClock(),
      runtimeDeclaration: TEST_RUNTIME_DECLARATION,
    });
    const task = taskFor({ manifestIndex: 7 });
    const fakeResult = await fake.renderOne(task);
    const realResult = await real.renderOne(task);
    if ("code" in fakeResult || "code" in realResult) throw new Error("unexpected failure");
    expect(realResult.manifestIndex).toBe(fakeResult.manifestIndex);
  });
});
