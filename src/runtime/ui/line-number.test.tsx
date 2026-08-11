import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { themeTokens } from "../model/tokens";
import { LineNumber } from "./line-number";
import { Row } from "./row";
import { Text } from "./text";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  // The atom is process-wide; a test that switches it must put it back or it leaks into
  // every later test file in the same `bun test` process.
  hostModeAtom.set("preview");
});

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  allRuns(frame).find((run) => run.text.includes(needle));
const lines = (frame: { rows: StyledRun[][] }): string[] =>
  frame.rows.map((row) => row.map((run) => run.text).join(""));

// `@opentui/core@0.4.5` paints these when a colour prop is left unset (plan D3). None of them
// is in this project's palette, so seeing one in a frame means the wrapper stopped resolving
// that colour from the theme.
const VENDOR_HUES = ["#888888", "#ef4444", "#22c55e", "#4d1a1a", "#1a4d1a"];

describe("LineNumber component (design-system §6.1)", () => {
  test("numbers the lines of its one text-like child", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 4 });
    open = handle;
    handle.mount(
      <LineNumber id="gutter">
        <Text id="body">{"alpha\nbeta\ngamma"}</Text>
      </LineNumber>,
    );
    await handle.render();
    const painted = lines(handle.capture());
    expect(painted[0]).toContain("1");
    expect(painted[0]).toContain("alpha");
    expect(painted[1]).toContain("2");
    expect(painted[1]).toContain("beta");
    expect(painted[2]).toContain("3");
    expect(painted[2]).toContain("gamma");
  });

  test("paints the gutter in foregroundFaint on background, never a vendor default", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 3 });
    open = handle;
    handle.mount(
      <LineNumber id="gutter">
        <Text id="body">{"one\ntwo"}</Text>
      </LineNumber>,
    );
    await handle.render();
    const frame = handle.capture();
    const number = findRun(frame, "1");
    expect(number && extractRgb(number.fg)).toBe<string>(
      themeTokens("dark-default").foregroundFaint,
    );
    expect(number && extractRgb(number.bg)).toBe<string>(themeTokens("dark-default").background);
    for (const run of allRuns(frame)) {
      expect(VENDOR_HUES).not.toContain(extractRgb(run.fg) ?? "");
      expect(VENDOR_HUES).not.toContain(extractRgb(run.bg) ?? "");
    }
  });

  test("startAt shifts the first number (plan D8)", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 3 });
    open = handle;
    handle.mount(
      <LineNumber id="gutter" startAt={42}>
        <Text id="body">{"one\ntwo"}</Text>
      </LineNumber>,
    );
    await handle.render();
    const painted = lines(handle.capture());
    expect(painted[0]).toContain("42");
    expect(painted[1]).toContain("43");
  });

  test("an explicit color overrides the theme default", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 2 });
    open = handle;
    handle.mount(
      <LineNumber id="gutter" color="#e6a23c">
        <Text id="body">{"one"}</Text>
      </LineNumber>,
    );
    await handle.render();
    const number = findRun(handle.capture(), "1");
    expect(number && extractRgb(number.fg)).toBe<string>("#e6a23c");
  });

  test("the mandatory id reaches the element for host geometry", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 3 });
    open = handle;
    handle.mount(
      <LineNumber id="gutter">
        <Text id="body">{"one\ntwo"}</Text>
      </LineNumber>,
    );
    await handle.render();
    expect(handle.rectOf("gutter")).not.toBeNull();
  });

  // Plan D6: `LineNumberRenderable.add()` duck-types the FIRST child carrying line info and
  // silently refuses every later child. Recorded as a test so the behaviour is documented
  // rather than discovered inside a live page.
  test("a second child is silently dropped, and the frame still renders", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 4 });
    open = handle;
    handle.mount(
      <LineNumber id="gutter">
        <Text id="first">{"one\ntwo"}</Text>
        <Text id="second">{"dropped"}</Text>
      </LineNumber>,
    );
    await handle.render();
    const painted = lines(handle.capture()).join("\n");
    expect(handle.renderError()).toBeNull();
    expect(painted).toContain("one");
    expect(painted).not.toContain("dropped");
  });

  // Plan D6: with no line-info-providing child there is no target, and `renderSelf` draws
  // nothing at all — an empty frame, not a throw.
  test("a non-text child degrades to an empty frame instead of throwing", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 3 });
    open = handle;
    handle.mount(
      <LineNumber id="gutter">
        <Row id="inner" />
      </LineNumber>,
    );
    await handle.render();
    expect(handle.renderError()).toBeNull();
    expect(lines(handle.capture()).join("").trim()).toBe("");
  });
});

// §6.3: an export snapshot is deterministic by contract. `LineNumber` exposes no scroll and no
// focus, so the property to assert is that the frame depends on nothing but its props.
describe("LineNumber export determinism (§6.3)", () => {
  const mounted = (
    <LineNumber id="gutter" startAt={7}>
      <Text id="body">{"alpha\nbeta\ngamma"}</Text>
    </LineNumber>
  );

  const renderOnce = async (): Promise<string> => {
    const handle = await createHeadlessRenderer({ w: 24, h: 5 });
    handle.mount(mounted);
    await handle.render();
    const captured = JSON.stringify(handle.capture());
    handle.destroy();
    return captured;
  };

  test("two independent renders in export mode produce identical frames", async () => {
    hostModeAtom.set("export");
    const first = await renderOnce();
    const second = await renderOnce();
    expect(first).toBe(second);
  });

  test("the export frame equals the preview frame — no host-mode-dependent state", async () => {
    hostModeAtom.set("preview");
    const preview = await renderOnce();
    hostModeAtom.set("export");
    const exported = await renderOnce();
    expect(exported).toBe(preview);
  });
});
