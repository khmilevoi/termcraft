import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { themeTokens } from "../model/tokens";
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
      <Box id="panel" background="surface" padding={0}>
        <Text id="panel-body">body</Text>
      </Box>,
    );
    await handle.render();
    const frame = handle.capture();
    const body = allRuns(frame).find((run) => run.text.includes("body"));
    expect(body?.text).toContain("body");
    const filled = allRuns(frame).find((run) => run.bg !== "default");
    expect(filled && extractRgb(filled.bg)).toBe<string>(themeTokens("dark-default").surface);
  });

  test("a bordered box paints the token border hue", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 3 });
    open = handle;
    handle.mount(
      <Box id="bordered" border borderColor="accent">
        <Text id="bordered-x">x</Text>
      </Box>,
    );
    await handle.render();
    const border = allRuns(handle.capture()).find(
      (run) =>
        typeof run.fg === "object" &&
        run.fg !== null &&
        "rgb" in run.fg &&
        run.fg.rgb === themeTokens("dark-default").accent &&
        run.text.trim() !== "x",
    );
    expect(border).toBeDefined();
  });
});
