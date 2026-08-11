import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { activeTokens } from "../model/tokens";
import { FrameBuffer } from "./frame-buffer";
import type { FrameBufferSurface } from "./frame-buffer";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
});

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
    const text = await renderDrawn((surface) => {
      surface.clear(activeTokens().background);
      surface.fillRect(0, 0, 8, 1, activeTokens().surface);
      surface.setCell(3, 1, "█", activeTokens().success);
    });
    expect(text).toContain("█");
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
