import { describe, expect, test } from "bun:test";

import { lintDeterminism, lintDroppedIds } from "./lints";

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

describe("lintDroppedIds (§6.3 dropped-id warning)", () => {
  test("absent referencedIds skips the lint entirely (gate stays runnable standalone)", () => {
    const src = `export default reatomComponent(() => <Panel id="p"><Text id="t">hi</Text></Panel>)\n`;
    expect(lintDroppedIds(src)).toEqual([]);
  });

  test("a referenced id still present in the candidate produces no warning", () => {
    const src = `export default reatomComponent(() => <Panel id="p"><Text id="t">hi</Text></Panel>)\n`;
    expect(lintDroppedIds(src, ["p", "t"])).toEqual([]);
  });

  test("a referenced id absent from the candidate's ids warns dropped-id", () => {
    const src = `export default reatomComponent(() => <Panel id="p">hi</Panel>)\n`;
    const w = lintDroppedIds(src, ["p", "cpu-gauge"]);
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("dropped-id");
    expect(w[0]?.message).toContain("cpu-gauge");
  });

  test("every dropped id is reported, not just the first", () => {
    const w = lintDroppedIds(`export default reatomComponent(() => <Panel id="p" />)\n`, [
      "a",
      "b",
    ]);
    expect(w).toHaveLength(2);
  });

  test("an id bound via object-property form (`id: \"x\"`) also counts as present", () => {
    const src = `const props = { id: "cpu-gauge" }\n`;
    expect(lintDroppedIds(src, ["cpu-gauge"])).toEqual([]);
  });
});
