import { describe, expect, test } from "bun:test";

import type { PageSlug } from "entities/page";

import type { GateError } from "../types";
import { runGate } from "./gate";

const SLUG = "dash" as PageSlug;
const cleanSource = `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "Dashboard", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">hi</Text></Panel>)
`;

describe("runGate (§6.3 pipeline)", () => {
  test("a clean page with no injected stages passes and carries its descriptor", async () => {
    const result = await runGate({ source: cleanSource, slug: SLUG });
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

  test("a forbidden import fails the candidate with an import-kind error", async () => {
    const result = await runGate({
      source: `import { x } from "lodash"\n${cleanSource}`,
      slug: SLUG,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "import")).toBe(true);
  });

  test("a contract violation fails the candidate with a contract-kind error and null descriptor", async () => {
    const src = `export const meta = definePage({ kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 } })\nexport default reatomComponent(() => null)\n`;
    const result = await runGate({ source: src, slug: SLUG });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "contract")).toBe(true);
    expect(result.descriptor).toBeNull();
  });

  test("a determinism warning never fails a candidate", async () => {
    const src = cleanSource.replace("hi", "${Math.random()}");
    const result = await runGate({ source: src, slug: SLUG });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.kind === "unguarded-randomness")).toBe(true);
  });

  test("absent referencedIds skips the dropped-id lint", async () => {
    const result = await runGate({ source: cleanSource, slug: SLUG });
    expect(result.warnings.some((w) => w.kind === "dropped-id")).toBe(false);
  });

  test("a referencedIds entry missing from the candidate warns dropped-id without failing it", async () => {
    const result = await runGate({
      source: cleanSource,
      slug: SLUG,
      referencedIds: ["t", "cpu-gauge"],
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.kind === "dropped-id" && w.message.includes("cpu-gauge")))
      .toBe(true);
  });

  test("a raw low-level element without an id warns unpointed-element without failing the candidate", async () => {
    const src = cleanSource.replace("<Text id=\"t\">hi</Text>", "<box>hi</box>");
    const result = await runGate({ source: src, slug: SLUG });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.kind === "unpointed-element")).toBe(true);
  });

  test("an injected type-check stage contributes fatal errors", async () => {
    const typeError: GateError = {
      kind: "type",
      code: "TYPE_ERROR",
      message: "Type 'string' is not assignable to 'number'",
    };
    const result = await runGate(
      { source: cleanSource, slug: SLUG },
      { typeCheck: () => [typeError] },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "type")).toBe(true);
  });

  test("manifest + smoke stages only run when the source scans + type check are clean", async () => {
    let smokeRan = false;
    const badSource = `import { x } from "lodash"\n${cleanSource}`;
    await runGate(
      { source: badSource, slug: SLUG },
      {
        smokeRender: () => {
          smokeRan = true;
          return [];
        },
      },
    );
    expect(smokeRan).toBe(false); // a forbidden-import candidate is never smoke-rendered
  });

  test("the smoke stage runs and contributes errors for a clean-source candidate", async () => {
    const smokeError: GateError = {
      kind: "smoke",
      code: "DESIGN_RENDER_FAILED",
      message: "render threw",
    };
    const result = await runGate(
      { source: cleanSource, slug: SLUG },
      { smokeRender: () => [smokeError] },
    );
    expect(result.errors.some((e) => e.kind === "smoke")).toBe(true);
  });
});
