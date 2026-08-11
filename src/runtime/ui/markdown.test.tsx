import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { DARK_DEFAULT, DEFAULT_THEME_ID, activeTokens, seedThemeCapability } from "../model/tokens";
import { Markdown } from "./markdown";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  seedThemeCapability({ themeId: DEFAULT_THEME_ID, tokens: DARK_DEFAULT });
});

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const allText = (frame: { rows: StyledRun[][] }) =>
  frame.rows.map((row) => row.map((run) => run.text).join("")).join("\n");
const hueOf = (frame: { rows: StyledRun[][] }, needle: string) =>
  allRuns(frame)
    .filter((run) => run.text.includes(needle))
    .map((run) => extractRgb(run.fg));

const DOCUMENT = ["# Heading", "", "Body text here.", "", "```ts", "const a = 1", "```", ""].join(
  "\n",
);

describe("Markdown component (design-system §6.1)", () => {
  test("renders the heading, the prose and the fenced block", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 12 });
    open = handle;
    handle.mount(<Markdown id="doc" content={DOCUMENT} />);
    await handle.settle();
    const text = allText(handle.capture());
    expect(text).toContain("Heading");
    expect(text).toContain("Body text here.");
    expect(text).toContain("const a = 1");
  });

  test("a heading takes the design's title treatment: accent, bold (plan P8 D1)", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 12 });
    open = handle;
    handle.mount(<Markdown id="doc" content={DOCUMENT} />);
    await handle.settle();
    const frame = handle.capture();
    const heading = allRuns(frame).find((run) => run.text.includes("Heading"));
    expect(heading && extractRgb(heading.fg)).toBe<string>(activeTokens().accent);
    // BOLD=1 in the protocol attribute mask.
    expect((heading?.attrs ?? 0) & 0b1).toBe(0b1);
  });

  test("a fenced ts block is highlighted per its own language", async () => {
    const handle = await createHeadlessRenderer({ w: 40, h: 12 });
    open = handle;
    handle.mount(<Markdown id="doc" content={DOCUMENT} />);
    await handle.settle();
    // `const` inside the fence resolves through the typescript grammar, not the markdown one.
    expect(hueOf(handle.capture(), "const")).toContain(activeTokens().accent);
  });

  test("A SILENTLY FAILED WORKER MUST FAIL THIS TEST, not degrade quietly", async () => {
    // MUST filter empty/whitespace runs before collecting hues (review finding, 2026-08-11,
    // mirrors the same fix in `code.test.tsx`): the headless renderer's UNWRITTEN filler cells
    // carry `fg = #ffffff`, distinct from the theme's own `foreground` (#d7d0c2). With `h: 12`
    // against a short document, the captured frame has filler rows below the content, so an
    // unfiltered `hues.size > 1` was satisfied by `{foreground, #ffffff filler}` alone — true on
    // a COMPLETELY UNHIGHLIGHTED frame.
    const handle = await createHeadlessRenderer({ w: 40, h: 12 });
    open = handle;
    handle.mount(<Markdown id="doc" content={DOCUMENT} />);
    await handle.settle();
    const hues = new Set(
      allRuns(handle.capture())
        .filter((run) => run.text.trim().length > 0)
        .map((run) => extractRgb(run.fg)),
    );
    expect(hues.size).toBeGreaterThan(1);
    // The load-bearing assertion: a flat, unhighlighted frame of non-empty runs is exactly ONE
    // hue (`foreground`), so this alone fails on a silently-failed worker even if the size check
    // above were ever satisfied by accident.
    expect([...hues]).toContain(activeTokens().accent);
  });

  test("the render follows the ACTIVE theme, not the compiled seed", async () => {
    // #4cc9f0 is a synthetic test fixture, not a design colour.
    seedThemeCapability({ themeId: "midnight", tokens: { ...DARK_DEFAULT, accent: "#4cc9f0" } });
    const handle = await createHeadlessRenderer({ w: 40, h: 12 });
    open = handle;
    handle.mount(<Markdown id="doc" content={DOCUMENT} />);
    await handle.settle();
    const heading = allRuns(handle.capture()).find((run) => run.text.includes("Heading"));
    expect(heading && extractRgb(heading.fg)).toBe<string>("#4cc9f0");
  });

  test("Markdown takes no filetype, and no renderer internals", () => {
    // @ts-expect-error — language is per fenced block inside the content (design spec §6.1).
    const withLanguage = <Markdown id="a" content="" language="typescript" />;
    // @ts-expect-error — termcraft builds the syntax style from the theme.
    const withStyle = <Markdown id="b" content="" syntaxStyle={undefined} />;
    // @ts-expect-error — `treeSitterClient` is never exposed.
    const withClient = <Markdown id="c" content="" treeSitterClient={undefined} />;
    // @ts-expect-error — `id` is mandatory on every wrapper.
    const withoutId = <Markdown content="" />;
    expect([withLanguage, withStyle, withClient, withoutId]).toHaveLength(4);
  });
});

describe("Markdown export determinism (design-system §6.3)", () => {
  test("two settled renders of the same document produce byte-identical styled rows", async () => {
    const first = await createHeadlessRenderer({ w: 40, h: 12 });
    first.mount(<Markdown id="doc" content={DOCUMENT} />);
    await first.settle();
    const a = first.capture();
    first.destroy();

    const second = await createHeadlessRenderer({ w: 40, h: 12 });
    second.mount(<Markdown id="doc" content={DOCUMENT} />);
    await second.settle();
    const b = second.capture();
    second.destroy();

    expect(b).toEqual(a);
    // Both must be the HIGHLIGHTED frame: `Markdown` exposes no completion signal of its own,
    // so a settle that returned early would produce two identical plain frames that an
    // equality-only assertion would happily accept.
    expect(allRuns(a).map((run) => extractRgb(run.fg))).toContain(activeTokens().accent);
  });
});
