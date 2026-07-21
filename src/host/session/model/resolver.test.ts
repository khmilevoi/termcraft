import { describe, expect, test } from "bun:test";

import { registerRuntimeResolver } from "./resolver";

const pagePath = `${import.meta.dir}/../fixtures/probe-page.tsx`;

describe("registerRuntimeResolver", () => {
  test("lets an external .tsx page import @termcraft/runtime", async () => {
    registerRuntimeResolver();
    const page = (await import(pagePath)) as {
      meta: { kitApiVersion: number; title: string };
      default: unknown;
    };
    expect(page.meta.kitApiVersion).toBe(1);
    expect(page.meta.title).toBe("Probe page");
    expect(typeof page.default).toBe("function");
  });

  test("is idempotent — a second call does not throw", () => {
    expect(() => {
      registerRuntimeResolver();
      registerRuntimeResolver();
    }).not.toThrow();
  });
});
