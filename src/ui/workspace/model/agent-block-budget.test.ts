import { describe, expect, test } from "bun:test";

import { MAX_TIMELINE_ROWS, agentStatusMaxRows } from "./agent-block-budget";

describe("agentStatusMaxRows (chat-scroll spec §5.3)", () => {
  test("measures the panel and its own chrome, and nothing else", () => {
    expect(agentStatusMaxRows({ frameH: 30, chromeRows: 1 })).toBe(MAX_TIMELINE_ROWS);
    expect(agentStatusMaxRows({ frameH: 10, chromeRows: 1 })).toBe(7);
  });

  test("still clamps to the design's own floor and ceiling", () => {
    expect(agentStatusMaxRows({ frameH: 4, chromeRows: 1 })).toBe(3);
    expect(agentStatusMaxRows({ frameH: 200, chromeRows: 1 })).toBe(MAX_TIMELINE_ROWS);
  });
});
