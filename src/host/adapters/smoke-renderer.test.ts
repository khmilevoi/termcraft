import { describe, expect, test } from "bun:test";

import type { SmokeRequest } from "gate";
import { DEFAULT_THEME_ID } from "runtime";

import { createManualClock } from "../supervisor";
import { TEST_RUNTIME_DECLARATION, createOneShotChild } from "./scripted-one-shot";
import { createSmokeRendererAdapter } from "./smoke-renderer";

function requestFor(overrides: Partial<SmokeRequest> = {}): SmokeRequest {
  return {
    sourcePath: "/scratch/dash.tsx",
    sourceHash: "a".repeat(64),
    size: { w: 80, h: 24 },
    kitApiVersion: 1,
    ...overrides,
  };
}

describe("createSmokeRendererAdapter (M4: SmokeRenderer over runOneShotSession)", () => {
  test("render() reports { ok: true } for a clean one-shot session", async () => {
    const request = requestFor();
    const adapter = createSmokeRendererAdapter({
      spawnFor: () => ({ cmd: ["_host"] }),
      spawn: () =>
        createOneShotChild({
          mode: "smoke",
          interactionMode: "static",
          pageSlug: "smoke-check",
          sourcePath: request.sourcePath,
          sourceHash: request.sourceHash,
          kitApiVersion: request.kitApiVersion,
          size: request.size,
          theme: "dark-default",
          capabilities: { colorDepth: 24 },
        }),
      clock: createManualClock(),
      runtimeDeclaration: TEST_RUNTIME_DECLARATION,
    });
    const result = await adapter.render(request);
    expect(result).toEqual({ ok: true });
  });

  test("render() maps a one-shot mount failure to { ok: false, code, message }", async () => {
    const request = requestFor();
    const adapter = createSmokeRendererAdapter({
      spawnFor: () => ({ cmd: ["_host"] }),
      spawn: () =>
        createOneShotChild(
          {
            mode: "smoke",
            interactionMode: "static",
            pageSlug: "smoke-check",
            sourcePath: request.sourcePath,
            sourceHash: request.sourceHash,
            kitApiVersion: request.kitApiVersion,
            size: request.size,
            theme: "dark-default",
            capabilities: { colorDepth: 24 },
          },
          { mountErrorCode: "SOURCE_HASH_MISMATCH" },
        ),
      clock: createManualClock(),
      runtimeDeclaration: TEST_RUNTIME_DECLARATION,
    });
    const result = await adapter.render(request);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failed SmokeResult");
    expect(result.code).toBe("SOURCE_HASH_MISMATCH");
    expect(result.message.length).toBeGreaterThan(0);
  });

  test("the composed HostSessionSpec fills the missing pageSlug/theme/capabilities with fixed smoke defaults", async () => {
    const request = requestFor();
    const seenSpecs: { pageSlug: string; theme: string; colorDepth: number }[] = [];
    const adapter = createSmokeRendererAdapter({
      spawnFor: (spec) => {
        seenSpecs.push({
          pageSlug: spec.pageSlug,
          theme: spec.theme,
          colorDepth: spec.capabilities.colorDepth,
        });
        return { cmd: ["_host"] };
      },
      spawn: () =>
        createOneShotChild({
          mode: "smoke",
          interactionMode: "static",
          pageSlug: "smoke-check",
          sourcePath: request.sourcePath,
          sourceHash: request.sourceHash,
          kitApiVersion: request.kitApiVersion,
          size: request.size,
          theme: "dark-default",
          capabilities: { colorDepth: 24 },
        }),
      clock: createManualClock(),
      runtimeDeclaration: TEST_RUNTIME_DECLARATION,
    });
    await adapter.render(request);
    expect(seenSpecs).toHaveLength(1);
    // Pin the documented fixed smoke defaults themselves (smoke-renderer.ts's own
    // header note), not just their non-emptiness — a regression that swapped in a
    // different (even otherwise-valid) slug/theme/depth must fail this test.
    expect(seenSpecs[0]?.pageSlug).toBe("smoke-check");
    expect(seenSpecs[0]?.theme).toBe(DEFAULT_THEME_ID);
    expect(seenSpecs[0]?.colorDepth).toBe(24);
  });
});
