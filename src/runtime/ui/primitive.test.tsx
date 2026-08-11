import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { activeTokens } from "../model/tokens";
import { Box } from "./primitive";
import { Text } from "./text";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
});

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();

/** Render one tree into a throwaway renderer and return its frame. */
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

describe("Box low-level primitive (§3.2 escape hatch)", () => {
  test("renders children and paints a token-resolved background fill", async () => {
    const handle = await createHeadlessRenderer({ w: 10, h: 2 });
    open = handle;
    handle.mount(
      <Box id="panel" background={activeTokens().surface} padding={0}>
        <Text id="panel-body">body</Text>
      </Box>,
    );
    await handle.render();
    const frame = handle.capture();
    const body = allRuns(frame).find((run) => run.text.includes("body"));
    expect(body?.text).toContain("body");
    const filled = allRuns(frame).find((run) => run.bg !== "default");
    expect(filled && extractRgb(filled.bg)).toBe<string>(activeTokens().surface);
  });

  test("a bordered box paints the token border hue", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 3 });
    open = handle;
    handle.mount(
      <Box id="bordered" border borderColor={activeTokens().accent}>
        <Text id="bordered-x">x</Text>
      </Box>,
    );
    await handle.render();
    const border = allRuns(handle.capture()).find(
      (run) =>
        typeof run.fg === "object" &&
        run.fg !== null &&
        "rgb" in run.fg &&
        run.fg.rgb === activeTokens().accent &&
        run.text.trim() !== "x",
    );
    expect(border).toBeDefined();
  });

  test("a token NAME is no longer a colour (spec §4.5)", () => {
    // @ts-expect-error — `Color` is `#rrggbb`; the checked path is `useTokens().surface`.
    const rejected = <Box id="rejected" background="surface" />;
    expect(rejected).toBeDefined();
  });
});

const frameText = (frame: { rows: StyledRun[][] }): string =>
  frame.rows.map((row) => row.map((run) => run.text).join("")).join("\n");

describe("Box border surface (spec §6.2)", () => {
  test("borderStyle picks the glyph table — double draws ╔ and ═", async () => {
    // Glyphs quoted from @opentui/core@0.4.5's own BorderChars table
    // (chunk-bun-t2myhmwd.js:1238-1249), not invented.
    const handle = await createHeadlessRenderer({ w: 8, h: 3 });
    open = handle;
    handle.mount(<Box id="dbl" border borderStyle="double" borderColor={activeTokens().border} />);
    await handle.render();
    const text = frameText(handle.capture());
    expect(text).toContain("╔");
    expect(text).toContain("═");
  });

  test("borderStyle=heavy draws the heavy table instead", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 3 });
    open = handle;
    handle.mount(<Box id="hvy" border borderStyle="heavy" borderColor={activeTokens().border} />);
    await handle.render();
    const text = frameText(handle.capture());
    expect(text).toContain("┏");
    expect(text).toContain("━");
  });

  test("border as a side list draws only those sides", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 3 });
    open = handle;
    handle.mount(
      <Box id="top-only" border={["top"]} borderStyle="single" borderColor={activeTokens().border}>
        <Text id="top-only-body">x</Text>
      </Box>,
    );
    await handle.render();
    const text = frameText(handle.capture());
    expect(text).toContain("─");
    // The vertical rule belongs to the left/right sides, which were not requested.
    expect(text).not.toContain("│");
  });

  test("borderChars overrides the glyph table entirely", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 3 });
    open = handle;
    handle.mount(
      <Box
        id="custom"
        border
        borderColor={activeTokens().border}
        borderChars={{
          topLeft: "A",
          topRight: "B",
          bottomLeft: "C",
          bottomRight: "D",
          horizontal: "E",
          vertical: "F",
          topT: "G",
          bottomT: "H",
          leftT: "I",
          rightT: "J",
          cross: "K",
        }}
      />,
    );
    await handle.render();
    const text = frameText(handle.capture());
    expect(text).toContain("A");
    expect(text).toContain("E");
  });

  test("title and bottomTitle are drawn into their border rows", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 4 });
    open = handle;
    handle.mount(
      <Box
        id="titled"
        border
        borderColor={activeTokens().border}
        title="Top"
        titleAlign="center"
        titleColor={activeTokens().accent}
        bottomTitle="Bot"
        bottomTitleAlign="right"
      />,
    );
    await handle.render();
    const frame = handle.capture();
    const rows = frame.rows.map((row) => row.map((run) => run.text).join(""));
    expect(rows[0]).toContain("Top");
    // `Box` sizes to content, not the full terminal (§6.2 §3.2 — it has no forced stretch
    // default), so an unbordered-content box is exactly 2 rows tall here; the bottom border
    // row is the LAST NON-BLANK frame row, not `rows[rows.length - 1]`, which would be blank
    // terminal padding below the box in this h:4 terminal.
    const lastContentRow = [...rows].reverse().find((row) => row.trim().length > 0);
    expect(lastContentRow).toContain("Bot");
  });

  test("titleColor is a Color, never a token name (spec §4.5)", () => {
    // @ts-expect-error — `Color` is `#rrggbb`; the checked path is `useTokens().accent`.
    const rejected = <Box id="rejected-title" title="t" titleColor="accent" />;
    expect(rejected).toBeDefined();
  });
});

