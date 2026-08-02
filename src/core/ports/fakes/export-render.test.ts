import { describe, expect, test } from "bun:test";

import type { FailureDtoV1 } from "core/protocol";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";

import type { ExportRenderTaskV1 } from "../export-render";
import { createFakeExportRenderPort } from "./export-render";

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const FAILURE: FailureDtoV1 = {
  code: "EXPORT_RENDER_FAILED",
  retryable: true,
  safeMessage: "render crashed",
  details: {},
};

const task: ExportRenderTaskV1 = {
  pageSlug: slug("home"),
  treeRoot: "/proj/.termcraft/design",
  entryRelPath: "pages/home.tsx",
  expectedFiles: [{ relPath: "pages/home.tsx", sha256: "0".repeat(64) }],
  sourceHash: "a".repeat(64),
  kitApiVersion: 1,
  size: { w: 80, h: 24 },
  theme: "default",
  manifestIndex: 0,
};

describe("createFakeExportRenderPort", () => {
  test("exposes fixed pool bounds and runtime declaration", () => {
    const port = createFakeExportRenderPort();
    expect(port.poolBounds.maxWorkers).toBeGreaterThanOrEqual(port.poolBounds.minWorkers);
    expect(port.runtimeDeclaration.module).toBe("@termcraft/runtime");
  });

  test("renderOne() defaults to a successful render carrying the task's manifestIndex", async () => {
    const port = createFakeExportRenderPort();
    const result = await port.renderOne(task);
    if ("code" in result) throw new Error("unexpected failure");
    expect(result.manifestIndex).toBe(0);
  });

  test("failNext() queues one failure for renderOne()", async () => {
    const port = createFakeExportRenderPort();
    port.failNext("renderOne", FAILURE);
    const first = await port.renderOne(task);
    expect(first).toEqual(FAILURE);
    const second = await port.renderOne(task);
    expect("code" in second).toBe(false);
  });

  test("records every renderOne() call with its task", async () => {
    const port = createFakeExportRenderPort();
    await port.renderOne(task);
    expect(port.calls.map((c) => c.method)).toEqual(["renderOne"]);
    expect(port.calls[0]).toMatchObject({ method: "renderOne", manifestIndex: 0 });
  });
});
