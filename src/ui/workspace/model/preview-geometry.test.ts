import { describe, expect, test } from "bun:test";

import {
  chatColumnWidth,
  previewFrameOrigin,
  previewPaneHeight,
  previewPaneWidth,
  previewRegionSize,
  previewTabStripWidth,
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

  test("the region is the pane minus its border, its tab strip, the rule and the gap row", () => {
    // design/termcraft-engine.js:486 — `dh = frameH - 5` with `frameH = h - 1`, `dy = 4`.
    expect(previewRegionSize({ w: 120, h: 34 }, false)).toEqual({ w: 74, h: 28 });
    expect(previewRegionSize({ w: 120, h: 34 }, true)).toEqual({ w: 118, h: 28 });
  });

  test("the region never reports a negative size on a terminal too small to hold the chrome", () => {
    expect(previewRegionSize({ w: 1, h: 1 }, false)).toEqual({ w: 0, h: 0 });
  });

  test("the frame's top-left cell sits at the design's dy", () => {
    expect(previewFrameOrigin({ w: 120, h: 34 }, false)).toEqual({ x: 45, y: 4 });
    expect(previewFrameOrigin({ w: 120, h: 34 }, true)).toEqual({ x: 1, y: 4 });
  });

  test("previewPaneHeight is the pane's own outer height, one row short of the terminal", () => {
    // design/termcraft-engine.js:477 (`paneShell`) — `frameH = h - 1`, one row reserved for
    // the shell's own status bar below the pane. This is the SAME `frameH` `Workspace.tsx`
    // sets as both `ws-chat`'s and `ws-preview`'s own `height` prop — one number, not two.
    expect(previewPaneHeight({ w: 120, h: 34 })).toBe(33);
    expect(previewPaneHeight({ w: 120, h: 20 })).toBe(19);
  });

  test("previewTabStripWidth is the pane's outer width minus its border and the design's indent", () => {
    // design/termcraft-engine.js:484 (`paneShell`) — `drawTabs(b, px0+2, 1, pw-4, …)`: the
    // strip is `pw - 4`, `pw` being the pane's own OUTER width (`previewPaneWidth`) — the
    // border (`PANE_BORDER_COLUMNS`, 2) plus one more column of indent on each side (2 more).
    expect(previewTabStripWidth({ w: 120, h: 34 }, false)).toBe(72);
    expect(previewTabStripWidth({ w: 120, h: 34 }, true)).toBe(116);
  });
});
