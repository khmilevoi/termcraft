import { afterEach, describe, expect, test } from "bun:test";

import { TextAttributes } from "@opentui/core";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { activeTokens } from "../model/tokens";
import { Bold, Italic, LineBreak, Link, Span, Underline } from "./inline";
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

describe("Bold / Italic / Underline inline wrappers (spec §6.1)", () => {
  test("Bold sets the bold attribute on its run", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Bold id="strong">hey</Bold>
      </Text>,
    );
    await handle.render();
    const styled = allRuns(handle.capture()).find((run) => run.text.includes("hey"));
    // The mask is the protocol's own (src/host/protocol/types.ts:81 — 1 bold, 2 dim, 4 italic,
    // 8 underline); `TextAttributes` is OpenTUI's source for the same bits.
    expect((styled?.attrs ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
  });

  test("Italic sets the italic attribute on its run", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Italic id="slant">hey</Italic>
      </Text>,
    );
    await handle.render();
    const styled = allRuns(handle.capture()).find((run) => run.text.includes("hey"));
    expect((styled?.attrs ?? 0) & TextAttributes.ITALIC).toBe(TextAttributes.ITALIC);
  });

  test("Underline sets the underline attribute on its run", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Underline id="rule">hey</Underline>
      </Text>,
    );
    await handle.render();
    const styled = allRuns(handle.capture()).find((run) => run.text.includes("hey"));
    expect((styled?.attrs ?? 0) & TextAttributes.UNDERLINE).toBe(TextAttributes.UNDERLINE);
  });

  test("they nest, and the attributes combine", async () => {
    const handle = await createHeadlessRenderer({ w: 16, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Bold id="outer">
          <Italic id="inner">hey</Italic>
        </Bold>
      </Text>,
    );
    await handle.render();
    const styled = allRuns(handle.capture()).find((run) => run.text.includes("hey"));
    const mask = TextAttributes.BOLD | TextAttributes.ITALIC;
    expect((styled?.attrs ?? 0) & mask).toBe(mask);
  });

  test("each takes a Color, and a token NAME does not compile (spec §4.5)", () => {
    // @ts-expect-error — `Color` is `#rrggbb`; the checked path is `useTokens().accent`.
    const rejected = <Bold id="rejected-bold" color="accent" />;
    expect(rejected).toBeDefined();
  });

  test("export mode renders the identical frame (spec §6.3)", async () => {
    const tree = (
      <Text id="line">
        <Bold id="b" color={activeTokens().accent}>
          a
        </Bold>
        <Italic id="i">b</Italic>
        <Underline id="u">c</Underline>
      </Text>
    );
    const preview = await renderOnce(tree, { w: 16, h: 1 });
    hostModeAtom.set("export");
    const exported = await renderOnce(tree, { w: 16, h: 1 });
    expect(exported.rows).toEqual(preview.rows);
  });
});

describe("Link inline wrapper (spec §6.1)", () => {
  test("renders its label text", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Link id="docs" href="https://example.invalid/docs">
          docs
        </Link>
      </Text>,
    );
    await handle.render();
    expect(frameText(handle.capture())).toContain("docs");
  });

  test("takes a Color for the label hue", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 1 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Link id="docs" href="https://example.invalid/docs" color={activeTokens().accent}>
          docs
        </Link>
      </Text>,
    );
    await handle.render();
    const styled = allRuns(handle.capture()).find((run) => run.text.includes("docs"));
    expect(styled && extractRgb(styled.fg)).toBe<string>(activeTokens().accent);
  });

  test("href is required — omitting it does not compile", () => {
    // @ts-expect-error — a link with no target is not a link.
    const rejected = <Link id="rejected-link">docs</Link>;
    expect(rejected).toBeDefined();
  });

  test("export mode renders the identical frame (spec §6.3)", async () => {
    const tree = (
      <Text id="line">
        <Link id="docs" href="https://example.invalid/docs" color={activeTokens().accent}>
          docs
        </Link>
      </Text>
    );
    const preview = await renderOnce(tree, { w: 20, h: 1 });
    hostModeAtom.set("export");
    const exported = await renderOnce(tree, { w: 20, h: 1 });
    expect(exported.rows).toEqual(preview.rows);
  });
});

describe("LineBreak inline wrapper (spec §6.1)", () => {
  test("splits one Text across two rows", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 3 });
    open = handle;
    handle.mount(
      <Text id="line">
        <Span id="first">one</Span>
        <LineBreak id="brk" />
        <Span id="second">two</Span>
      </Text>,
    );
    await handle.render();
    const rows = handle.capture().rows.map((row) => row.map((run) => run.text).join(""));
    expect(rows[0]).toContain("one");
    expect(rows[1]).toContain("two");
  });

  test("id is mandatory — omitting it does not compile (plan decision D3)", () => {
    // @ts-expect-error — spec §6 makes `id` mandatory on EVERY wrapper, `br` included: `id` is
    // the only prop the intrinsic has (`LineBreakProps = Pick<SpanProps, "id">`), so no exception
    // is carved here.
    const rejected = <LineBreak />;
    expect(rejected).toBeDefined();
  });

  test("export mode renders the identical frame (spec §6.3)", async () => {
    const tree = (
      <Text id="line">
        <Span id="first">one</Span>
        <LineBreak id="brk" />
        <Span id="second">two</Span>
      </Text>
    );
    const preview = await renderOnce(tree, { w: 12, h: 3 });
    hostModeAtom.set("export");
    const exported = await renderOnce(tree, { w: 12, h: 3 });
    expect(exported.rows).toEqual(preview.rows);
  });
});
