import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { activeTokens } from "../model/tokens";
import { Span } from "./inline";
import { Text } from "./text";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
});

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const frameText = (frame: { rows: StyledRun[][] }): string =>
  frame.rows.map((row) => row.map((run) => run.text).join("")).join("\n");

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

describe("Span inline text (spec §6.1)", () => {
  test("renders its children inside a Text", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Span id="part">hello</Span>
      </Text>,
    );
    await handle.render();
    expect(frameText(handle.capture())).toContain("hello");
  });

  test("an explicit Color renders as that hue on the styled run", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Span id="warned" color={activeTokens().danger}>
          bad
        </Span>
      </Text>,
    );
    await handle.render();
    const styled = allRuns(handle.capture()).find((run) => run.text.includes("bad"));
    expect(styled && extractRgb(styled.fg)).toBe<string>(activeTokens().danger);
  });

  test("a token NAME is no longer a colour (spec §4.5)", () => {
    // @ts-expect-error — `Color` is `#rrggbb`; the checked path is `useTokens().danger`.
    const rejected = <Span id="rejected" color="danger" />;
    expect(rejected).toBeDefined();
  });

  test("sibling spans compose into one line", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Span id="a">ab</Span>
        <Span id="b">cd</Span>
      </Text>,
    );
    await handle.render();
    expect(frameText(handle.capture())).toContain("abcd");
  });

  test("export mode renders the identical frame (spec §6.3)", async () => {
    const tree = (
      <Text id="line">
        <Span id="part" color={activeTokens().accent}>
          hello
        </Span>
      </Text>
    );
    const preview = await renderOnce(tree, { w: 16, h: 1 });
    hostModeAtom.set("export");
    const exported = await renderOnce(tree, { w: 16, h: 1 });
    expect(exported.rows).toEqual(preview.rows);
  });
});

describe("inline ids and host geometry — the recorded divergence", () => {
  test("an inline id is carried but is NOT resolvable by rectOf", async () => {
    // WHY THIS IS ASSERTED RATHER THAN LAMENTED: `TextNodeRenderable extends BaseRenderable`
    // (@opentui/core/renderables/TextNode.d.ts:17) — no Yoga node, no screen rect — and
    // `findDescendantById` is declared on `Renderable` (Renderable.d.ts:187), walking only
    // renderable children. So the shell's geometry queries cannot address an inline element.
    // The id is still mandatory (plan D3); this test is what makes the limit a fact instead of
    // a surprise, and it is what will FAIL — loudly, and in the good direction — on the day
    // OpenTUI or the host learns to walk text nodes.
    const handle = await createHeadlessRenderer({ w: 16, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Span id="unreachable">x</Span>
      </Text>,
    );
    await handle.render();
    expect(handle.rectOf("line")).not.toBeNull();
    expect(handle.rectOf("unreachable")).toBeNull();
  });
});