describe("Box layout surface (spec §6.2)", () => {
  test("a percentage width resolves against the parent", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 2 });
    open = handle;
    handle.mount(
      <Box id="outer" width={20} height={1} direction="row">
        <Box id="half" width="50%" height={1} background={activeTokens().surface} />
      </Box>,
    );
    await handle.render();
    expect(handle.rectOf("half")?.width).toBe(10);
  });

  test("auto sizing falls back to content", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 2 });
    open = handle;
    handle.mount(
      <Box id="auto-outer" width="auto" height={1} direction="row">
        <Text id="auto-body">abcde</Text>
      </Box>,
    );
    await handle.render();
    // CORRECTED AGAINST OBSERVED YOGA OUTPUT (handle.layoutTree()), not the brief's assumed 5:
    // `auto-outer` is a direct child of the renderer's root box, whose default `flexDirection`
    // is `column` and default `alignItems` is `stretch`. `width="auto"` means "no explicit
    // cross-axis size", so the stretch default fills it to the parent's full width (20) — the
    // CHILD Text still sizes to its own content, confirmed at width 5 in the same layout tree.
    expect(handle.rectOf("auto-outer")?.width).toBe(20);
    expect(handle.rectOf("auto-body")?.width).toBe(5);
  });

  test("maxWidth clamps a box that would otherwise grow", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 2 });
    open = handle;
    handle.mount(
      <Box id="clamp-outer" width={20} height={1} direction="row">
        <Box id="clamped" grow={1} maxWidth={6} height={1} background={activeTokens().surface} />
      </Box>,
    );
    await handle.render();
    expect(handle.rectOf("clamped")?.width).toBe(6);
  });

  test("minHeight raises a box above its content height", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 6 });
    open = handle;
    handle.mount(<Box id="tall" minHeight={4} width={4} background={activeTokens().surface} />);
    await handle.render();
    expect(handle.rectOf("tall")?.height).toBe(4);
  });

  test("margin offsets a box inside its parent", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 4 });
    open = handle;
    handle.mount(
      <Box id="margin-outer" width={12} height={4}>
        <Box id="inset" margin={2} width={4} height={1} background={activeTokens().surface} />
      </Box>,
    );
    await handle.render();
    const rect = handle.rectOf("inset");
    expect(rect?.x).toBe(2);
    expect(rect?.y).toBe(2);
  });

  test("position absolute with offsets places a box at exact coordinates", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 5 });
    open = handle;
    handle.mount(
      <Box id="abs-outer" width={12} height={5}>
        <Box
          id="floating"
          position="absolute"
          left={3}
          top={2}
          width={2}
          height={1}
          zIndex={5}
          background={activeTokens().accent}
        />
      </Box>,
    );
    await handle.render();
    const rect = handle.rectOf("floating");
    expect(rect?.x).toBe(3);
    expect(rect?.y).toBe(2);
  });

  test("wrap moves an overflowing child onto the next line", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 4 });
    open = handle;
    handle.mount(
      <Box id="wrap-outer" direction="row" wrap="wrap" width={8} height={4}>
        <Box id="w1" width={6} height={1} background={activeTokens().surface} />
        <Box id="w2" width={6} height={1} background={activeTokens().accent} />
      </Box>,
    );
    await handle.render();
    expect(handle.rectOf("w2")?.y).toBe(1);
  });

  test("shrink lets an oversized child give way", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 2 });
    open = handle;
    handle.mount(
      <Box id="shrink-outer" direction="row" width={8} height={1}>
        <Box id="rigid" width={6} shrink={0} height={1} background={activeTokens().surface} />
        <Box id="giving" width={6} shrink={1} height={1} background={activeTokens().accent} />
      </Box>,
    );
    await handle.render();
    const giving = handle.rectOf("giving")?.width ?? 0;
    expect(giving).toBeLessThan(6);
  });

  test("alignSelf overrides the parent's cross-axis alignment for one child", async () => {
    const handle = await createHeadlessRenderer({ w: 10, h: 4 });
    open = handle;
    handle.mount(
      <Box id="self-outer" direction="row" align="start" width={10} height={4}>
        <Box id="pinned" alignSelf="end" width={2} height={1} background={activeTokens().accent} />
      </Box>,
    );
    await handle.render();
    expect(handle.rectOf("pinned")?.y).toBe(3);
  });

  test("overflow hidden clips a child that exceeds the box", async () => {
    // A child TEXT does not discriminate here: `clip`'s default `direction` is `column`, so the
    // horizontal axis is the CROSS axis, and with no `alignItems` Yoga's `stretch` default
    // stretches the child `Text` to exactly the parent's 4 columns before it ever paints — it can
    // never produce ten consecutive characters regardless of whether `overflow` is wired at all.
    // Give the child an EXPLICIT width instead, so Yoga assigns it `flexShrink: 0` and it really
    // overflows the parent's box, then assert on painted cells (the accent-background run's text
    // length on the clipped row), not on a substring of the joined frame text.
    const handle = await createHeadlessRenderer({ w: 10, h: 3 });
    open = handle;
    handle.mount(
      <Box id="clip" width={4} height={1} overflow="hidden">
        <Box id="wide" width={10} height={1} background={activeTokens().accent} />
      </Box>,
    );
    await handle.render();
    const frame = handle.capture();
    const painted = frame.rows[0]?.filter((run) => run.bg !== "default") ?? [];
    const paintedWidth = painted.reduce((total, run) => total + run.text.length, 0);
    // DERIVED FROM THE CAPTURED FRAME, not assumed: `clip` is 4 columns wide with `overflow:
    // "hidden"` installing a scissor rect at that width, so the 10-column-wide `wide` child paints
    // exactly 4 cells on its row — observed by running this test and reading `paintedWidth`.
    expect(paintedWidth).toBe(4);
  });

  test("export mode renders the identical frame (spec §6.3)", async () => {
    const tree = (
      <Box
        id="det"
        border
        borderStyle="rounded"
        borderColor={activeTokens().border}
        title="T"
        titleAlign="center"
        titleColor={activeTokens().accent}
        width="100%"
        minHeight={3}
        margin={0}
        overflow="hidden"
        background={activeTokens().surface}
      >
        <Text id="det-body">body</Text>
      </Box>
    );
    const preview = await renderOnce(tree, { w: 12, h: 4 });
    hostModeAtom.set("export");
    const exported = await renderOnce(tree, { w: 12, h: 4 });
    expect(exported.rows).toEqual(preview.rows);
  });
});
