import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { activeTokens } from "../model/tokens";
import { Box } from "./primitive";
import { Text } from "./text";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();

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
