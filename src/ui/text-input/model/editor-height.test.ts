import { describe, expect, test } from "bun:test";

import { editorMaxRows, editorRowCount, wrappedLineCount } from "./editor-height";

/**
 * Every expectation below was read off `TextareaRenderable.virtualLineCount` with
 * `wrapMode: "word"` at `@opentui/core@0.4.5` — measured, not derived. `input-editing.test.tsx`'s
 * conformance test re-checks a subset against the live renderable so this table cannot silently
 * drift away from the layout it is mirroring.
 */
const WRAP_CASES: ReadonlyArray<readonly [string, number, number]> = [
  ["", 10, 1],
  ["abc", 10, 1],
  ["abcdefghij", 10, 1],
  ["abcdefghijk", 10, 2],
  ["hello world again", 10, 3],
  ["a\nb", 10, 2],
  ["abc\n", 10, 2],
  ["a\n\nb", 10, 3],
  ["supercalifragilisticexpialidocious", 10, 4],
  ["日本語日本語日本語", 10, 2],
  ["hello world", 11, 1],
  ["hello world", 10, 2],
  ["aaaa bbbb", 4, 3],
  ["abcdefghijkl mn", 10, 2],
  ["hello ", 6, 1],
  ["hello ", 5, 2],
  ["  ab", 4, 1],
  ["a  b", 3, 2],
  ["abc", 1, 3],
  ["ab cdefghijklmnopqr", 10, 3],
  ["ab 日本語日本語", 10, 3],
];

describe("editorMaxRows — the approved growth ceiling (spec §3)", () => {
  test("is a proportion of the frame, clamped to [1, 6]", () => {
    expect(editorMaxRows(4)).toBe(1);
    expect(editorMaxRows(8)).toBe(2);
    expect(editorMaxRows(22)).toBe(5);
    expect(editorMaxRows(24)).toBe(6);
    expect(editorMaxRows(100)).toBe(6);
  });

  test("never yields zero, however small the frame", () => {
    expect(editorMaxRows(0)).toBe(1);
    expect(editorMaxRows(3)).toBe(1);
  });
});

describe("wrappedLineCount — word wrap with a character-break fallback (spec §4.2)", () => {
  for (const [text, width, rows] of WRAP_CASES) {
    test(`${JSON.stringify(text)} at width ${width} occupies ${rows} row(s)`, () => {
      expect(wrappedLineCount(text, width)).toBe(rows);
    });
  }

  test("measures display width, not code units — a CJK line is twice as wide", () => {
    expect(wrappedLineCount("日本語日本語日本語", 10)).toBe(2);
    expect(wrappedLineCount("abcdefghi", 10)).toBe(1);
  });

  test("the early exit agrees with the untruncated count everywhere the caller clamps", () => {
    // The contract: with a cap, the answer is min(true count, cap + 1). Since `editorRowCount`
    // clamps to the cap, every value the caller can observe is identical either way — which is
    // what makes the exit free rather than a behaviour change (§9.4).
    for (const [text, width] of WRAP_CASES) {
      const full = wrappedLineCount(text, width);
      for (let cap = 1; cap <= 6; cap += 1) {
        expect(wrappedLineCount(text, width, cap)).toBe(Math.min(full, cap + 1));
      }
    }
  });

  test("a megabyte of text is counted without scanning all of it", () => {
    const huge = "word ".repeat(200_000);
    expect(wrappedLineCount(huge, 40, 6)).toBe(7);
  });
});

describe("editorRowCount — what the composer and the prompt actually render", () => {
  test("one row while the text fits one row — the design's own composer, unchanged", () => {
    expect(editorRowCount({ text: "", width: 40, frameH: 35 })).toBe(1);
    expect(editorRowCount({ text: "Ask for changes", width: 40, frameH: 35 })).toBe(1);
  });

  test("grows with the text up to the ceiling, then stops", () => {
    expect(editorRowCount({ text: "a\nb\nc", width: 40, frameH: 35 })).toBe(3);
    expect(editorRowCount({ text: "a\nb\nc\nd\ne\nf\ng\nh", width: 40, frameH: 35 })).toBe(6);
  });

  test("the ceiling follows the frame, so a small terminal grows less", () => {
    expect(editorRowCount({ text: "a\nb\nc\nd\ne\nf\ng", width: 40, frameH: 23 })).toBe(5);
    expect(editorRowCount({ text: "a\nb\nc\nd\ne\nf\ng", width: 40, frameH: 8 })).toBe(2);
  });

  test("a zero or negative width still reports at least one row", () => {
    expect(editorRowCount({ text: "abc", width: 0, frameH: 35 })).toBe(3);
    expect(editorRowCount({ text: "", width: -5, frameH: 35 })).toBe(1);
  });
});
