import { describe, expect, test } from "bun:test";

import type { PageSlug } from "entities/page";
import { computeSourceHash as hostComputeSourceHash } from "host/session";

import type { SmokeRenderer, SmokeRequest, SmokeResult } from "../ports/smoke-renderer";
import type { GateError, PageDescriptor } from "../types";
import { runGate } from "./gate";
import { createSmokeRender } from "./smoke";

const SLUG = "dash" as PageSlug;
const TREE_ROOT = "C:/staging/design";
const ENTRY_RELPATH = "pages/dash.tsx";
const TREE_CONTEXT = {
  treeRoot: TREE_ROOT,
  expectedFiles: [{ relPath: ENTRY_RELPATH, sha256: "a".repeat(64) }],
};
const DESCRIPTOR: PageDescriptor = {
  slug: SLUG,
  meta: { kitApiVersion: 1, title: "Dashboard", minSize: { w: 80, h: 24 }, theme: "dark-default" },
};
const SOURCE = "export const x = 1\n";

/** A fake SmokeRenderer that returns a fixed result and records the last request it saw. */
function fakeRenderer(result: SmokeResult): {
  renderer: SmokeRenderer;
  lastRequest(): SmokeRequest | null;
} {
  let last: SmokeRequest | null = null;
  return {
    renderer: {
      render: async (request) => {
        last = request;
        return result;
      },
    },
    lastRequest: () => last,
  };
}

const cleanSource = `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "Dashboard", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">hi</Text></Panel>)
`;

describe("createSmokeRender (phase-3 T6, host-supervision §11.3)", () => {
  test("a clean render contributes no gate error", async () => {
    const { renderer } = fakeRenderer({ ok: true });
    const port = createSmokeRender(renderer, TREE_CONTEXT, ENTRY_RELPATH);
    const errors = await port(DESCRIPTOR, SOURCE);
    expect(errors).toEqual([]);
  });

  test("a failed render becomes one smoke-kind GateError carrying the code and message", async () => {
    const { renderer } = fakeRenderer({
      ok: false,
      code: "DESIGN_RENDER_FAILED",
      message: "render threw at <Panel>",
    });
    const port = createSmokeRender(renderer, TREE_CONTEXT, ENTRY_RELPATH);
    const errors = await port(DESCRIPTOR, SOURCE);
    expect(errors).toHaveLength(1);
    const [error] = errors as [GateError];
    expect(error.kind).toBe("smoke");
    expect(error.code).toBe("DESIGN_RENDER_FAILED");
    expect(error.message).toContain("Panel");
  });

  test("the request the renderer receives carries the tree coordinates, minSize, kitApiVersion and a 64-hex sourceHash", async () => {
    const { renderer, lastRequest } = fakeRenderer({ ok: true });
    const port = createSmokeRender(renderer, TREE_CONTEXT, ENTRY_RELPATH);
    await port(DESCRIPTOR, SOURCE);
    const request = lastRequest();
    expect(request).not.toBeNull();
    expect(request?.treeRoot).toBe(TREE_ROOT);
    expect(request?.entryRelPath).toBe(ENTRY_RELPATH);
    expect(request?.expectedFiles).toEqual(TREE_CONTEXT.expectedFiles);
    expect(request?.size).toEqual({ w: 80, h: 24 });
    expect(request?.kitApiVersion).toBe(1);
    expect(request?.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the gate-side hash matches the host's computeSourceHash over the same UTF-8 bytes (parity pin)", async () => {
    const { renderer, lastRequest } = fakeRenderer({ ok: true });
    const port = createSmokeRender(renderer, TREE_CONTEXT, ENTRY_RELPATH);
    await port(DESCRIPTOR, SOURCE);
    const gateHash = lastRequest()?.sourceHash;
    const hostHash = hostComputeSourceHash(new TextEncoder().encode(SOURCE));
    expect(gateHash).toBe(hostHash);
  });

  test("runGate rejects a candidate whose smoke render fails", async () => {
    const { renderer } = fakeRenderer({ ok: false, code: "MOUNT_FAILED", message: "mount failed" });
    const result = await runGate(
      { source: cleanSource, slug: SLUG, entryRelPath: ENTRY_RELPATH },
      { smokeRender: createSmokeRender(renderer, TREE_CONTEXT, ENTRY_RELPATH) },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "smoke" && e.code === "MOUNT_FAILED")).toBe(true);
  });

  test("runGate passes a candidate whose smoke render succeeds", async () => {
    const { renderer } = fakeRenderer({ ok: true });
    const result = await runGate(
      { source: cleanSource, slug: SLUG, entryRelPath: ENTRY_RELPATH },
      { smokeRender: createSmokeRender(renderer, TREE_CONTEXT, ENTRY_RELPATH) },
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
