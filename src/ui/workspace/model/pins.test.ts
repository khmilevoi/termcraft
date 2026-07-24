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
    const rows = derivePinListRows([resolved, openPin]);
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
    const rows = derivePinListRows([openA, resolved, openB]);
    expect(rows.find((row) => row.pin.pinId === openA.pinId)?.index).toBe(0);
    expect(rows.find((row) => row.pin.pinId === openB.pinId)?.index).toBe(1);
  });

  test("every row is visible: true (the anchor-resolution signal is dormant, see Workspace.tsx)", () => {
    const rows = derivePinListRows([pin({}), pin({ status: "resolved" })]);
    expect(rows.every((row) => row.visible)).toBe(true);
  });
});
