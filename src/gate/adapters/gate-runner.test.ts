import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createFakeGateRunner } from "core/ports/fakes";
import type { PageSlug } from "entities/page";

import type { SmokeRenderer, SmokeRequest, SmokeResult } from "../ports/smoke-renderer";
import { createGateRunnerAdapter } from "./gate-runner";

const SLUG = "dash" as PageSlug;

const cleanSource = `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "Dashboard", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">hi</Text></Panel>)
`;

/** A trivial, offline-runnable fake SmokeRenderer — a fixed scripted result, no host process. */
function fakeSmokeRenderer(result: SmokeResult): SmokeRenderer {
  return { render: async (_request: SmokeRequest) => result };
}

/**
 * Mimics the REAL host `SmokeRenderer` (`host/adapters/smoke-renderer.ts` -> `host/session
 * /model/source-mount.ts`'s `loadPage`): resolves `request.sourcePath` on disk via `Bun.file`,
 * exactly as the real host child process does, instead of returning a scripted result. Used
 * to prove this adapter's `sourcePath` wiring for real — a fixed `{ok:true}` fake (like every
 * other test in this file) would never notice a bare, unresolvable `${slug}.tsx` default.
 */
function realDiskSmokeRenderer(): SmokeRenderer {
  return {
    render: async (request: SmokeRequest) => {
      const bytes = await Bun.file(request.sourcePath)
        .bytes()
        .catch(() => null);
      if (bytes === null) {
        return {
          ok: false,
          code: "SMOKE_SOURCE_UNREADABLE",
          message: `cannot read ${request.sourcePath}`,
        };
      }
      return { ok: true };
    },
  };
}

describe("createGateRunnerAdapter", () => {
  test("runPage() passes a clean candidate with a clean smoke render, carrying the descriptor", async () => {
    const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const result = await adapter.runPage({ source: cleanSource, slug: SLUG });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.descriptor).toEqual({
      slug: SLUG,
      meta: {
        kitApiVersion: 1,
        title: "Dashboard",
        minSize: { w: 80, h: 24 },
        theme: "dark-default",
      },
    });
  });

  test("runPage() fails a candidate with a forbidden import, never reaching the smoke stage", async () => {
    let smokeRan = false;
    const adapter = createGateRunnerAdapter({
      smokeRenderer: {
        render: async () => {
          smokeRan = true;
          return { ok: true };
        },
      },
    });
    const result = await adapter.runPage({
      source: `import { x } from "lodash"\n${cleanSource}`,
      slug: SLUG,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "import")).toBe(true);
    expect(smokeRan).toBe(false);
  });

  test("runPage() surfaces a failed smoke render as a smoke-kind error", async () => {
    const adapter = createGateRunnerAdapter({
      smokeRenderer: fakeSmokeRenderer({
        ok: false,
        code: "DESIGN_RENDER_FAILED",
        message: "boom",
      }),
    });
    const result = await adapter.runPage({ source: cleanSource, slug: SLUG });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "smoke" && e.code === "DESIGN_RENDER_FAILED")).toBe(
      true,
    );
  });

  test("runPage() without compilerAssets/runtimeDts skips the type-check stage (an honest omission, not a fabricated pass)", async () => {
    const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const result = await adapter.runPage({ source: cleanSource, slug: SLUG });
    expect(result.errors.some((e) => e.kind === "type")).toBe(false);
  });

  test("runPage() forwards an injected checkManifest port", async () => {
    let checkManifestCalled = false;
    const adapter = createGateRunnerAdapter({
      smokeRenderer: fakeSmokeRenderer({ ok: true }),
      checkManifest: () => {
        checkManifestCalled = true;
        return [];
      },
    });
    await adapter.runPage({ source: cleanSource, slug: SLUG });
    expect(checkManifestCalled).toBe(true);
  });

  test("runManifestSlice() validates a clean manifest slice", async () => {
    const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const result = await adapter.runManifestSlice({
      manifestText: JSON.stringify({ pages: ["dash"] }),
      presentSlugs: [SLUG],
    });
    expect(result.errors).toEqual([]);
    expect(result.slice).toEqual({ pages: [SLUG], active: null });
  });

  test("runManifestSlice() rejects a manifest listing a page absent from staging", async () => {
    const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const result = await adapter.runManifestSlice({
      manifestText: JSON.stringify({ pages: ["missing-page"] }),
      presentSlugs: [SLUG],
    });
    expect(result.slice).toBeNull();
    expect(result.errors.some((e) => e.code === "MANIFEST_UNKNOWN_PAGE")).toBe(true);
  });

  test("runPage() threads sourcePath into the smoke stage so a REAL disk-resolving renderer finds the staged candidate file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-runner-smoke-"));
    const stagedPath = path.join(dir, "dash.tsx");
    fs.writeFileSync(stagedPath, cleanSource);
    try {
      const adapter = createGateRunnerAdapter({ smokeRenderer: realDiskSmokeRenderer() });
      const result = await adapter.runPage({
        source: cleanSource,
        slug: SLUG,
        sourcePath: stagedPath,
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runPage() without sourcePath falls back to a bare `${slug}.tsx`, which a REAL disk-resolving renderer cannot find", async () => {
    const adapter = createGateRunnerAdapter({ smokeRenderer: realDiskSmokeRenderer() });
    const result = await adapter.runPage({ source: cleanSource, slug: SLUG });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.kind === "smoke" && e.code === "SMOKE_SOURCE_UNREADABLE"),
    ).toBe(true);
  });

  test("contract: an all-clear candidate matches the fake oracle's own default GateRunResultV1 shape", async () => {
    const fake = createFakeGateRunner();
    const real = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const input = { source: cleanSource, slug: SLUG };
    const fakeResult = await fake.runPage(input);
    const realResult = await real.runPage(input);
    expect(realResult.ok).toBe(fakeResult.ok);
    expect(realResult.descriptor?.slug).toBe(fakeResult.descriptor?.slug);
  });
});
