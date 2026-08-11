import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { reatomComponent } from "../model/reatom";
import {
  DARK_DEFAULT,
  DEFAULT_THEME_ID,
  activeTokens,
  seedThemeCapability,
  useTokens,
} from "../model/tokens";
import type { TokenMap } from "../types";
import { FrameBuffer } from "./frame-buffer";
import type { FrameBufferSurface } from "./frame-buffer";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
  seedThemeCapability({ themeId: DEFAULT_THEME_ID, tokens: DARK_DEFAULT });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const frameText = (frame: { rows: StyledRun[][] }): string =>
  frame.rows.map((row) => row.map((run) => run.text).join("")).join("\n");

/** Mount one FrameBuffer with the given draw callback and return the captured frame's text. */
async function renderDrawn(draw: (surface: FrameBufferSurface) => void): Promise<string> {
  const handle = await createHeadlessRenderer({ w: 8, h: 2 });
  open = handle;
  handle.mount(<FrameBuffer id="fb" width={8} height={2} draw={draw} />);
  await handle.render();
  expect(handle.renderError()).toBeNull();
  const text = frameText(handle.capture());
  handle.destroy();
  open = null;
  return text;
}

describe("FrameBuffer (spec §6.1)", () => {
  test("drawText paints into the buffer in the given Color", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 2 });
    open = handle;
    handle.mount(
      <FrameBuffer
        id="fb"
        width={8}
        height={2}
        draw={(surface) => {
          surface.clear(activeTokens().background);
          surface.drawText("ok", 0, 0, activeTokens().accent);
        }}
      />,
    );
    await handle.render();
    const frame = handle.capture();
    expect(frameText(frame)).toContain("ok");
    const painted = allRuns(frame).find((run) => run.text.includes("ok"));
    expect(painted && extractRgb(painted.fg)).toBe<string>(activeTokens().accent);
  });

  test("setCell and fillRect reach individual cells", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 2 });
    open = handle;
    handle.mount(
      <FrameBuffer
        id="fb"
        width={8}
        height={2}
        draw={(surface) => {
          surface.clear(activeTokens().background);
          surface.fillRect(0, 0, 8, 1, activeTokens().surface);
          surface.setCell(3, 1, "█", activeTokens().success);
        }}
      />,
    );
    await handle.render();
    expect(handle.renderError()).toBeNull();
    const frame = handle.capture();
    expect(frameText(frame)).toContain("█");

    // The `toContain("█")` check above only covers `setCell`'s write. `fillRect` paints row 0
    // with `surface` (distinct from `clear()`'s `background`) — assert that back-fill directly
    // so the test cannot pass if `fillRect` silently no-ops.
    const row0 = frame.rows[0] ?? [];
    expect(row0.length).toBeGreaterThan(0);
    for (const run of row0) {
      expect(extractRgb(run.bg)).toBe<string>(activeTokens().surface);
    }
    // Row 1 is untouched by `fillRect`, so (outside the painted cell) it still carries
    // `clear()`'s `background`.
    const row1Untouched = (frame.rows[1] ?? []).filter((run) => !run.text.includes("█"));
    expect(row1Untouched.length).toBeGreaterThan(0);
    for (const run of row1Untouched) {
      expect(extractRgb(run.bg)).toBe<string>(activeTokens().background);
    }
  });

  test("a write outside the buffer is dropped, never a crash", async () => {
    const text = await renderDrawn((surface) => {
      surface.clear(activeTokens().background);
      surface.setCell(99, 99, "X", activeTokens().danger);
      surface.setCell(-1, 0, "Y", activeTokens().danger);
    });
    expect(text).not.toContain("X");
    expect(text).not.toContain("Y");
  });

  test("the surface reports the declared size", async () => {
    const seen: number[] = [];
    await renderDrawn((surface) => {
      seen.push(surface.width, surface.height);
    });
    expect(seen).toEqual([8, 2]);
  });
});

describe("FrameBuffer export determinism (spec §6.3)", () => {
  test("the export frame is identical to the preview frame for the same draw", async () => {
    const draw = (surface: FrameBufferSurface): void => {
      surface.clear(activeTokens().background);
      surface.drawText("det", 1, 0, activeTokens().accent);
    };
    hostModeAtom.set("preview");
    const preview = await renderDrawn(draw);
    hostModeAtom.set("export");
    const exported = await renderDrawn(draw);
    expect(exported).toBe(preview);
  });

  test("two independent export mounts of the same draw render the same frame", async () => {
    const draw = (surface: FrameBufferSurface): void => {
      surface.clear(activeTokens().background);
      surface.fillRect(0, 0, 4, 2, activeTokens().selection);
    };
    hostModeAtom.set("export");
    const first = await renderDrawn(draw);
    const second = await renderDrawn(draw);
    expect(second).toBe(first);
  });
});

describe("FrameBuffer theme reactivity (M5, the wrapper's own doc comment)", () => {
  test("a theme change repaints the buffer", async () => {
    // `FrameBuffer` itself is a plain function component (spec §4.2's stage-1 rule), so nothing
    // here re-renders it on its own. What the doc comment claims is that a PARENT re-render
    // supplies a new inline `draw` closure and thus a new `ref` callback identity, which OpenTUI
    // re-invokes — so the parent must be the reactive piece, exactly like a real page. A
    // `reatomComponent` reading `useTokens()` (the same mechanism
    // `../model/tokens.reactivity.test.tsx` uses) is what drives that.
    const Probe = reatomComponent(() => {
      const t = useTokens();
      return (
        <FrameBuffer
          id="fb"
          width={8}
          height={2}
          draw={(surface) => {
            surface.clear(t.background);
            surface.drawText("x", 0, 0, t.accent);
          }}
        />
      );
    }, "test.frameBuffer.themeProbe");

    const handle = await createHeadlessRenderer({ w: 8, h: 2 });
    open = handle;
    handle.mount(<Probe />);
    await handle.render();
    const before = allRuns(handle.capture()).find((run) => run.text.includes("x"));
    expect(before && extractRgb(before.fg)).toBe<string>(DARK_DEFAULT.accent);

    const midnight: TokenMap = { ...DARK_DEFAULT, accent: "#4cc9f0" };
    seedThemeCapability({ themeId: "midnight", tokens: midnight });
    await tick();
    await handle.render();
    const after = allRuns(handle.capture()).find((run) => run.text.includes("x"));
    expect(after && extractRgb(after.fg)).toBe<string>("#4cc9f0");
  });
});
