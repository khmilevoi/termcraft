import { describe, expect, test } from "bun:test";

import type { PinDtoV1 } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";
import { TEST_SHA } from "ui/testing";

import { deriveComposerAttach } from "./attach";

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

describe("deriveComposerAttach (design wsSelect chip / wsPins attach line, chatSeq:443-448)", () => {
  test("read-only wins over everything else", () => {
    const result = deriveComposerAttach({
      readOnly: true,
      selection: { pageSlug: "main", elementId: "gauge-cpu", sourceHash: TEST_SHA },
      openPins: [pin({})],
    });
    expect(result).toEqual({ text: "read-only — Send disabled", fg: "red" });
  });

  test("a live selection produces the ▣ chip text at selFg, when not read-only", () => {
    const result = deriveComposerAttach({
      readOnly: false,
      selection: { pageSlug: "main", elementId: "gauge-cpu", sourceHash: TEST_SHA },
      openPins: [],
    });
    expect(result).toEqual({ text: "▣ gauge-cpu", fg: "selFg" });
  });

  test("selection wins over open pins when both are present", () => {
    const result = deriveComposerAttach({
      readOnly: false,
      selection: { pageSlug: "main", elementId: "gauge-cpu", sourceHash: TEST_SHA },
      openPins: [pin({}), pin({})],
    });
    expect(result).toEqual({ text: "▣ gauge-cpu", fg: "selFg" });
  });

  test("no selection but open pins present produces the 'N open pins attached' line at amberHi", () => {
    const result = deriveComposerAttach({
      readOnly: false,
      selection: null,
      openPins: [pin({}), pin({})],
    });
    expect(result).toEqual({ text: "2 open pins attached · sent next", fg: "amberHi" });
  });

  test("resolved pins do not count toward the open-pins attach line", () => {
    const result = deriveComposerAttach({
      readOnly: false,
      selection: null,
      openPins: [pin({ status: "resolved" }), pin({ status: "resolved" })],
    });
    expect(result).toBeNull();
  });

  test("nothing present yields null", () => {
    const result = deriveComposerAttach({ readOnly: false, selection: null, openPins: [] });
    expect(result).toBeNull();
  });
});
