import { describe, expect, test } from "bun:test";

import type { PinDtoV1 } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";

import { derivePinListRows } from "./pins";

const pin = (overrides: Partial<PinDtoV1>): PinDtoV1 => ({
  pinId: uuidv7(),
  pageSlug: "main",
  elementId: "gauge-cpu",
  fx: 0.5,
  fy: 0.5,
  text: "make this gauge red",
  status: "open",
  createdRecordId: uuidv7(),
  latestRecordId: uuidv7(),
  updatedAt: "2026-07-22T00:00:00.000Z",
  ...overrides,
});

describe("derivePinListRows (numbers badges among open pins only, matching PreviewOverlays)", () => {
  test("a resolved pin ahead of an open pin does not shift the open pin's badge number", () => {
    const resolved = pin({ status: "resolved", text: "resolved first" });
    const openPin = pin({ text: "open second" });
    const rows = derivePinListRows([resolved, openPin], null);
    const openRow = rows.find((row) => row.pin.pinId === openPin.pinId);
    // PreviewOverlays filters to open pins first, then numbers `index+1` among them
    // (PreviewOverlays.tsx:21-25). The open pin here is the ONLY open pin, so its badge
    // must be "1" (index 0) regardless of the resolved pin preceding it in the array.
    expect(openRow?.index).toBe(0);
  });

  test("numbers multiple open pins sequentially, skipping resolved pins entirely", () => {
    const openA = pin({ text: "a" });
    const resolved = pin({ status: "resolved", text: "resolved" });
    const openB = pin({ text: "b" });
    const rows = derivePinListRows([openA, resolved, openB], null);
    expect(rows.find((row) => row.pin.pinId === openA.pinId)?.index).toBe(0);
    expect(rows.find((row) => row.pin.pinId === openB.pinId)?.index).toBe(1);
  });
});

describe("derivePinListRows anchor resolution (spec §3.2's 'not visible in the current render')", () => {
  const rects = new Map([["gauge-cpu", { x: 1, y: 1, width: 4, height: 2 }]]);

  test("a pin whose element the render contains is visible", () => {
    const rows = derivePinListRows([pin({ elementId: "gauge-cpu" })], rects);
    expect(rows[0]?.visible).toBe(true);
  });

  test("a pin whose element the render does not contain is an orphan", () => {
    const rows = derivePinListRows([pin({ elementId: "removed-block" })], rects);
    expect(rows[0]?.visible).toBe(false);
  });

  test("claims nothing before the frame's rects land — no rects is not evidence of absence", () => {
    const rows = derivePinListRows([pin({ elementId: "removed-block" })], null);
    expect(rows[0]?.visible).toBe(true);
  });

  test("an empty index orphans every pin — that render genuinely contains nothing", () => {
    const rows = derivePinListRows([pin({ elementId: "gauge-cpu" })], new Map());
    expect(rows[0]?.visible).toBe(false);
  });
});
