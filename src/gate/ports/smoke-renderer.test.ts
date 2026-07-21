import { describe, expect, test } from "bun:test";

import { smokeResultToErrors } from "./smoke-renderer";

describe("smokeResultToErrors (§11.3)", () => {
  test("a clean smoke render contributes no gate error", () => {
    expect(smokeResultToErrors({ ok: true })).toEqual([]);
  });

  test("a smoke failure becomes one smoke-kind gate error naming the fault", () => {
    const errors = smokeResultToErrors({
      ok: false,
      code: "DESIGN_RENDER_FAILED",
      message: "render threw at <Panel>",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("smoke");
    expect(errors[0]?.code).toBe("DESIGN_RENDER_FAILED");
    expect(errors[0]?.message).toContain("Panel");
  });
});
