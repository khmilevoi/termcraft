import { describe, expect, test } from "bun:test";

import {
  chatColumnWidth,
  previewFrameOrigin,
  previewPaneWidth,
  previewRegionSize,
} from "./preview-geometry";

describe("preview-geometry", () => {
  test("the chat column is the design's 37% of the terminal width", () => {
    // design/termcraft-engine.js:478 — `chatW = Math.round(w * 0.37)`.
    expect(chatColumnWidth(120)).toBe(44);
    expect(chatColumnWidth(140)).toBe(52);
    expect(chatColumnWidth(80)).toBe(30);
  });

  test("the preview pane claims the rest of the width, or all of it in fullscreen", () => {
    expect(previewPaneWidth({ w: 120, h: 34 }, false)).toBe(76);
    expect(previewPaneWidth({ w: 120, h: 34 }, true)).toBe(120);
  });

  test("the region is the pane minus its own border and its tab strip row", () => {
    // pane 76 wide → 74 inside the left/right border; h - 1 status bar - 2 border - 1 tabs.
    expect(previewRegionSize({ w: 120, h: 34 }, false)).toEqual({ w: 74, h: 30 });
    expect(previewRegionSize({ w: 120, h: 34 }, true)).toEqual({ w: 118, h: 30 });
  });

  test("the region never reports a negative size on a terminal too small to hold the chrome", () => {
    expect(previewRegionSize({ w: 1, h: 1 }, false)).toEqual({ w: 0, h: 0 });
  });

  test("the frame's top-left cell sits inside the pane border, under the tab strip", () => {
    expect(previewFrameOrigin({ w: 120, h: 34 }, false)).toEqual({ x: 45, y: 2 });
    expect(previewFrameOrigin({ w: 120, h: 34 }, true)).toEqual({ x: 1, y: 2 });
  });
});
