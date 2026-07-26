import { describe, expect, it } from "bun:test";

import { uuidv7 } from "infrastructure/uuid";
import type { PinListRow } from "ui/chat";
import type { ChatRecord } from "ui/mirror";

import {
  MAX_TIMELINE_ROWS,
  agentStatusMaxRows,
  chatScrollbackRows,
  composerRowCount,
  pinListRowCount,
} from "./agent-block-budget";

const TEST_TS = "2026-07-26T00:00:00.000Z";

const userRecord = (text: string): ChatRecord => ({
  kind: "user",
  recordId: uuidv7(),
  turnId: uuidv7(),
  text,
  selection: null,
  pins: [],
  ts: TEST_TS,
});

const agentRecord = (text: string): ChatRecord => ({
  kind: "agent",
  recordId: uuidv7(),
  turnId: uuidv7(),
  text,
  changedPages: [],
  warnings: [],
  ts: TEST_TS,
});

const pinRow = (): PinListRow => ({
  pin: {
    pinId: uuidv7(),
    pageSlug: "main",
    elementId: "gauge-cpu",
    fx: 0.5,
    fy: 0.5,
    text: "make this gauge red",
    status: "open",
    createdRecordId: uuidv7(),
    latestRecordId: uuidv7(),
    updatedAt: TEST_TS,
  },
  index: 0,
  visible: true,
});

describe("chatScrollbackRows", () => {
  it("is 0 for an empty scrollback", () => {
    expect(chatScrollbackRows([], "claude")).toBe(0);
  });

  it("counts one header row plus each record's own flattened line count", () => {
    // single-line "build a system monitor" -> 1 header + 1 line = 2
    // two-line "line one\nline two" -> 1 header + 2 lines = 3
    const rows = chatScrollbackRows(
      [userRecord("build a system monitor"), agentRecord("line one\nline two")],
      "claude",
    );
    expect(rows).toBe(2 + 3);
  });
});

describe("pinListRowCount", () => {
  it("is 0 when there are no pins — PinList itself renders nothing", () => {
    expect(pinListRowCount([])).toBe(0);
  });

  it("is one header row plus one row per pin", () => {
    expect(pinListRowCount([pinRow(), pinRow(), pinRow()])).toBe(1 + 3);
  });
});

describe("composerRowCount", () => {
  it("is 2 rows with no attach line (seam + input)", () => {
    expect(composerRowCount(false)).toBe(2);
  });

  it("is 3 rows with an attach line (seam + attach + input)", () => {
    expect(composerRowCount(true)).toBe(3);
  });
});

describe("agentStatusMaxRows", () => {
  it("caps at the design's own 11-row timeline budget on a generous frame (review round 1, Finding 1)", () => {
    // design/03-workspace-generating.dc.html: "The block is capped at 12 rows... The spinner row
    // is pinned" — genTurn('long')'s 11 timeline rows (:539-545) + the pinned spinner (:547) = 12;
    // AgentStatusBlock always draws the spinner itself, so the timeline's own share is 12-1=11.
    const rows = agentStatusMaxRows({
      frameH: 39, // a 40-row terminal, status bar takes the last row (h - 1)
      chromeRows: 3,
      hasAgentLine: true,
      scrollbackRows: 0,
      pinListRows: 0,
      composerRows: 2,
    });
    expect(rows).toBe(MAX_TIMELINE_ROWS);
  });

  it("measures from the interior available inside ws-chat-stream, not bare frameH (Finding 1)", () => {
    // frameH=20, minus 2 (ws-chat's own border), minus 1 (agent line), minus 6 (scrollback),
    // minus 4 (pins: 1 header + 3 rows), minus 3 (composer w/ attach), minus 3 (chrome)
    // = 20 - 2 - 1 - 6 - 4 - 3 - 3 = 1, floored to the 3-row minimum.
    const rows = agentStatusMaxRows({
      frameH: 20,
      chromeRows: 3,
      hasAgentLine: true,
      scrollbackRows: 6,
      pinListRows: 4,
      composerRows: 3,
    });
    expect(rows).toBe(3);
  });

  it("never returns fewer than 3 rows even on a cramped frame", () => {
    const rows = agentStatusMaxRows({
      frameH: 8,
      chromeRows: 3,
      hasAgentLine: true,
      scrollbackRows: 20,
      pinListRows: 20,
      composerRows: 3,
    });
    expect(rows).toBe(3);
  });

  it("never exceeds MAX_TIMELINE_ROWS even with an enormous frame", () => {
    const rows = agentStatusMaxRows({
      frameH: 500,
      chromeRows: 3,
      hasAgentLine: false,
      scrollbackRows: 0,
      pinListRows: 0,
      composerRows: 2,
    });
    expect(rows).toBe(MAX_TIMELINE_ROWS);
  });
});
