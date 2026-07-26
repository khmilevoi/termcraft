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
      activePageSlug: "main",
      openPins: [pin({})],
      turnRunning: true,
      composerValue: "half a sentence",
      slashOpen: false,
    });
    expect(result).toEqual({ text: "read-only — Send disabled", fg: "red" });
  });

  test("a live selection on the active page produces the ▣ chip text at selFg, when not read-only", () => {
    const result = deriveComposerAttach({
      readOnly: false,
      selection: { pageSlug: "main", elementId: "gauge-cpu", sourceHash: TEST_SHA },
      activePageSlug: "main",
      openPins: [],
      turnRunning: false,
      composerValue: "",
      slashOpen: false,
    });
    expect(result).toEqual({ text: "▣ gauge-cpu", fg: "selFg" });
  });

  test("selection on the active page wins over open pins when both are present", () => {
    const result = deriveComposerAttach({
      readOnly: false,
      selection: { pageSlug: "main", elementId: "gauge-cpu", sourceHash: TEST_SHA },
      activePageSlug: "main",
      openPins: [pin({}), pin({})],
      turnRunning: false,
      composerValue: "",
      slashOpen: false,
    });
    expect(result).toEqual({ text: "▣ gauge-cpu", fg: "selFg" });
  });

  test("no selection but open pins present produces the 'N open pins attached' line at amberHi", () => {
    const result = deriveComposerAttach({
      readOnly: false,
      selection: null,
      activePageSlug: "main",
      openPins: [pin({}), pin({})],
      turnRunning: false,
      composerValue: "",
      slashOpen: false,
    });
    expect(result).toEqual({ text: "2 open pins attached · sent next", fg: "amberHi" });
  });

  test("resolved pins do not count toward the open-pins attach line", () => {
    const result = deriveComposerAttach({
      readOnly: false,
      selection: null,
      activePageSlug: "main",
      openPins: [pin({ status: "resolved" }), pin({ status: "resolved" })],
      turnRunning: false,
      composerValue: "",
      slashOpen: false,
    });
    expect(result).toBeNull();
  });

  test("nothing present yields null", () => {
    const result = deriveComposerAttach({
      readOnly: false,
      selection: null,
      activePageSlug: null,
      openPins: [],
      turnRunning: false,
      composerValue: "",
      slashOpen: false,
    });
    expect(result).toBeNull();
  });

  describe("selection is page-scoped (a selection on another page must not chip this page's composer)", () => {
    test("a selection on a DIFFERENT page than the active page does not render its chip", () => {
      const result = deriveComposerAttach({
        readOnly: false,
        selection: { pageSlug: "other", elementId: "gauge-cpu", sourceHash: TEST_SHA },
        activePageSlug: "main",
        openPins: [],
        turnRunning: false,
        composerValue: "",
        slashOpen: false,
      });
      expect(result).toBeNull();
    });

    test("a selection on a different page falls through to the open-pins line on the active page", () => {
      const result = deriveComposerAttach({
        readOnly: false,
        selection: { pageSlug: "other", elementId: "gauge-cpu", sourceHash: TEST_SHA },
        activePageSlug: "main",
        openPins: [pin({}), pin({})],
        turnRunning: false,
        composerValue: "",
        slashOpen: false,
      });
      expect(result).toEqual({ text: "2 open pins attached · sent next", fg: "amberHi" });
    });

    test("a selection on the SAME page as the active page still renders its chip", () => {
      const result = deriveComposerAttach({
        readOnly: false,
        selection: { pageSlug: "main", elementId: "gauge-cpu", sourceHash: TEST_SHA },
        activePageSlug: "main",
        openPins: [pin({})],
        turnRunning: false,
        composerValue: "",
        slashOpen: false,
      });
      expect(result).toEqual({ text: "▣ gauge-cpu", fg: "selFg" });
    });
  });
});

