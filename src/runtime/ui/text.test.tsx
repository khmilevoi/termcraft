import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { DARK_DEFAULT, DEFAULT_THEME_ID, activeTokens, seedThemeCapability } from "../model/tokens";
import { Text } from "./text";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  seedThemeCapability({ themeId: DEFAULT_THEME_ID, tokens: DARK_DEFAULT });
});

const lineRuns = (frame: { rows: StyledRun[][] }, row: number): StyledRun[] =>
  frame.rows[row] ?? [];
const lineText = (frame: { rows: StyledRun[][] }, row: number) =>
  lineRuns(frame, row)
    .map((run) => run.text)
    .join("");

describe("Text component (design-system §3.2)", () => {
  test("renders its children as themed text", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 1 });
    open = handle;
    handle.mount(<Text id="greeting">hello</Text>);
    await handle.render();
    expect(lineText(handle.capture(), 0)).toContain("hello");
  });

  test("an explicit Color renders as that hue on the styled run", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 1 });
    open = handle;
    handle.mount(
      <Text id="danger" color={activeTokens().danger}>
        x
      </Text>,
    );
    await handle.render();
    const styled = lineRuns(handle.capture(), 0).find((run) => run.text.includes("x"));
    expect(styled && extractRgb(styled.fg)).toBe<string>(activeTokens().danger);
  });

  test("a token NAME is no longer a colour (spec §4.5)", () => {
    // @ts-expect-error — `Color` is `#rrggbb`; the checked path is `useTokens().danger`.
    const rejected = <Text id="rejected" color="danger" />;
    expect(rejected).toBeDefined();
  });

  test("with no color it falls back to the active theme's foreground", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 1 });
    open = handle;
    handle.mount(<Text id="plain">y</Text>);
    await handle.render();
    const styled = lineRuns(handle.capture(), 0).find((run) => run.text.includes("y"));
    expect(styled && extractRgb(styled.fg)).toBe<string>(activeTokens().foreground);
  });

  test("with no color it reads the ACTIVE theme, not the compiled seed (spec §4.6)", async () => {
    // #4cc9f0 is a synthetic test fixture, not a design colour — same value already used by
    // `tokens.reactivity.test.tsx`'s `MIDNIGHT` theme.
    seedThemeCapability({
      themeId: "midnight",
      tokens: { ...DARK_DEFAULT, foreground: "#4cc9f0" },
    });
    const handle = await createHeadlessRenderer({ w: 8, h: 1 });
    open = handle;
    handle.mount(<Text id="seeded">z</Text>);
    await handle.render();
    const styled = lineRuns(handle.capture(), 0).find((run) => run.text.includes("z"));
    const fg = styled && extractRgb(styled.fg);
    expect(fg).toBe<string>("#4cc9f0");
    expect(fg).not.toBe(DARK_DEFAULT.foreground);
  });

  test("bold + dim set the protocol attribute mask (BOLD=1, DIM=2)", async () => {
    const handle = await createHeadlessRenderer({ w: 6, h: 1 });
    open = handle;
    handle.mount(
      <Text id="b" bold dim>
        hi
      </Text>,
    );
    await handle.render();
    const styled = lineRuns(handle.capture(), 0).find((run) => run.text.includes("h"));
    expect((styled?.attrs ?? 0) & 0b11).toBe(0b11);
  });
});
