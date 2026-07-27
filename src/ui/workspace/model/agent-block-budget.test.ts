import { describe, expect, it } from "bun:test";

import { uuidv7 } from "infrastructure/uuid";
import type { PinListRow } from "ui/chat";

import {
  MAX_TIMELINE_ROWS,
  agentStatusMaxRows,
  composerRowCount,
  pinListRowCount,
  scrollbackMaxRows,
} from "./agent-block-budget";

const TEST_TS = "2026-07-26T00:00:00.000Z";

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
      pinListRows: 0,
      composerRows: 2,
    });
    expect(rows).toBe(MAX_TIMELINE_ROWS);
  });

  it("measures from the interior available inside ws-chat-stream, not bare frameH (Finding 1)", () => {
    // frameH=14, minus 2 (ws-chat's own border), minus 1 (agent line),
    // minus 4 (pins: 1 header + 3 rows), minus 3 (composer w/ attach), minus 3 (chrome)
    // = 14 - 2 - 1 - 4 - 3 - 3 = 1, floored to the 3-row minimum.
    const rows = agentStatusMaxRows({
      frameH: 14,
      chromeRows: 3,
      hasAgentLine: true,
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
      pinListRows: 0,
      composerRows: 2,
    });
    expect(rows).toBe(MAX_TIMELINE_ROWS);
  });

  it("no longer shrinks as the scrollback grows — the scrollback yields to it instead", () => {
    // The inversion the overflow fix turns on: the live block's budget is a function of the
    // panel's pinned chrome alone, so an ever-growing history can never squeeze it.
    const input = { frameH: 39, chromeRows: 3, hasAgentLine: true, composerRows: 2 } as const;
    expect(agentStatusMaxRows({ ...input, pinListRows: 0 })).toBe(MAX_TIMELINE_ROWS);
  });
});

describe("scrollbackMaxRows", () => {
  it("is what remains once the border, agent line, live block, pins and composer are taken", () => {
    // 39 - 2 (border) - 1 (agent line) - 14 (live block) - 4 (pins) - 2 (composer) = 16
    expect(
      scrollbackMaxRows({
        frameH: 39,
        hasAgentLine: true,
        liveBlockRows: 14,
        pinListRows: 4,
        composerRows: 2,
      }),
    ).toBe(16);
  });

  it("never goes negative on a frame with no room left", () => {
    expect(
      scrollbackMaxRows({
        frameH: 6,
        hasAgentLine: true,
        liveBlockRows: 14,
        pinListRows: 4,
        composerRows: 2,
      }),
    ).toBe(0);
  });
});
