import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { hostModeAtom } from "../model/capabilities";
import { themeTokens } from "../model/tokens";
import { ScrollBox } from "./scroll-box";
import { Text } from "./text";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  hostModeAtom.set("preview");
});

const T = themeTokens("dark-default");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat();
const allText = (frame: { rows: StyledRun[][] }) =>
  allRuns(frame)
    .map((run) => run.text)
    .join("");

/**
 * Six rows in a three-row viewport: the top half and the bottom half are disjoint.
 *
 * DEVIATION FROM THE BRIEF, STATED RATHER THAN SILENTLY FIXED: the brief's verbatim listing put
 * `key={label}` directly on `<Text>`, but `Text` is a composed function component, and this
 * repo's no-`@types/react` environment gives `key` no type on composed components — only on
 * intrinsics (the same convention already recorded in `ui/tabs.tsx`, `ui/table.tsx`,
 * `ui/list.tsx`: "key lives on intrinsics", "function components take no key"). `key={label}` on
 * `<Text>` is a TS2322 (`Property 'key' does not exist on type 'IntrinsicAttributes &
 * TextProps'`). Matching `List`'s own pattern (`ui/list.tsx:41-42`), the key rides an intrinsic
 * `<box>` wrapper around each `Text` instead.
 */
const rows = () =>
  ["r0", "r1", "r2", "r3", "r4", "r5"].map((label) => (
    <box key={label}>
      <Text id={`row-${label}`}>{label}</Text>
    </box>
  ));

/** Two paints plus a real-time yield: sticky scroll is applied from a size-change callback. */
const settle = async (handle: RenderHandle) => {
  await handle.render();
  await tick();
  await handle.render();
};

describe("ScrollBox component (spec §6.1)", () => {
  test("renders the top of its content in a viewport shorter than the content", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 3 });
    open = handle;
    handle.mount(
      <ScrollBox id="log" height={3} width={12}>
        {rows()}
      </ScrollBox>,
    );
    await settle(handle);
    const text = allText(handle.capture());
    expect(text).toContain("r0");
    expect(text).not.toContain("r5");
  });

  test("`follow` pins the viewport to the newest content (preview)", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 3 });
    open = handle;
    handle.mount(
      <ScrollBox id="log" height={3} width={12} follow>
        {rows()}
      </ScrollBox>,
    );
    await settle(handle);
    const text = allText(handle.capture());
    expect(text).toContain("r5");
    expect(text).not.toContain("r0");
  });

  test("a focused ScrollBox draws the design's focus hue on its frame (preview)", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 5 });
    open = handle;
    handle.mount(
      <ScrollBox id="log" height={5} width={12} border focused>
        {rows()}
      </ScrollBox>,
    );
    await settle(handle);
    const frame = handle.capture();
    const border = allRuns(frame).find((run) => run.text.includes("─"));
    expect(border && extractRgb(border.fg)).toBe<string>(T.accentHi);
  });
});

// §6.3: "scroll offset 0" is literal here. `follow` is the one prop that moves the offset off
// zero, so it is exactly what the export contract has to override.
describe("ScrollBox export determinism (spec §6.3)", () => {
  // The "nothing is focused" test below exercises the forced `blur()` half of D3's guarantee
  // only (`focused={false}` under export). The second half — the focused border collapsing onto
  // the unfocused one in `scroll-box.tsx` — is unasserted defence-in-depth: because the widget is
  // blurred, `focusedBorderColor` is never read, so that test would stay green even if the
  // collapse were deleted. Do not remove the collapse on the strength of it passing.
  test("under export the viewport is pinned to offset 0, even with `follow`", async () => {
    hostModeAtom.set("export");
    const handle = await createHeadlessRenderer({ w: 12, h: 3 });
    open = handle;
    handle.mount(
      <ScrollBox id="log" height={3} width={12} follow>
        {rows()}
      </ScrollBox>,
    );
    await settle(handle);
    const text = allText(handle.capture());
    expect(text).toContain("r0");
    expect(text).not.toContain("r5");
  });

  test("under export nothing is focused: the frame keeps the border token", async () => {
    hostModeAtom.set("export");
    const handle = await createHeadlessRenderer({ w: 12, h: 5 });
    open = handle;
    handle.mount(
      <ScrollBox id="log" height={5} width={12} border focused>
        {rows()}
      </ScrollBox>,
    );
    await settle(handle);
    const border = allRuns(handle.capture()).find((run) => run.text.includes("─"));
    expect(border && extractRgb(border.fg)).toBe<string>(T.border);
    expect(border && extractRgb(border.fg)).not.toBe<string>(T.accentHi);
  });
});
