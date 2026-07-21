import { describe, expect, test } from "bun:test";

import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";

import type { GateRunResultV1 } from "../gate-runner";
import { createFakeGateRunner } from "./gate-runner";

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

describe("createFakeGateRunner", () => {
  test("runPage() defaults to a clean pass with a synthesized descriptor", async () => {
    const runner = createFakeGateRunner();
    const result = await runner.runPage({ source: "export const meta = {}", slug: slug("home") });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.descriptor?.slug).toBe(slug("home"));
  });

  test("runManifestSlice() defaults to echoing the present slugs with no errors", async () => {
    const runner = createFakeGateRunner();
    const result = await runner.runManifestSlice({
      manifestText: "{}",
      presentSlugs: [slug("home"), slug("about")],
    });
    expect(result.errors).toEqual([]);
    expect(result.slice).toEqual({ pages: [slug("home"), slug("about")], active: null });
  });

  test("queueRunPageResult() scripts the next runPage() outcome, one shot", async () => {
    const runner = createFakeGateRunner();
    const scripted: GateRunResultV1 = {
      ok: false,
      errors: [{ kind: "type", code: "TS2322", message: "type mismatch" }],
      warnings: [],
      descriptor: null,
    };
    runner.queueRunPageResult(scripted);
    const first = await runner.runPage({ source: "bad", slug: slug("home") });
    expect(first).toEqual(scripted);
    const second = await runner.runPage({ source: "ok", slug: slug("home") });
    expect(second.ok).toBe(true);
  });

  test("records calls with their inputs in order", async () => {
    const runner = createFakeGateRunner();
    await runner.runManifestSlice({ manifestText: "{}", presentSlugs: [slug("home")] });
    await runner.runPage({ source: "x", slug: slug("home") });
    expect(runner.calls.map((c) => c.method)).toEqual(["runManifestSlice", "runPage"]);
  });
});
