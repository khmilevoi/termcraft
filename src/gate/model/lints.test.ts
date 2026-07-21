import { describe, expect, test } from "bun:test";

import { lintDeterminism } from "./lints";

describe("lintDeterminism (§6.3 non-fatal determinism warnings)", () => {
  test("a deterministic page produces no warnings", () => {
    expect(lintDeterminism(`const rows = [1, 2, 3].map((n) => n * 2)\n`)).toEqual([]);
  });

  test("setTimeout / setInterval each warn as an unguarded timer", () => {
    const w = lintDeterminism(`setTimeout(() => {}, 10)\nsetInterval(() => {}, 10)\n`);
    expect(w).toHaveLength(2);
    expect(w.every((x) => x.kind === "unguarded-timer")).toBe(true);
  });

  test("Math.random warns as unguarded randomness", () => {
    const w = lintDeterminism(`const r = Math.random()\n`);
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("unguarded-randomness");
  });

  test("Date.now / performance.now warn as unguarded timers", () => {
    const w = lintDeterminism(`const a = Date.now()\nconst b = performance.now()\n`);
    expect(w).toHaveLength(2);
    expect(w.every((x) => x.kind === "unguarded-timer")).toBe(true);
  });

  test("a property access unrelated to time/randomness does not warn", () => {
    expect(
      lintDeterminism(`const x = obj.now\nconst y = Math.max(1, 2)\nconst z = user.random\n`),
    ).toEqual([]);
  });

  test("warnings carry a source position", () => {
    const w = lintDeterminism(`\nconst r = Math.random()\n`);
    expect(w[0]?.line).toBe(2);
  });
});
