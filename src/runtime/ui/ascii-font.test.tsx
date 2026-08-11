import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { activeTokens } from "../model/tokens";
import { AsciiFont } from "./ascii-font";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
});

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();

const renderOnce = async (node: unknown, size: { w: number; h: number }) => {
  const handle = await createHeadlessRenderer(size);
  try {
    handle.mount(node);
    await handle.render();
    return handle.capture();
  } finally {
    handle.destroy();
  }
};

describe("AsciiFont display text (spec §6.1)", () => {
  test("paints a block of glyphs and resolves as a real layout element", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(<AsciiFont id="banner" text="AB" font="tiny" />);
    await handle.render();
    const rect = handle.rectOf("banner");
    // Unlike the inline family, ASCIIFontRenderable IS a layout Renderable, so its id resolves.
    expect(rect).not.toBeNull();
    expect((rect?.height ?? 0) > 1).toBe(true);
    expect(allRuns(handle.capture()).some((run) => run.text.trim() !== "")).toBe(true);
  });

  test("an explicit Color paints the glyphs in that hue", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 8 });
    open = handle;
    handle.mount(<AsciiFont id="banner" text="A" font="tiny" color={activeTokens().accent} />);
    await handle.render();
    const painted = allRuns(handle.capture()).filter((run) => run.text.trim() !== "");
    expect(painted.some((run) => extractRgb(run.fg) === activeTokens().accent)).toBe(true);
  });

  test("a token NAME is no longer a colour (spec §4.5)", () => {
    // @ts-expect-error — `Color` is `#rrggbb`; the checked path is `useTokens().accent`.
    const rejected = <AsciiFont id="rejected" text="A" color="accent" />;
    expect(rejected).toBeDefined();
  });

  test("text is required — omitting it does not compile", () => {
    // @ts-expect-error — a display-text element with no text is a silent no-op (plan decision D7).
    const rejected = <AsciiFont id="rejected-empty" />;
    expect(rejected).toBeDefined();
  });

  test("an unknown font name does not compile", () => {
    // @ts-expect-error — the seven names are @opentui/core's own `ASCIIFontName` union.
    const rejected = <AsciiFont id="rejected-font" text="A" font="comic" />;
    expect(rejected).toBeDefined();
  });

  test("export mode renders the identical frame (spec §6.3)", async () => {
    const tree = <AsciiFont id="banner" text="A" font="tiny" color={activeTokens().accent} />;
    const preview = await renderOnce(tree, { w: 40, h: 8 });
    hostModeAtom.set("export");
    const exported = await renderOnce(tree, { w: 40, h: 8 });
    expect(exported.rows).toEqual(preview.rows);
  });
});