// finding §2.5 (phase-8 Task 16): the composer stays live for the whole turn, so its attach line
// must now say something during one too — design draws two distinct turn-time lines (never one
// generic "a turn is running" line), keyed on whether the slash-menu overlay is open and whether
// there is a draft. See `deriveComposerAttach`'s own doc comment for the exact citations.
describe("deriveComposerAttach — turn-time lines (finding §2.5, wsGenTyping/wsSlashTurn)", () => {
  test("an empty composer during a turn renders no attach line (design's plain drawChat gen path, :255)", () => {
    const result = deriveComposerAttach({
      readOnly: false,
      selection: null,
      activePageSlug: "main",
      openPins: [],
      turnRunning: true,
      composerValue: "",
      slashOpen: false,
    });
    expect(result).toBeNull();
  });

  test("a non-slash draft during a turn renders `⏎ send disabled — draft kept` at amberHi (wsGenTyping :268)", () => {
    const result = deriveComposerAttach({
      readOnly: false,
      selection: null,
      activePageSlug: "main",
      openPins: [],
      turnRunning: true,
      composerValue: "and label the peaks",
      slashOpen: false,
    });
    expect(result).toEqual({ text: "⏎ send disabled — draft kept", fg: "amberHi" });
  });

  test("the slash overlay open during a turn renders `send refused — / still runs commands` at amberHi (wsSlashTurn :998)", () => {
    const result = deriveComposerAttach({
      readOnly: false,
      selection: null,
      activePageSlug: "main",
      openPins: [],
      turnRunning: true,
      composerValue: "/",
      slashOpen: true,
    });
    expect(result).toEqual({ text: "send refused — / still runs commands", fg: "amberHi" });
  });

  test("a typed slash command during a turn still reads as the local-command line, not the draft line", () => {
    const result = deriveComposerAttach({
      readOnly: false,
      selection: null,
      activePageSlug: "main",
      openPins: [],
      turnRunning: true,
      composerValue: "/exit",
      slashOpen: true,
    });
    expect(result).toEqual({ text: "send refused — / still runs commands", fg: "amberHi" });
  });

  // REVIEW ROUND 1 regression guard (finding §2.5, phase-8 Task 16): a first pass inferred
  // "slash mode" from `composerValue.startsWith("/")` alone — this is the exact case that got
  // wrong. Once the overlay is dismissed (Esc), a `/`-prefixed leftover draft is an ORDINARY
  // draft, not local-command mode, and must read the draft-kept line, not the slash line.
  test("a /-prefixed draft with the overlay CLOSED reads as an ordinary draft, not local-command mode", () => {
    const result = deriveComposerAttach({
      readOnly: false,
      selection: null,
      activePageSlug: "main",
      openPins: [],
      turnRunning: true,
      composerValue: "/exit",
      slashOpen: false,
    });
    expect(result).toEqual({ text: "⏎ send disabled — draft kept", fg: "amberHi" });
  });

  test("a selection still wins over either turn-time line", () => {
    const result = deriveComposerAttach({
      readOnly: false,
      selection: { pageSlug: "main", elementId: "gauge-cpu", sourceHash: TEST_SHA },
      activePageSlug: "main",
      openPins: [],
      turnRunning: true,
      composerValue: "a draft that should stay hidden",
      slashOpen: false,
    });
    expect(result).toEqual({ text: "▣ gauge-cpu", fg: "selFg" });
  });

  // GAP flagged in `deriveComposerAttach`'s own doc comment: design never draws pins open
  // together with a running turn. This pins this MODULE's own (undesigned but defensible)
  // choice for that combination, so a future change to the ordering is a deliberate decision,
  // not a silent regression.
  test("open pins still win over either turn-time line (GAP: design does not draw this combination)", () => {
    const result = deriveComposerAttach({
      readOnly: false,
      selection: null,
      activePageSlug: "main",
      openPins: [pin({})],
      turnRunning: true,
      composerValue: "a draft that should stay hidden",
      slashOpen: false,
    });
    expect(result).toEqual({ text: "1 open pins attached · sent next", fg: "amberHi" });
  });
});
